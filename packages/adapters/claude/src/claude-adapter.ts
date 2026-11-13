import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { AsyncQueue, killProcessTree, spawnGuarded } from '@agentcats/kit';
import type { ApprovalDecision, Billing, PermissionMode } from '@agentcats/protocol';
import {
  type Adapter,
  type AdapterCapabilities,
  AdapterError,
  type AgentEvent,
  type CompleteOptions,
  type Completion,
  type McpServerSpec,
  type Session,
  type SpawnOptions,
} from '@agentcats/protocol/adapter';
import {
  type CanUseTool,
  type McpServerConfig,
  type PermissionMode as ClaudePermissionMode,
  type PermissionResult,
  type Query,
  query,
  type SDKResultMessage,
  type SDKUserMessage,
  type SpawnOptions as SdkSpawnOptions,
} from '@anthropic-ai/claude-agent-sdk';

import { claudeVersion, resolveClaudeExecutable, TESTED_CLAUDE_VERSIONS } from './executable.js';
import { policyOptions, sessionSettings } from './policy.js';
import { billingOf, summarizeInput, toolKind, Translator, usageOfResult } from './translate.js';

export interface ClaudeAdapterOptions {
  /** Path to `claude`. `null` or omitted resolves `claude` on PATH. */
  readonly executablePath?: string | null;
  /** How long to wait for Claude Code to start. Default 60 s. */
  readonly startTimeoutMs?: number;
}

const CAPABILITIES: AdapterCapabilities = {
  mcp: true,
  approvals: true,
  resume: true,
  reportsCost: true,
  modelSelection: true,
  interrupt: true,
  permissionModes: ['ask', 'accept_edits', 'auto'],
  policyEnforcement: 'hooks',
  complete: true,
};

const PERMISSION_MODES: Record<PermissionMode, ClaudePermissionMode> = {
  ask: 'default',
  accept_edits: 'acceptEdits',
  auto: 'auto',
};

const STDERR_TAIL = 2_000;

function toClaudeMcp(spec: McpServerSpec): McpServerConfig {
  return spec.type === 'http'
    ? { type: 'http', url: spec.url, ...(spec.headers && { headers: { ...spec.headers } }) }
    : {
        type: 'stdio',
        command: spec.command,
        ...(spec.args && { args: [...spec.args] }),
        ...(spec.env && { env: { ...spec.env } }),
      };
}

/**
 * Adapter for Claude, through the Claude Agent SDK. It runs the user's own
 * installed `claude`, so their login and Claude Code setup apply; agentcats
 * never handles credentials.
 */
export function createClaudeAdapter(options: ClaudeAdapterOptions = {}): Adapter {
  return {
    id: 'claude',
    displayName: 'Claude',
    capabilities: CAPABILITIES,
    modelTiers: { fast: 'haiku', balanced: 'sonnet', best: 'opus' },
    // About what one interview candidate costs on each tier, at API prices.
    estimateUsd: (tier) => ({ fast: 0.05, balanced: 0.25, best: 1.25 })[tier],
    spawn: (spawnOptions) => spawnClaudeSession(spawnOptions, options),
    complete: (completeOptions) => completeOnce(completeOptions, options),
  };
}

async function requireExecutable(adapterOptions: ClaudeAdapterOptions): Promise<string> {
  const executable = await resolveClaudeExecutable(adapterOptions.executablePath ?? null);
  if (executable) return executable;
  throw new AdapterError(
    'spawn_failed',
    adapterOptions.executablePath
      ? `Claude Code not found at ${adapterOptions.executablePath}`
      : 'Claude Code (`claude`) was not found on PATH. Install it, or set claude.executablePath in agentcats.config.json.',
  );
}

/**
 * Start Claude Code under the guardian, so it cannot outlive the daemon.
 * `kill()` on the guardian alone would orphan the agent on Windows, so it
 * kills the whole tree.
 */
function guardedSpawn(
  spawn: SdkSpawnOptions,
  onStderr: (chunk: string) => void,
): ReturnType<typeof spawnGuarded> {
  const guarded = spawnGuarded(spawn.command, spawn.args, {
    ...(spawn.cwd !== undefined && { cwd: spawn.cwd }),
    env: spawn.env,
  });
  guarded.stderr.setEncoding('utf8');
  guarded.stderr.on('data', onStderr);
  guarded.kill = () => {
    if (guarded.pid !== undefined) void killProcessTree(guarded.pid);
    return true;
  };
  spawn.signal.addEventListener('abort', () => guarded.kill(), { once: true });
  return guarded;
}

/**
 * One prompt, one answer: no tools, no settings files, no saved session, and
 * a plain system prompt instead of Claude Code's own. Verified to cost a few
 * hundred input tokens (decisions.md, Step 0 for M2).
 */
async function completeOnce(
  options: CompleteOptions,
  adapterOptions: ClaudeAdapterOptions,
): Promise<Completion> {
  const executable = await requireExecutable(adapterOptions);
  let child: ChildProcess | null = null;
  let stderr = '';
  const q = query({
    prompt: options.prompt,
    options: {
      cwd: options.cwd,
      ...(options.model !== null && { model: options.model }),
      systemPrompt: options.systemPrompt,
      tools: [],
      maxTurns: 1,
      settingSources: [],
      persistSession: false,
      strictMcpConfig: true,
      mcpServers: {},
      pathToClaudeCodeExecutable: executable,
      spawnClaudeCodeProcess: (spawn) => {
        const guarded = guardedSpawn(spawn, (chunk) => {
          stderr = (stderr + chunk).slice(-STDERR_TAIL);
        });
        child = guarded;
        return guarded;
      },
    },
  });
  const answer = (async () => {
    let result: SDKResultMessage | null = null;
    for await (const message of q) if (message.type === 'result') result = message;
    return result;
  })();
  try {
    const result = await withTimeout(answer, options.timeoutMs ?? 120_000);
    if (!result || result.subtype !== 'success') {
      throw new Error(result ? `ended with ${result.subtype}` : 'no answer');
    }
    return { text: result.result, usage: usageOfResult(result) };
  } catch (error) {
    const detail = stderr.trim() || (error instanceof Error ? error.message : String(error));
    throw new AdapterError('spawn_failed', `Claude Code did not answer: ${detail}`, {
      cause: error,
    });
  } finally {
    q.close();
    const pid = (child as ChildProcess | null)?.pid;
    if (pid !== undefined) await killProcessTree(pid);
  }
}

async function spawnClaudeSession(
  options: SpawnOptions,
  adapterOptions: ClaudeAdapterOptions,
): Promise<Session> {
  const executable = await requireExecutable(adapterOptions);
  const version = await claudeVersion(executable).catch(() => null);

  const input = new AsyncQueue<SDKUserMessage>();
  const resumeId = options.resumeId ?? randomUUID();
  let child: ChildProcess | null = null;
  let stderr = '';
  const session = new ClaudeSession(input, resumeId, version);

  const q = query({
    prompt: input,
    options: {
      cwd: options.cwd,
      ...(options.model !== null && { model: options.model }),
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        ...(options.systemPrompt !== null && { append: options.systemPrompt }),
      },
      permissionMode: PERMISSION_MODES[options.permissionMode],
      canUseTool: session.canUseTool,
      pathToClaudeCodeExecutable: executable,
      ...(options.resumeId ? { resume: options.resumeId } : { sessionId: resumeId }),
      ...policyOptions(options.policy, options.cwd),
      ...sessionSettings(options.attribution),
      strictMcpConfig: true,
      mcpServers: Object.fromEntries(
        Object.entries(options.mcpServers ?? {}).map(([name, spec]) => [name, toClaudeMcp(spec)]),
      ),
      spawnClaudeCodeProcess: (spawn) => {
        const guarded = guardedSpawn(spawn, (chunk) => {
          stderr = (stderr + chunk).slice(-STDERR_TAIL);
        });
        child = guarded;
        return guarded;
      },
    },
  });

  try {
    await withTimeout(q.initializationResult(), adapterOptions.startTimeoutMs ?? 60_000);
  } catch (error) {
    q.close();
    const pid = (child as ChildProcess | null)?.pid;
    if (pid !== undefined) await killProcessTree(pid);
    const detail = stderr.trim() || (error instanceof Error ? error.message : String(error));
    throw new AdapterError('spawn_failed', `Claude Code did not start: ${detail}`, {
      cause: error,
    });
  }

  const account = await q.accountInfo().catch(() => null);
  session.attach(q, child, options.model, billingOf(account));
  return session;
}

class ClaudeSession implements Session {
  readonly id = randomUUID();
  pid: number | null = null;

  readonly #events = new AsyncQueue<AgentEvent>();
  readonly #translator = new Translator();
  readonly #approvals = new Map<
    string,
    { resolve: (decision: ApprovalDecision) => void; input: Record<string, unknown> }
  >();
  #query: Query | null = null;
  #child: ChildProcess | null = null;
  #eventsTaken = false;
  #inTurn = false;
  #interrupting = false;
  #ended = false;
  #turnEnded: (() => void) | null = null;

  constructor(
    private readonly input: AsyncQueue<SDKUserMessage>,
    private readonly resumeId: string,
    private readonly version: string | null,
  ) {}

  attach(q: Query, child: ChildProcess | null, model: string | null, billing: Billing): void {
    this.#query = q;
    this.#child = child;
    this.pid = child?.pid ?? null;
    this.#emit({
      type: 'session.started',
      resumeId: this.resumeId,
      model,
      agentVersion: this.version,
      billing,
    });
    if (this.version === null || !TESTED_CLAUDE_VERSIONS.includes(this.version)) {
      this.#emit({
        type: 'error',
        message: `Claude Code ${this.version ?? '(unknown version)'} has not been tested with agentcats (tested: ${TESTED_CLAUDE_VERSIONS.join(', ')})`,
        fatal: false,
      });
    }
    child?.once('exit', (code) => {
      this.#end(code === 0 ? 'exited' : 'crashed', code);
    });
    void this.#pump(q);
  }

  send(text: string): Promise<void> {
    if (this.#ended) return Promise.reject(new AdapterError('closed', 'Session has ended'));
    if (this.#inTurn) return Promise.reject(new AdapterError('busy', 'A turn is already running'));
    this.#inTurn = true;
    this.#emit({ type: 'turn.started' });
    this.input.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      origin: { kind: 'human' },
    });
    return Promise.resolve();
  }

  events(): AsyncIterable<AgentEvent> {
    if (this.#eventsTaken) throw new AdapterError('closed', 'events() can only be called once');
    this.#eventsTaken = true;
    return this.#events;
  }

  approve(requestId: string, decision: ApprovalDecision): Promise<void> {
    if (this.#ended) return Promise.reject(new AdapterError('closed', 'Session has ended'));
    const pending = this.#approvals.get(requestId);
    if (!pending) {
      return Promise.reject(new AdapterError('not_found', `No pending approval ${requestId}`));
    }
    this.#approvals.delete(requestId);
    pending.resolve(decision);
    return Promise.resolve();
  }

  async interrupt(): Promise<void> {
    if (!this.#inTurn || !this.#query) return;
    this.#interrupting = true;
    this.#denyPending();
    const ended = new Promise<void>((resolve) => (this.#turnEnded = resolve));
    await this.#query.interrupt();
    await ended;
  }

  async kill(): Promise<void> {
    if (this.#ended) return;
    this.#interrupting = true;
    this.#denyPending();
    this.input.close();
    this.#query?.close();
    if (this.#child?.pid !== undefined) await killProcessTree(this.#child.pid);
    this.#end('killed', null);
  }

  /** Permission callback handed to the SDK. Turns each prompt into an approval request. */
  readonly canUseTool: CanUseTool = (toolName, input, { signal, toolUseID }) => {
    const requestId = randomUUID();
    this.#emit({
      type: 'approval.requested',
      requestId,
      toolCallId: toolUseID,
      toolName,
      kind: toolKind(toolName),
      inputSummary: summarizeInput(input),
    });
    return new Promise<PermissionResult>((resolve) => {
      const answer = (decision: ApprovalDecision) => {
        resolve(
          decision === 'allow'
            ? { behavior: 'allow', updatedInput: input }
            : { behavior: 'deny', message: 'The user denied this action in agentcats.' },
        );
      };
      this.#approvals.set(requestId, { resolve: answer, input });
      signal.addEventListener(
        'abort',
        () => {
          this.#approvals.delete(requestId);
          answer('deny');
        },
        { once: true },
      );
    });
  };

  async #pump(q: Query): Promise<void> {
    try {
      for await (const message of q) {
        const events = this.#translator.handle(message, this.#interrupting);
        for (const event of events) this.#emit(event);
        if (message.type === 'result') this.#afterTurn();
      }
      this.#end('exited', this.#child?.exitCode ?? null);
    } catch (error) {
      if (!this.#ended) {
        const message = error instanceof Error ? error.message : String(error);
        this.#emit({ type: 'error', message: message.slice(0, 500), fatal: true });
        this.#end('crashed', this.#child?.exitCode ?? null);
      }
    }
  }

  #afterTurn(): void {
    this.#inTurn = false;
    this.#interrupting = false;
    this.#turnEnded?.();
    this.#turnEnded = null;
  }

  #denyPending(): void {
    for (const [requestId, pending] of this.#approvals) {
      this.#approvals.delete(requestId);
      pending.resolve('deny');
    }
  }

  #end(reason: 'exited' | 'killed' | 'crashed', exitCode: number | null): void {
    if (this.#ended) return;
    this.#denyPending();
    if (this.#inTurn) {
      for (const event of this.#translator.closeTurn(reason === 'killed' ? 'cancelled' : 'error')) {
        this.#emit(event);
      }
      this.#afterTurn();
    }
    this.#ended = true;
    this.#emit({ type: 'session.ended', reason, exitCode });
    this.#events.close();
    this.input.close();
  }

  #emit(event: AgentEvent): void {
    this.#events.push(event);
  }
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
