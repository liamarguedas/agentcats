import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';

import {
  type ContentBlock,
  client,
  type McpServer,
  methods,
  ndJsonStream,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type StopReason as AcpStopReason,
  type ToolKind as AcpToolKind,
} from '@agentclientprotocol/sdk';
import { AsyncQueue, killProcessTree, spawnGuarded } from '@agentcats/kit';
import type {
  ApprovalDecision,
  ModelTier,
  PermissionMode,
  ToolKind,
  Usage,
} from '@agentcats/protocol';
import {
  type Adapter,
  type AdapterCapabilities,
  AdapterError,
  type AgentEvent,
  type AgentPolicy,
  type CompleteOptions,
  type Completion,
  type McpServerSpec,
  type Session,
  type SpawnOptions,
  type StopReason,
} from '@agentcats/protocol/adapter';

type ClientConnection = ReturnType<ReturnType<typeof client>['connect']>;

/** How to start one ACP agent and what it can do; one of these per agent CLI. */
export interface AcpAgentConfig {
  /** Adapter id, for example `codex`. */
  readonly id: string;
  readonly displayName: string;
  /** Command and arguments that start the agent speaking ACP on stdio. */
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  /**
   * What the agent can do beyond ACP itself. `mcp`, `resume` and `approvals`
   * are also checked against what the agent says in `initialize`.
   */
  readonly capabilities: AdapterCapabilities;
  readonly modelTiers: Readonly<Record<ModelTier, string | null>>;
  /** Expected cost of one interview candidate per tier; `null` when unknown. */
  readonly estimateUsd?: (tier: ModelTier) => number | null;
  /**
   * The agent's session mode for a policy and permission mode, set with
   * `session/set_mode`; `null` keeps the agent's default.
   */
  readonly modeFor?: (policy: AgentPolicy | undefined, mode: PermissionMode) => string | null;
  /** Session config option that selects the model (`session/set_config_option`); `null` if none. */
  readonly modelOption?: string | null;
  /** How long to wait for the agent to answer `initialize` and `session/new`. Default 60 s. */
  readonly startTimeoutMs?: number;
}

const ACP_KINDS: Record<AcpToolKind, ToolKind> = {
  read: 'read',
  edit: 'edit',
  delete: 'delete',
  move: 'move',
  search: 'search',
  execute: 'execute',
  think: 'think',
  fetch: 'fetch',
  switch_mode: 'other',
  other: 'other',
};

const STOP_REASONS: Record<AcpStopReason, StopReason> = {
  end_turn: 'end_turn',
  max_tokens: 'max_tokens',
  max_turn_requests: 'max_turns',
  refusal: 'refusal',
  cancelled: 'cancelled',
};

const short = (text: string, limit = 160) =>
  text.length > limit ? `${text.slice(0, limit - 1)}…` : text;

/**
 * An adapter for any agent that speaks the Agent Client Protocol on stdio.
 * Our adapter contract mirrors ACP (docs/decisions.md, Step 0.2), so this is
 * mostly a mapping:
 *
 * - `spawn`: start the process, `initialize`, `session/new` (or
 *   `session/resume`), then the configured mode and model.
 * - `send`: `session/prompt`; its response ends the turn.
 * - `session/update`: text, thoughts, tool calls and usage become `AgentEvent`s.
 * - `session/request_permission`: an `approval.requested`, answered by `approve`.
 * - `interrupt`: `session/cancel`. `kill`: the process tree.
 *
 * ACP has no system prompt, so `systemPrompt` is sent ahead of the first
 * message, marked as standing instructions.
 */
export function createAcpAdapter(config: AcpAgentConfig): Adapter {
  return {
    id: config.id,
    displayName: config.displayName,
    capabilities: config.capabilities,
    modelTiers: config.modelTiers,
    estimateUsd: (tier) => config.estimateUsd?.(tier) ?? null,
    spawn: (options) => AcpSession.start(config, options),
    complete: (options) => completeOnce(config, options),
  };
}

/** One prompt in a read-only session, its text collected, then the process stopped. */
async function completeOnce(config: AcpAgentConfig, options: CompleteOptions): Promise<Completion> {
  const session = await AcpSession.start(config, {
    catId: 'complete',
    cwd: options.cwd,
    model: options.model,
    systemPrompt: options.systemPrompt,
    permissionMode: 'ask',
    policy: { access: 'read_only', allowedCommands: [], protectedPaths: [] },
  });
  let text = '';
  const seen: { usage: Usage | null } = { usage: null };
  const done = (async () => {
    for await (const event of session.events()) {
      if (event.type === 'message.chunk' && event.channel === 'text') text += event.text;
      if (event.type === 'usage') seen.usage = event.usage;
      if (event.type === 'approval.requested') void session.approve(event.requestId, 'deny');
      if (event.type === 'turn.ended') return event.stopReason;
    }
    return 'error' as const;
  })();
  try {
    await session.send(options.prompt);
    const timer = new Promise<never>((_, reject) =>
      setTimeout(() => {
        reject(new AdapterError('spawn_failed', `${config.displayName} did not answer in time`));
      }, options.timeoutMs ?? 120_000).unref(),
    );
    const stop = await Promise.race([done, timer]);
    if (stop !== 'end_turn')
      throw new AdapterError('spawn_failed', `${config.displayName} answered with ${stop}`);
    return {
      text: text.trim(),
      usage: seen.usage ?? {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: null,
        costSource: 'unknown',
        activeMs: 0,
      },
    };
  } finally {
    await session.kill();
  }
}

class AcpSession implements Session {
  readonly id = randomUUID();
  readonly pid: number | null;

  readonly #events = new AsyncQueue<AgentEvent>();
  readonly #approvals = new Map<string, (decision: ApprovalDecision) => void>();
  readonly #openTools = new Map<string, true>();
  #connection: ClientConnection | null = null;
  #sessionId = '';
  #eventsTaken = false;
  #ended = false;
  #killing = false;
  #inTurn = false;
  #turnDone: Promise<void> | null = null;
  #messageId: string | null = null;
  #pendingSystemPrompt: string | null;
  #usage: Usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: null,
    costSource: 'unknown',
    activeMs: 0,
  };

  private constructor(
    private readonly config: AcpAgentConfig,
    private readonly options: SpawnOptions,
    private readonly child: ChildProcessWithoutNullStreams,
  ) {
    this.pid = child.pid ?? null;
    this.#pendingSystemPrompt = options.systemPrompt;
  }

  static async start(config: AcpAgentConfig, options: SpawnOptions): Promise<AcpSession> {
    const child = spawnGuarded(config.command, config.args, {
      cwd: options.cwd,
      env: { ...process.env, ...config.env },
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-2_000);
    });
    const session = new AcpSession(config, options, child);
    try {
      await withTimeout(session.#connect(), config.startTimeoutMs ?? 60_000);
    } catch (error) {
      if (child.pid !== undefined) await killProcessTree(child.pid);
      const detail = stderr.trim() || (error instanceof Error ? error.message : String(error));
      throw new AdapterError(
        'spawn_failed',
        `${config.displayName} did not start: ${short(detail, 500)}`,
        {
          cause: error,
        },
      );
    }
    child.once('exit', (code) => {
      session.#end(session.#killing ? 'killed' : code === 0 ? 'exited' : 'crashed', code);
    });
    return session;
  }

  async #connect(): Promise<void> {
    const stream = ndJsonStream(
      Writable.toWeb(this.child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(this.child.stdout) as ReadableStream<Uint8Array>,
    );
    const connection = client({ name: 'agentcats' })
      .onNotification(methods.client.session.update, ({ params }) => {
        this.#onUpdate(params);
      })
      .onRequest(methods.client.session.requestPermission, ({ params }) =>
        this.#onPermission(params),
      )
      .connect(stream);
    this.#connection = connection;
    const init = await connection.agent.request(methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'agentcats', version: '0.0.0' },
    });
    const mcpServers = Object.entries(this.options.mcpServers ?? {}).map(([name, spec]) =>
      toAcpMcp(name, spec),
    );
    if (
      mcpServers.some((s) => 'type' in s && s.type === 'http') &&
      !init.agentCapabilities?.mcpCapabilities?.http
    ) {
      throw new AdapterError('unsupported', `${this.config.displayName} cannot use MCP over HTTP`);
    }
    const { cwd } = this.options;
    if (this.options.resumeId && init.agentCapabilities?.sessionCapabilities?.resume) {
      await connection.agent.request(methods.agent.session.resume, {
        sessionId: this.options.resumeId,
        cwd,
        mcpServers,
      });
      this.#sessionId = this.options.resumeId;
      this.#pendingSystemPrompt = null; // the resumed session already has it
    } else {
      const created = await connection.agent.request(methods.agent.session.new, {
        cwd,
        mcpServers,
      });
      this.#sessionId = created.sessionId;
    }
    const mode = this.config.modeFor?.(this.options.policy, this.options.permissionMode) ?? null;
    if (mode) {
      await connection.agent.request(methods.agent.session.setMode, {
        sessionId: this.#sessionId,
        modeId: mode,
      });
    }
    if (this.options.model && this.config.modelOption) {
      await connection.agent.request(methods.agent.session.setConfigOption, {
        sessionId: this.#sessionId,
        configId: this.config.modelOption,
        value: this.options.model,
      });
    }
    this.#emit({
      type: 'session.started',
      resumeId: init.agentCapabilities?.sessionCapabilities?.resume ? this.#sessionId : null,
      model: this.options.model,
      agentVersion: init.agentInfo?.version ?? null,
      billing: 'unknown',
    });
  }

  send(text: string): Promise<void> {
    if (this.#ended) return Promise.reject(new AdapterError('closed', 'Session has ended'));
    if (this.#inTurn) return Promise.reject(new AdapterError('busy', 'A turn is already running'));
    const connection = this.#connection;
    if (!connection) return Promise.reject(new AdapterError('closed', 'Not connected'));
    this.#inTurn = true;
    this.#messageId = null;
    this.#emit({ type: 'turn.started' });
    const prompt: ContentBlock[] = [];
    if (this.#pendingSystemPrompt) {
      prompt.push({
        type: 'text',
        text: `<instructions>\nStanding instructions for this whole session, from agentcats:\n\n${this.#pendingSystemPrompt}\n</instructions>`,
      });
      this.#pendingSystemPrompt = null;
    }
    prompt.push({ type: 'text', text });
    this.#turnDone = connection.agent
      .request(methods.agent.session.prompt, { sessionId: this.#sessionId, prompt })
      .then(
        (response) => {
          this.#endTurn(STOP_REASONS[response.stopReason]);
        },
        (error: unknown) => {
          if (this.#ended || this.#killing) return;
          // A closed connection means the agent process is gone: the session is ending.
          const fatal = connection.signal.aborted;
          const message = fatal
            ? `${this.config.displayName} stopped unexpectedly`
            : short(errorText(error), 500);
          this.#emit({ type: 'error', message, fatal });
          this.#endTurn('error');
        },
      );
    return Promise.resolve();
  }

  events(): AsyncIterable<AgentEvent> {
    if (this.#eventsTaken) throw new AdapterError('closed', 'events() can only be called once');
    this.#eventsTaken = true;
    return this.#events;
  }

  approve(requestId: string, decision: ApprovalDecision): Promise<void> {
    if (this.#ended) return Promise.reject(new AdapterError('closed', 'Session has ended'));
    const resolve = this.#approvals.get(requestId);
    if (!resolve)
      return Promise.reject(new AdapterError('not_found', `No pending approval ${requestId}`));
    this.#approvals.delete(requestId);
    resolve(decision);
    return Promise.resolve();
  }

  async interrupt(): Promise<void> {
    if (!this.#inTurn || !this.#connection) return;
    this.#denyPending();
    await this.#connection.agent.notify(methods.agent.session.cancel, {
      sessionId: this.#sessionId,
    });
    await this.#turnDone;
  }

  async kill(): Promise<void> {
    if (this.#ended) return;
    this.#killing = true; // the exit that follows is ours, not a crash
    this.#denyPending();
    this.#connection?.close();
    if (this.child.pid !== undefined) await killProcessTree(this.child.pid);
    this.#end('killed', null);
  }

  // -------------------------------------------------------------------------
  // From the agent
  // -------------------------------------------------------------------------

  #onUpdate(notification: SessionNotification): void {
    if (notification.sessionId !== this.#sessionId || !this.#inTurn) return;
    const update = notification.update;
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
      case 'agent_thought_chunk': {
        if (update.content.type !== 'text') return;
        this.#messageId ??= update.messageId ?? randomUUID();
        this.#emit({
          type: 'message.chunk',
          messageId: this.#messageId,
          channel: update.sessionUpdate === 'agent_message_chunk' ? 'text' : 'thought',
          text: update.content.text,
        });
        return;
      }
      case 'tool_call': {
        this.#messageId = null; // text after a tool call is a new message
        if (!this.#openTools.has(update.toolCallId)) {
          this.#openTools.set(update.toolCallId, true);
          this.#emit({
            type: 'tool.started',
            toolCallId: update.toolCallId,
            toolName: short(update.title || 'tool', 200),
            kind: ACP_KINDS[update.kind ?? 'other'],
            inputSummary: short(summarize(update.rawInput, update.locations)),
          });
        }
        if (update.status === 'completed' || update.status === 'failed') {
          this.#finishTool(update.toolCallId, update.status);
        }
        return;
      }
      case 'tool_call_update':
        if (update.status === 'completed' || update.status === 'failed') {
          this.#finishTool(update.toolCallId, update.status);
        }
        return;
      case 'usage_update': {
        const cost = update.cost;
        this.#usage = {
          ...this.#usage,
          ...(cost && cost.currency.toUpperCase() === 'USD'
            ? {
                costUsd: Math.max(this.#usage.costUsd ?? 0, cost.amount),
                costSource: 'reported' as const,
              }
            : {}),
        };
        this.#emit({ type: 'usage', usage: { ...this.#usage } });
        return;
      }
      default:
        return;
    }
  }

  async #onPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const allow =
      params.options.find((o) => o.kind === 'allow_once') ??
      params.options.find((o) => o.kind === 'allow_always');
    const reject =
      params.options.find((o) => o.kind === 'reject_once') ??
      params.options.find((o) => o.kind === 'reject_always');
    const title = params.toolCall.title ?? 'tool';
    // The lead's agentcats tools are its job; they need no prompt.
    if (this.options.policy?.access === 'read_only' && /agentcats/i.test(title) && allow) {
      return { outcome: { outcome: 'selected', optionId: allow.optionId } };
    }
    const requestId = randomUUID();
    const decision = await new Promise<ApprovalDecision>((resolve) => {
      this.#approvals.set(requestId, resolve);
      this.#emit({
        type: 'approval.requested',
        requestId,
        toolCallId: params.toolCall.toolCallId,
        toolName: short(title, 200),
        kind: ACP_KINDS[params.toolCall.kind ?? 'other'],
        inputSummary: short(summarize(params.toolCall.rawInput, params.toolCall.locations)),
      });
    });
    const option = decision === 'allow' ? allow : reject;
    return option
      ? { outcome: { outcome: 'selected', optionId: option.optionId } }
      : { outcome: { outcome: 'cancelled' } };
  }

  #finishTool(toolCallId: string, status: 'completed' | 'failed'): void {
    if (!this.#openTools.delete(toolCallId)) return;
    this.#emit({
      type: 'tool.finished',
      toolCallId,
      status: status === 'completed' ? 'success' : 'error',
      outputSummary: null,
    });
  }

  #endTurn(stopReason: StopReason): void {
    if (!this.#inTurn) return;
    for (const toolCallId of [...this.#openTools.keys()]) this.#finishTool(toolCallId, 'failed');
    this.#denyPending();
    this.#emit({ type: 'usage', usage: { ...this.#usage } });
    this.#inTurn = false;
    this.#emit({ type: 'turn.ended', stopReason });
  }

  #denyPending(): void {
    for (const [requestId, resolve] of this.#approvals) {
      this.#approvals.delete(requestId);
      resolve('deny');
    }
  }

  #end(reason: 'exited' | 'killed' | 'crashed', exitCode: number | null): void {
    if (this.#ended) return;
    if (this.#inTurn) {
      if (reason === 'crashed') {
        this.#emit({
          type: 'error',
          message: `${this.config.displayName} stopped unexpectedly`,
          fatal: true,
        });
      }
      this.#endTurn(reason === 'killed' ? 'cancelled' : 'error');
    }
    this.#ended = true;
    this.#connection?.close();
    this.#emit({ type: 'session.ended', reason, exitCode });
    this.#events.close();
  }

  #emit(event: AgentEvent): void {
    this.#events.push(event);
  }
}

function toAcpMcp(name: string, spec: McpServerSpec): McpServer {
  if (spec.type === 'http') {
    return {
      type: 'http',
      name,
      url: spec.url,
      headers: Object.entries(spec.headers ?? {}).map(([header, value]) => ({
        name: header,
        value,
      })),
    };
  }
  return {
    name,
    command: spec.command,
    args: [...(spec.args ?? [])],
    env: Object.entries(spec.env ?? {}).map(([key, value]) => ({ name: key, value })),
  };
}

/** One line for the bubble: a command, a path, or the first string field. */
function summarize(rawInput: unknown, locations?: readonly { path: string }[] | null): string {
  const input = (rawInput ?? {}) as Record<string, unknown>;
  for (const key of ['command', 'cmd', 'path', 'file_path', 'url', 'query']) {
    const value = input[key];
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value.join(' ');
  }
  if (locations?.[0]?.path) return locations[0].path;
  const first = Object.values(input).find((v) => typeof v === 'string');
  return typeof first === 'string' ? first : '';
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String(error.message);
  }
  return String(error);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out after ${String(ms)} ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
