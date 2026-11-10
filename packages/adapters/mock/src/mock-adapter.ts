import {
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  execFile,
} from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { AsyncQueue, killProcessTree, spawnGuarded } from '@agentcats/kit';
import type { ApprovalDecision, Billing, Usage } from '@agentcats/protocol';
import {
  type Adapter,
  type AdapterCapabilities,
  AdapterError,
  type AgentEvent,
  type Session,
  type SpawnOptions,
  type StopReason,
} from '@agentcats/protocol/adapter';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import {
  type Scenario,
  scenarioForPrompt,
  SCENARIOS,
  type ToolSpec,
  type TurnContext,
} from './scenarios.js';

const execFileAsync = promisify(execFile);

export interface MockAdapterOptions {
  /**
   * Scenario name from {@link SCENARIOS}, or a custom scenario. Default
   * `happy-path`, or `orchestrator` for a session given the agentcats MCP
   * server. For workers, a prompt line `/<name>` (for example `/approval`)
   * plays that built-in scenario for that turn instead.
   */
  readonly scenario?: string | Scenario;
  /**
   * Multiplier for every delay. `1` gives realistic pacing for UI work, `0`
   * runs as fast as possible for tests. Default `1`.
   */
  readonly timeScale?: number;
  /**
   * Run a real idle child process (under the guardian) as a stand-in for the
   * agent CLI, so process tracking and cleanup can be tested. Default `false`.
   */
  readonly spawnProcess?: boolean;
  /** Billing the mock reports at session start. Default `metered`, so budgets apply. */
  readonly billing?: Billing;
  /**
   * Let scenarios write files and make git commits in the session's `cwd`.
   * Off by default, so a mock never touches a directory unless asked. The
   * daemon turns it on; its workers run in throwaway worktrees.
   */
  readonly realFiles?: boolean;
}

const CAPABILITIES: AdapterCapabilities = {
  mcp: true,
  approvals: true,
  resume: false,
  reportsCost: false,
  modelSelection: true,
  interrupt: true,
  permissionModes: ['ask', 'accept_edits', 'auto'],
};

/** Made-up per-token prices so the board has an estimated cost to show. */
const ESTIMATED_USD_PER_INPUT_TOKEN = 3 / 1e6;
const ESTIMATED_USD_PER_OUTPUT_TOKEN = 15 / 1e6;

/** Rejection reason used when a turn is interrupted or the session is killed. */
class TurnAborted extends Error {
  override readonly name = 'TurnAborted';
}

/**
 * An adapter that plays scripted scenarios instead of running an agent. Needs
 * no agent CLI, no network and no API key.
 */
export function createMockAdapter(options: MockAdapterOptions = {}): Adapter {
  const timeScale = options.timeScale ?? 1;
  return {
    id: 'mock',
    displayName: 'Mock',
    capabilities: CAPABILITIES,
    async spawn(spawnOptions) {
      const isOrchestrator = spawnOptions.mcpServers?.['agentcats'] !== undefined;
      const scenario = resolveScenario(
        isOrchestrator ? 'orchestrator' : (options.scenario ?? 'happy-path'),
      );
      const child = options.spawnProcess ? await startStandInProcess(spawnOptions.cwd) : null;
      return new MockSession(
        spawnOptions,
        scenario,
        timeScale,
        child,
        options.billing ?? 'metered',
        options.realFiles ?? false,
      );
    },
  };
}

function resolveScenario(scenario: string | Scenario): Scenario {
  if (typeof scenario !== 'string') return scenario;
  const found = SCENARIOS[scenario];
  if (!found) {
    const known = Object.keys(SCENARIOS).join(', ');
    throw new AdapterError('spawn_failed', `Unknown mock scenario "${scenario}". Known: ${known}`);
  }
  return found;
}

async function startStandInProcess(cwd: string): Promise<ChildProcessWithoutNullStreams> {
  const child = spawnGuarded(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { cwd });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', (error) => {
      reject(
        new AdapterError('spawn_failed', 'Mock agent process failed to start', { cause: error }),
      );
    });
  });
  child.stdout.resume();
  child.stderr.resume();
  return child;
}

class MockSession implements Session {
  readonly id = randomUUID();
  readonly pid: number | null;

  readonly #queue = new AsyncQueue<AgentEvent>();
  readonly #pendingApprovals = new Map<string, (decision: ApprovalDecision) => void>();
  readonly #openTools = new Set<string>();
  readonly #usage: Usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    costSource: 'estimated',
  };
  #eventsTaken = false;
  #ended = false;
  #turnCount = 0;
  #nextId = 0;
  #turn: { abort: AbortController; done: Promise<void> } | null = null;
  readonly #state = new Map<string, unknown>();
  #mcp: Promise<Client> | null = null;

  constructor(
    private readonly options: SpawnOptions,
    private readonly scenario: Scenario,
    private readonly timeScale: number,
    private readonly child: ChildProcess | null,
    billing: Billing,
    private readonly realFiles: boolean,
  ) {
    this.pid = child?.pid ?? null;
    child?.once('exit', (code) => void this.#onChildExit(code));
    this.#emit({
      type: 'session.started',
      resumeId: null,
      model: options.model,
      agentVersion: 'mock',
      billing,
    });
  }

  send(text: string): Promise<void> {
    if (this.#ended) return Promise.reject(new AdapterError('closed', 'Session has ended'));
    if (this.#turn) return Promise.reject(new AdapterError('busy', 'A turn is already running'));
    const abort = new AbortController();
    this.#turn = { abort, done: this.#runTurn(text, abort.signal) };
    return Promise.resolve();
  }

  events(): AsyncIterable<AgentEvent> {
    if (this.#eventsTaken) throw new AdapterError('closed', 'events() can only be called once');
    this.#eventsTaken = true;
    return this.#queue;
  }

  approve(requestId: string, decision: ApprovalDecision): Promise<void> {
    if (this.#ended) return Promise.reject(new AdapterError('closed', 'Session has ended'));
    const resolve = this.#pendingApprovals.get(requestId);
    if (!resolve) {
      return Promise.reject(new AdapterError('not_found', `No pending approval ${requestId}`));
    }
    this.#pendingApprovals.delete(requestId);
    resolve(decision);
    return Promise.resolve();
  }

  async interrupt(): Promise<void> {
    const turn = this.#turn;
    if (!turn) return;
    turn.abort.abort();
    await turn.done;
  }

  async kill(): Promise<void> {
    if (this.#ended) return;
    await this.interrupt();
    if (this.child?.pid !== undefined) await killProcessTree(this.child.pid);
    this.#end('killed', null);
  }

  async #onChildExit(code: number | null): Promise<void> {
    if (this.#ended) return;
    await this.interrupt();
    this.#end('crashed', code);
  }

  async #runTurn(prompt: string, signal: AbortSignal): Promise<void> {
    this.#turnCount += 1;
    this.#emit({ type: 'turn.started' });
    let stopReason: StopReason;
    let crashed = false;
    try {
      // An orchestrator only delegates; scenario lines in its prompts are meant for workers.
      const scenario = this.#hasMcp ? this.scenario : (scenarioForPrompt(prompt) ?? this.scenario);
      stopReason = await scenario.turn(this.#context(prompt, signal));
    } catch (error) {
      if (signal.aborted) {
        stopReason = 'cancelled';
      } else {
        crashed = true;
        stopReason = 'error';
        const message = error instanceof Error ? error.message : String(error);
        this.#emit({ type: 'error', message, fatal: true });
      }
    }
    for (const toolCallId of [...this.#openTools]) {
      this.#emit({ type: 'tool.finished', toolCallId, status: 'error', outputSummary: null });
    }
    this.#pendingApprovals.clear();
    this.#emit({ type: 'turn.ended', stopReason });
    this.#turn = null;
    if (crashed) {
      if (this.child?.pid !== undefined) await killProcessTree(this.child.pid);
      this.#end('crashed', null);
    }
  }

  #context(prompt: string, signal: AbortSignal): TurnContext {
    const sleep = (ms: number) =>
      new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          reject(new TurnAborted());
          return;
        }
        const scaled = ms * this.timeScale;
        const timer = Number.isFinite(ms) ? setTimeout(resolve, scaled) : undefined;
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new TurnAborted());
          },
          { once: true },
        );
      });

    const tool = async (spec: ToolSpec, effect?: () => Promise<void>) => {
      const toolCallId = this.#id('tool');
      this.#emit({
        type: 'tool.started',
        toolCallId,
        toolName: spec.toolName,
        kind: spec.kind,
        inputSummary: spec.inputSummary,
      });
      await sleep(spec.durationMs ?? 900);
      let failed = spec.fails ?? false;
      if (effect)
        failed = await effect().then(
          () => false,
          () => true,
        );
      this.#emit({
        type: 'tool.finished',
        toolCallId,
        status: failed ? 'error' : 'success',
        outputSummary: failed ? 'exit code 1' : null,
      });
    };
    const cwd = this.options.cwd;

    const ctx: TurnContext = {
      prompt,
      turn: this.#turnCount,
      cwd,
      state: this.#state,
      hasMcp: this.#hasMcp,
      sleep,
      writeFile: (relativePath, content) =>
        tool(
          { toolName: 'Write', kind: 'edit', inputSummary: relativePath, durationMs: 600 },
          async () => {
            if (!this.realFiles) return;
            const file = join(cwd, relativePath);
            await mkdir(dirname(file), { recursive: true });
            await writeFile(file, content);
          },
        ),
      commit: async (message) => {
        if (!this.realFiles || !(await stat(join(cwd, '.git')).catch(() => null))) return;
        await tool(
          { toolName: 'Bash', kind: 'execute', inputSummary: 'git commit', durationMs: 300 },
          async () => {
            const git = (...args: string[]) =>
              execFileAsync('git', args, { cwd, windowsHide: true });
            await git('add', '-A');
            await git(
              '-c',
              'user.name=agentcats mock',
              '-c',
              'user.email=mock@agentcats.local',
              'commit',
              '-q',
              '-m',
              message,
            );
          },
        );
      },
      callTool: async (name, args) => {
        const client = await this.#mcpClient();
        const result = await client.callTool({ name, arguments: args });
        const content = result.content as { type: string; text?: string }[];
        const text = content.find((c) => c.type === 'text')?.text ?? 'null';
        if (result.isError) throw new Error(`MCP tool ${name} failed: ${text}`);
        return JSON.parse(text) as unknown;
      },
      say: async (text, channel = 'text') => {
        const messageId = this.#id('msg');
        for (const chunk of chunkWords(text, 4)) {
          await sleep(150);
          this.#emit({ type: 'message.chunk', messageId, channel, text: chunk });
        }
      },
      tool: (spec: ToolSpec) => tool(spec),
      requestApproval: (spec) => {
        const requestId = this.#id('approval');
        this.#emit({ type: 'approval.requested', requestId, toolCallId: null, ...spec });
        return new Promise<ApprovalDecision>((resolve, reject) => {
          this.#pendingApprovals.set(requestId, resolve);
          signal.addEventListener(
            'abort',
            () => {
              reject(new TurnAborted());
            },
            { once: true },
          );
        });
      },
      addUsage: (inputTokens, outputTokens) => {
        const usage = this.#usage;
        usage.inputTokens += inputTokens;
        usage.outputTokens += outputTokens;
        usage.costUsd =
          usage.inputTokens * ESTIMATED_USD_PER_INPUT_TOKEN +
          usage.outputTokens * ESTIMATED_USD_PER_OUTPUT_TOKEN;
        this.#emit({ type: 'usage', usage: { ...usage } });
      },
      emit: (event) => {
        this.#emit(event);
      },
    };
    return ctx;
  }

  get #hasMcp(): boolean {
    return this.options.mcpServers?.['agentcats'] !== undefined;
  }

  /** Connect to the agentcats MCP server on first use, like a real agent would. */
  #mcpClient(): Promise<Client> {
    const spec = this.options.mcpServers?.['agentcats'];
    if (spec?.type !== 'http') {
      return Promise.reject(new Error('This session was not given the agentcats MCP server'));
    }
    this.#mcp ??= (async () => {
      const client = new Client({ name: 'agentcats-mock', version: '0.0.0' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(spec.url), {
          requestInit: { headers: { ...spec.headers } },
        }),
      );
      return client;
    })();
    return this.#mcp;
  }

  #end(reason: 'exited' | 'killed' | 'crashed', exitCode: number | null): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#emit({ type: 'session.ended', reason, exitCode });
    this.#queue.close();
    void this.#mcp?.then((client) => client.close()).catch(() => undefined);
  }

  #emit(event: AgentEvent): void {
    if (event.type === 'tool.started') this.#openTools.add(event.toolCallId);
    if (event.type === 'tool.finished') this.#openTools.delete(event.toolCallId);
    this.#queue.push(event);
  }

  #id(prefix: string): string {
    this.#nextId += 1;
    return `${prefix}-${String(this.#nextId)}`;
  }
}

/** Split text into chunks of `size` words, keeping the spaces. */
function chunkWords(text: string, size: number): string[] {
  const words = text.split(/(?<= )/);
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += size) chunks.push(words.slice(i, i + size).join(''));
  return chunks;
}
