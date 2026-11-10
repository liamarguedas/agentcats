import { randomUUID } from 'node:crypto';

import type {
  AgentcatsConfig,
  ApprovalDecision,
  CatStatus,
  Task,
  ToolKind,
} from '@agentcats/protocol';
import type { Adapter, AgentEvent, Session, StopReason } from '@agentcats/protocol/adapter';

import { ApiError } from './errors.js';
import type { EventLog } from './event-log.js';
import type { Logger } from './logger.js';
import type { PidRegistry } from './pid-registry.js';

export interface CatRunnerOptions {
  readonly log: EventLog;
  readonly adapter: Adapter;
  readonly config: AgentcatsConfig;
  readonly projectPath: string;
  readonly pids: PidRegistry;
  readonly logger: Logger;
  readonly name: string;
}

interface Turn {
  readonly taskId: string | null;
  /** Agent answer text so far, used as the task summary. */
  text: string;
}

interface PendingApproval {
  readonly requestId: string;
  readonly session: Session;
  readonly timer: NodeJS.Timeout;
}

const SUMMARY_LIMIT = 4_000;
const short = (text: string) => text.slice(0, 500);

/**
 * Runs one cat: spawns its agent session on demand, turns normalized agent
 * events into protocol events, and handles tasks, chat, approvals and kill.
 *
 * The cat exists from daemon start; its agent session starts with the first
 * task, so nothing is spent until the user asks for something.
 */
export class CatRunner {
  readonly catId = randomUUID();

  #session: Session | null = null;
  #spawning: Promise<Session> | null = null;
  #pump: Promise<void> = Promise.resolve();
  #turn: Turn | null = null;
  #killRequested = false;
  readonly #tools = new Map<string, { toolName: string; kind: ToolKind; inputSummary: string }>();
  readonly #approvals = new Map<string, PendingApproval>();

  constructor(private readonly options: CatRunnerOptions) {
    options.log.append({
      type: 'cat.created',
      catId: this.catId,
      payload: {
        name: options.name,
        adapter: options.adapter.id,
        model: options.config.defaultModel,
        permissionMode: options.config.permissionMode,
      },
    });
  }

  /**
   * Create a task assigned to this cat and start working on it.
   *
   * @throws ApiError `conflict` if the cat is already working.
   */
  async createTask(title: string, description: string): Promise<Task> {
    this.#assertIdle();
    const taskId = randomUUID();
    this.options.log.append({
      type: 'task.created',
      taskId,
      payload: { title, description, status: 'queued', assigneeCatId: this.catId },
    });
    await this.#startTurn(description ? `${title}\n\n${description}` : title, taskId);
    const task = this.options.log.board.tasks[taskId];
    if (!task) throw new ApiError('internal', 'Task vanished from the board');
    return task;
  }

  /**
   * Send a follow-up message, outside any task.
   *
   * @throws ApiError `conflict` if the cat is already working.
   */
  async chat(text: string): Promise<void> {
    this.#assertIdle();
    await this.#startTurn(text, null);
  }

  /**
   * Answer a pending approval.
   *
   * @throws ApiError `not_found` if there is no such pending approval.
   */
  async resolveApproval(
    approvalId: string,
    decision: ApprovalDecision,
    resolvedBy: 'user' | 'timeout' = 'user',
  ): Promise<void> {
    const pending = this.#approvals.get(approvalId);
    if (!pending) throw new ApiError('not_found', `No pending approval ${approvalId}`);
    this.#approvals.delete(approvalId);
    clearTimeout(pending.timer);
    this.options.log.append({
      type: 'approval.resolved',
      catId: this.catId,
      payload: { approvalId, decision, resolvedBy },
    });
    if (this.#approvals.size === 0 && this.#status() === 'waiting_approval') {
      this.#setStatus(decision === 'allow' ? 'working' : 'thinking');
    }
    try {
      await pending.session.approve(pending.requestId, decision);
    } catch (error) {
      this.options.logger.warn(`Approval ${approvalId} could not be delivered: ${String(error)}`);
    }
  }

  /** Kill the agent session. The cat stays on the board and can take a new task. */
  async kill(): Promise<void> {
    this.#killRequested = true;
    const session = this.#session ?? (await this.#spawning?.catch(() => null)) ?? null;
    if (!session) {
      this.#killRequested = false;
      return;
    }
    await session.kill();
  }

  /** Kill the session and wait until all its events are processed. */
  async close(): Promise<void> {
    await this.kill();
    await this.#pump;
  }

  #assertIdle(): void {
    if (this.#turn || this.#spawning) throw new ApiError('conflict', 'The cat is busy');
  }

  async #startTurn(prompt: string, taskId: string | null): Promise<void> {
    // Reserve the turn synchronously so a concurrent request gets `conflict`.
    this.#turn = { taskId, text: '' };
    let session: Session;
    try {
      session = await this.#ensureSession();
    } catch (error) {
      this.#failTurn('agent_start_failed', `Could not start the agent: ${errorMessage(error)}`);
      return;
    }
    if (taskId) {
      this.options.log.append({ type: 'task.updated', taskId, payload: { status: 'running' } });
    }
    try {
      await session.send(prompt);
    } catch (error) {
      this.#failTurn('agent_send_failed', `Could not send to the agent: ${errorMessage(error)}`);
    }
  }

  #failTurn(code: string, message: string): void {
    const taskId = this.#turn?.taskId;
    this.#turn = null;
    this.options.log.append({
      type: 'daemon.error',
      catId: this.catId,
      payload: { code, message: short(message) },
    });
    if (taskId) {
      this.options.log.append({
        type: 'task.updated',
        taskId,
        payload: { status: 'failed', summary: message },
      });
    }
    this.#setStatus('error', message);
  }

  async #ensureSession(): Promise<Session> {
    if (this.#session) return this.#session;
    const { adapter, config, projectPath, pids } = this.options;
    this.#spawning = adapter.spawn({
      catId: this.catId,
      cwd: projectPath,
      model: config.defaultModel,
      systemPrompt: null,
      permissionMode: config.permissionMode,
    });
    try {
      const session = await this.#spawning;
      if (session.pid !== null) await pids.add(session.pid, this.catId);
      this.#session = session;
      this.#pump = this.#consume(session);
      return session;
    } finally {
      this.#spawning = null;
    }
  }

  async #consume(session: Session): Promise<void> {
    try {
      for await (const event of session.events()) this.#handle(session, event);
    } catch (error) {
      this.options.logger.error(`Agent event stream failed: ${errorMessage(error)}`);
      this.#onSessionEnded(session, 'crashed', null);
    }
  }

  #handle(session: Session, event: AgentEvent): void {
    const { log } = this.options;
    const taskId = this.#turn?.taskId ?? undefined;
    const scope = { catId: this.catId, ...(taskId && { taskId }) };

    switch (event.type) {
      case 'session.started':
        this.options.logger.info(
          `Agent session started (${this.options.adapter.id} ${event.agentVersion ?? 'unknown version'})`,
        );
        return;

      case 'turn.started':
        this.#turn ??= { taskId: null, text: '' };
        this.#setStatus('thinking');
        return;

      case 'message.chunk':
        log.append({
          type: 'message.agent',
          ...scope,
          payload: { messageId: event.messageId, channel: event.channel, text: event.text },
        });
        if (event.channel === 'text' && this.#turn) {
          this.#turn.text = (this.#turn.text + event.text).slice(-SUMMARY_LIMIT);
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
        this.#setStatus('working', short(`${event.toolName} ${event.inputSummary}`));
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
        if (this.#status() === 'working') this.#setStatus('thinking');
        return;
      }

      case 'approval.requested': {
        const approvalId = randomUUID();
        const timer = setTimeout(() => {
          void this.resolveApproval(approvalId, 'deny', 'timeout').catch(() => undefined);
        }, this.options.config.approvalTimeoutMs);
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
        this.#setStatus('waiting_approval', short(`${event.toolName} ${event.inputSummary}`));
        return;
      }

      case 'usage':
        log.append({ type: 'usage.updated', catId: this.catId, payload: event.usage });
        return;

      case 'turn.ended':
        this.#finishTurn(event.stopReason);
        return;

      case 'error':
        log.append({
          type: 'daemon.error',
          ...scope,
          payload: { code: 'agent_error', message: event.message },
        });
        if (event.fatal) this.#setStatus('error', event.message);
        return;

      case 'session.ended':
        this.#onSessionEnded(session, event.reason, event.exitCode);
        return;
    }
  }

  #finishTurn(stopReason: StopReason): void {
    const turn = this.#turn;
    this.#turn = null;
    this.#dropApprovals();
    const update = (payload: { status: Task['status']; summary: string | null }) => {
      if (turn?.taskId) {
        this.options.log.append({ type: 'task.updated', taskId: turn.taskId, payload });
      }
    };

    switch (stopReason) {
      case 'end_turn':
        update({ status: 'done', summary: turn?.text.trim() || null });
        this.#setStatus('done');
        return;
      case 'cancelled':
        update({ status: 'cancelled', summary: null });
        this.#setStatus('idle', this.#killRequested ? 'killed' : 'interrupted');
        return;
      case 'error':
      case 'refusal':
      case 'max_tokens':
      case 'max_turns':
        update({ status: 'failed', summary: `Turn ended: ${stopReason}` });
        this.#setStatus('error', `Turn ended: ${stopReason}`);
        return;
    }
  }

  #onSessionEnded(
    session: Session,
    reason: 'exited' | 'killed' | 'crashed',
    exitCode: number | null,
  ): void {
    if (this.#session !== session) return;
    this.#session = null;
    if (this.#turn) this.#finishTurn(reason === 'killed' ? 'cancelled' : 'error');
    this.#dropApprovals();
    this.#tools.clear();
    if (session.pid !== null) void this.options.pids.remove(session.pid);
    if (reason === 'crashed') {
      this.#setStatus('error', `Agent crashed${exitCode === null ? '' : ` (exit ${exitCode})`}`);
    } else if (this.#status() !== 'error') {
      this.#setStatus('idle', reason === 'killed' ? 'killed' : null);
    }
    this.#killRequested = false;
  }

  /** Pending approvals die with their turn or session. */
  #dropApprovals(): void {
    for (const [approvalId, pending] of this.#approvals) {
      clearTimeout(pending.timer);
      this.options.log.append({
        type: 'approval.resolved',
        catId: this.catId,
        payload: { approvalId, decision: 'deny', resolvedBy: 'session_ended' },
      });
    }
    this.#approvals.clear();
  }

  #status(): CatStatus | undefined {
    return this.options.log.board.cats[this.catId]?.status;
  }

  #setStatus(status: CatStatus, reason: string | null = null): void {
    const cat = this.options.log.board.cats[this.catId];
    if (cat?.status === status && cat.statusReason === reason) return;
    this.options.log.append({
      type: 'cat.status_changed',
      catId: this.catId,
      payload: { status, reason: reason === null ? null : short(reason) },
    });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
