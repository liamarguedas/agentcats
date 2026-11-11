import { randomUUID } from 'node:crypto';

import type { ApprovalDecision, Cat, CatStatus, ToolKind, Usage } from '@agentcats/protocol';
import type {
  Adapter,
  AgentEvent,
  Session,
  SpawnOptions,
  StopReason,
} from '@agentcats/protocol/adapter';

import { ApiError } from './errors.js';
import type { EventLog } from './event-log.js';
import type { Logger } from './logger.js';
import type { PidRegistry } from './pid-registry.js';

export interface TurnOutcome {
  readonly stopReason: StopReason;
  /** The agent's answer text in this turn (last 4000 characters). */
  readonly text: string;
  /** Last error the agent reported in this turn. */
  readonly lastError: string | null;
  /** The agent reported a fatal error: the session is ending, treat it as a crash. */
  readonly fatal: boolean;
  readonly taskId: string | null;
}

export type SessionEndReason = 'exited' | 'killed' | 'crashed';

/** What a {@link CatAgent} tells the manager. Called synchronously from its event pump. */
export interface CatAgentHooks {
  turnEnded(agent: CatAgent, outcome: TurnOutcome): void;
  sessionEnded(
    agent: CatAgent,
    info: {
      reason: SessionEndReason;
      exitCode: number | null;
      taskId: string | null;
      expected: boolean;
    },
  ): void;
  /** Any agent event: used for the stuck-worker watchdog. */
  activity(agent: CatAgent): void;
  /** The cat's cumulative usage changed: used for budgets. */
  usage(agent: CatAgent): void;
}

export interface CatAgentDeps {
  readonly log: EventLog;
  readonly adapter: Adapter;
  readonly pids: PidRegistry;
  readonly logger: Logger;
  readonly approvalTimeoutMs: number;
  readonly hooks: CatAgentHooks;
}

interface PendingApproval {
  readonly requestId: string;
  readonly session: Session;
  readonly timer: NodeJS.Timeout;
}

const SUMMARY_LIMIT = 4_000;
const short = (text: string) => text.slice(0, 500);
const ZERO_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
  costSource: 'unknown',
};

/**
 * One cat and its current agent session. Maps normalized agent events to
 * protocol events, handles approvals, and reports turn and session outcomes
 * to the manager, which owns all task decisions.
 *
 * A cat's usage is cumulative across its sessions: each session's totals are
 * added to what the cat had spent before it started.
 */
export class CatAgent {
  #session: Session | null = null;
  #spawning: Promise<Session> | null = null;
  #pump: Promise<void> = Promise.resolve();
  #taskId: string | null = null;
  #resumeId: string | null = null;
  #inTurn = false;
  #turnText = '';
  #turnError: string | null = null;
  #turnFatal = false;
  #turnEndWaiters: (() => void)[] = [];
  #expectedEnd = false;
  #usageBase: Usage = ZERO_USAGE;
  readonly #tools = new Map<string, { toolName: string; kind: ToolKind; inputSummary: string }>();
  readonly #approvals = new Map<string, PendingApproval>();

  constructor(
    private readonly deps: CatAgentDeps,
    readonly catId: string,
  ) {}

  get cat(): Cat {
    const cat = this.deps.log.board.cats[this.catId];
    if (!cat) throw new Error(`Cat ${this.catId} is not on the board`);
    return cat;
  }

  /** A turn is running, or a session is starting. */
  get busy(): boolean {
    return this.#inTurn || this.#spawning !== null;
  }

  get hasSession(): boolean {
    return this.#session !== null;
  }

  /** Task the current session works on, if any. */
  get taskId(): string | null {
    return this.#taskId;
  }

  /** Agent's handle for resuming the current session. */
  get resumeId(): string | null {
    return this.#resumeId;
  }

  hasApproval(approvalId: string): boolean {
    return this.#approvals.has(approvalId);
  }

  /**
   * Start a new session, ending any current one first.
   *
   * @throws AdapterError if the agent cannot start.
   */
  async startSession(options: Omit<SpawnOptions, 'catId'>, taskId: string | null): Promise<void> {
    await this.endSession();
    this.#taskId = taskId;
    this.#usageBase = this.deps.log.board.usage[this.catId] ?? ZERO_USAGE;
    this.#spawning = this.deps.adapter.spawn({ ...options, catId: this.catId });
    try {
      const session = await this.#spawning;
      if (session.pid !== null) {
        // The guardian already ties the agent to the daemon; the PID file is
        // the backup. Failing to write it is worth a warning, not a failed task.
        await this.deps.pids.add(session.pid, this.catId).catch((error: unknown) => {
          this.deps.logger.warn(
            `Could not record agent pid ${String(session.pid)}: ${String(error)}`,
          );
        });
      }
      this.#session = session;
      this.#expectedEnd = false;
      this.#pump = this.#consume(session);
    } catch (error) {
      this.#taskId = null;
      throw error;
    } finally {
      this.#spawning = null;
    }
  }

  /**
   * Start a turn.
   *
   * @throws ApiError `conflict` if a turn is running or there is no session.
   */
  async send(text: string): Promise<void> {
    if (this.busy) throw new ApiError('conflict', `${this.cat.name} is busy`);
    const session = this.#session;
    if (!session) throw new ApiError('conflict', `${this.cat.name} has no running session`);
    this.#inTurn = true;
    this.#turnText = '';
    this.#turnError = null;
    this.#turnFatal = false;
    try {
      await session.send(text);
    } catch (error) {
      this.#inTurn = false;
      throw error;
    }
  }

  /** Stop the current turn and wait until its end is processed; the session stays. */
  async interrupt(): Promise<void> {
    if (!this.#inTurn || !this.#session) return;
    const ended = new Promise<void>((resolve) => this.#turnEndWaiters.push(resolve));
    await this.#session.interrupt();
    await ended;
  }

  #turnFinished(): void {
    this.#inTurn = false;
    for (const resolve of this.#turnEndWaiters.splice(0)) resolve();
  }

  /**
   * End the session (if any) and wait until its events are processed. The
   * manager is told with `expected: true`.
   */
  async endSession(): Promise<void> {
    const session = this.#session ?? (await this.#spawning?.catch(() => null)) ?? null;
    if (!session) return;
    this.#expectedEnd = true;
    await session.kill();
    await this.#pump;
  }

  /**
   * Answer one of this cat's pending approvals.
   *
   * @throws ApiError `not_found` if it has no such approval.
   */
  async resolveApproval(
    approvalId: string,
    decision: ApprovalDecision,
    resolvedBy: 'user' | 'timeout',
  ): Promise<void> {
    const pending = this.#approvals.get(approvalId);
    if (!pending) throw new ApiError('not_found', `No pending approval ${approvalId}`);
    this.#approvals.delete(approvalId);
    clearTimeout(pending.timer);
    this.deps.log.append({
      type: 'approval.resolved',
      catId: this.catId,
      payload: { approvalId, decision, resolvedBy },
    });
    if (this.#approvals.size === 0 && this.cat.status === 'waiting_approval') {
      this.setStatus(decision === 'allow' ? 'working' : 'thinking');
    }
    try {
      await pending.session.approve(pending.requestId, decision);
    } catch (error) {
      this.deps.logger.warn(`Approval ${approvalId} could not be delivered: ${String(error)}`);
    }
  }

  setStatus(status: CatStatus, reason: string | null = null): void {
    const cat = this.deps.log.board.cats[this.catId];
    if (cat?.status === status && cat.statusReason === reason) return;
    this.deps.log.append({
      type: 'cat.status_changed',
      catId: this.catId,
      payload: { status, reason: reason === null ? null : short(reason) },
    });
  }

  async #consume(session: Session): Promise<void> {
    try {
      for await (const event of session.events()) this.#handle(session, event);
    } catch (error) {
      this.deps.logger.error(`Agent event stream failed: ${String(error)}`);
      this.#onSessionEnded(session, 'crashed', null);
    }
  }

  #scope(): { catId: string; taskId?: string } {
    return { catId: this.catId, ...(this.#taskId !== null && { taskId: this.#taskId }) };
  }

  #handle(session: Session, event: AgentEvent): void {
    const { log, hooks } = this.deps;
    const scope = this.#scope();
    if (event.type !== 'session.ended') hooks.activity(this);

    switch (event.type) {
      case 'session.started':
        this.#resumeId = event.resumeId;
        if (this.cat.billing !== event.billing) {
          log.append({
            type: 'cat.updated',
            catId: this.catId,
            payload: { billing: event.billing },
          });
        }
        this.deps.logger.info(
          `${this.cat.name}: session started (${this.deps.adapter.id} ${event.agentVersion ?? 'unknown version'})`,
        );
        return;

      case 'turn.started':
        this.#inTurn = true;
        this.setStatus('thinking');
        return;

      case 'message.chunk':
        log.append({
          type: 'message.agent',
          ...scope,
          payload: { messageId: event.messageId, channel: event.channel, text: event.text },
        });
        if (event.channel === 'text') {
          this.#turnText = (this.#turnText + event.text).slice(-SUMMARY_LIMIT);
        }
        return;

      case 'tool.started': {
        const info = {
          toolName: event.toolName,
          kind: event.kind,
          inputSummary: event.inputSummary,
        };
        this.#tools.set(event.toolCallId, info);
        log.append({
          type: 'tool.called',
          ...scope,
          payload: { toolCallId: event.toolCallId, ...info, status: 'running' },
        });
        this.setStatus('working', `${event.toolName} ${event.inputSummary}`);
        return;
      }

      case 'tool.finished': {
        const info = this.#tools.get(event.toolCallId) ?? {
          toolName: 'unknown',
          kind: 'other' as const,
          inputSummary: '',
        };
        this.#tools.delete(event.toolCallId);
        log.append({
          type: 'tool.called',
          ...scope,
          payload: { toolCallId: event.toolCallId, ...info, status: event.status },
        });
        if (this.cat.status === 'working') this.setStatus('thinking');
        return;
      }

      case 'approval.requested': {
        const approvalId = randomUUID();
        const timer = setTimeout(() => {
          void this.resolveApproval(approvalId, 'deny', 'timeout').catch(() => undefined);
        }, this.deps.approvalTimeoutMs);
        timer.unref();
        this.#approvals.set(approvalId, { requestId: event.requestId, session, timer });
        log.append({
          type: 'approval.requested',
          ...scope,
          payload: {
            approvalId,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            kind: event.kind,
            inputSummary: event.inputSummary,
          },
        });
        this.setStatus('waiting_approval', `${event.toolName} ${event.inputSummary}`);
        return;
      }

      case 'usage':
        log.append({
          type: 'usage.updated',
          catId: this.catId,
          payload: addUsage(this.#usageBase, event.usage),
        });
        hooks.usage(this);
        return;

      case 'turn.ended': {
        this.#turnFinished();
        this.#dropApprovals();
        const outcome: TurnOutcome = {
          stopReason: event.stopReason,
          text: this.#turnText,
          lastError: this.#turnError,
          fatal: this.#turnFatal,
          taskId: this.#taskId,
        };
        if (event.stopReason === 'end_turn') this.setStatus('done');
        else if (event.stopReason === 'cancelled') this.setStatus('idle', 'interrupted');
        else this.setStatus('error', this.#turnError ?? `Turn ended: ${event.stopReason}`);
        hooks.turnEnded(this, outcome);
        return;
      }

      case 'error':
        this.#turnError = event.message;
        if (event.fatal) this.#turnFatal = true;
        log.append({
          type: 'daemon.error',
          ...scope,
          payload: { code: 'agent_error', message: short(event.message) },
        });
        if (event.fatal) this.setStatus('error', event.message);
        return;

      case 'session.ended':
        this.#onSessionEnded(session, event.reason, event.exitCode);
        return;
    }
  }

  #onSessionEnded(session: Session, reason: SessionEndReason, exitCode: number | null): void {
    if (this.#session !== session) return;
    const taskId = this.#taskId;
    const expected = this.#expectedEnd;
    this.#session = null;
    this.#taskId = null;
    this.#turnFinished();
    this.#dropApprovals();
    this.#tools.clear();
    if (session.pid !== null) void this.deps.pids.remove(session.pid);
    if (reason === 'crashed' && !expected) {
      this.setStatus(
        'error',
        `Agent crashed${exitCode === null ? '' : ` (exit ${String(exitCode)})`}`,
      );
    } else if (this.cat.status !== 'error' || expected) {
      this.setStatus('idle');
    }
    this.deps.hooks.sessionEnded(this, { reason, exitCode, taskId, expected });
  }

  /** Pending approvals die with their turn or session. */
  #dropApprovals(): void {
    for (const [approvalId, pending] of this.#approvals) {
      clearTimeout(pending.timer);
      this.deps.log.append({
        type: 'approval.resolved',
        catId: this.catId,
        payload: { approvalId, decision: 'deny', resolvedBy: 'session_ended' },
      });
    }
    this.#approvals.clear();
  }
}

/** Session totals on top of what the cat spent before the session. */
function addUsage(base: Usage, session: Usage): Usage {
  const cost =
    base.costUsd === null || session.costUsd === null ? null : base.costUsd + session.costUsd;
  return {
    inputTokens: base.inputTokens + session.inputTokens,
    outputTokens: base.outputTokens + session.outputTokens,
    cacheReadTokens: base.cacheReadTokens + session.cacheReadTokens,
    cacheWriteTokens: base.cacheWriteTokens + session.cacheWriteTokens,
    costUsd: cost,
    costSource: session.costSource,
  };
}
