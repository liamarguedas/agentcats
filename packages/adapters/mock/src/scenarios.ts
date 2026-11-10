import { createHash } from 'node:crypto';

import type { ApprovalDecision, ToolKind } from '@agentcats/protocol';
import type { AgentEvent, StopReason } from '@agentcats/protocol/adapter';

/** What a scenario can do during one turn. Provided by the mock session. */
export interface TurnContext {
  /** The text passed to `Session.send`. */
  readonly prompt: string;
  /** 1 for the first turn of the session. */
  readonly turn: number;
  /** The session's working directory (a worktree, for workers). */
  readonly cwd: string;
  /** State that lives as long as the session. */
  readonly state: Map<string, unknown>;
  /** Whether the session was given the agentcats MCP server (it is the orchestrator). */
  readonly hasMcp: boolean;
  /**
   * Wait, scaled by the adapter's `timeScale`. `Infinity` waits until
   * interrupted. Rejects when the turn is interrupted.
   */
  sleep(ms: number): Promise<void>;
  /** Stream `text` as a few chunks of one message. */
  say(text: string, channel?: 'text' | 'thought'): Promise<void>;
  /** Run a tool: emits `tool.started`, waits, emits `tool.finished`. */
  tool(spec: ToolSpec): Promise<void>;
  /** Write a file under `cwd` (for real only with `realFiles`), shown as a Write tool call. */
  writeFile(relativePath: string, content: string): Promise<void>;
  /**
   * Commit everything in `cwd`, shown as a Bash tool call. Real only with
   * `realFiles`, and only when `cwd` is a git work tree.
   */
  commit(message: string): Promise<void>;
  /** Call a tool on the agentcats MCP server and return its JSON result. */
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  /** Ask for an approval and wait for the answer. */
  requestApproval(spec: Omit<ToolSpec, 'durationMs' | 'fails'>): Promise<ApprovalDecision>;
  /** Add to the session's cumulative usage and emit it. */
  addUsage(inputTokens: number, outputTokens: number): void;
  /** Emit any event directly. */
  emit(event: AgentEvent): void;
}

export interface ToolSpec {
  readonly toolName: string;
  readonly kind: ToolKind;
  readonly inputSummary: string;
  readonly durationMs?: number;
  readonly fails?: boolean;
}

export interface Scenario {
  readonly name: string;
  readonly description: string;
  /** Play one turn. The returned reason ends the turn. Throwing crashes the session. */
  turn(ctx: TurnContext): Promise<StopReason>;
}

/** Thrown by a scenario to simulate the agent process dying mid-turn. */
export class SimulatedCrash extends Error {
  override readonly name = 'SimulatedCrash';
}

const shortHash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 8);

/** The structured summary the worker prompt asks for. */
const workerSummary = (changed: string, tests: 'passed' | 'failed' | 'not run') =>
  `## Summary\n- Changed: ${changed}\n- Tests: ${tests}\n- Open issues: none`;

const happyPath: Scenario = {
  name: 'happy-path',
  description: 'Reads, writes and commits a file in its worktree, runs tests, reports success.',
  async turn(ctx) {
    await ctx.say('I will look at the project, make the change, and run the tests.', 'thought');
    await ctx.tool({ toolName: 'Read', kind: 'read', inputSummary: 'README.md' });
    ctx.addUsage(1_800, 120);
    const file = `mock-output/${shortHash(ctx.prompt)}.md`;
    await ctx.writeFile(file, `# Work for\n\n${ctx.prompt}\n`);
    await ctx.tool({
      toolName: 'Bash',
      kind: 'execute',
      inputSummary: 'npm test',
      durationMs: 1_200,
    });
    await ctx.commit(`mock: ${ctx.prompt.split('\n', 1)[0] ?? 'work'}`);
    ctx.addUsage(600, 340);
    await ctx.say(workerSummary(file, 'passed'));
    return 'end_turn';
  },
};

const approval: Scenario = {
  name: 'approval',
  description: 'Edits a file, then asks to run a shell command and respects the answer.',
  async turn(ctx) {
    await ctx.say('I will add the function and then run the tests.', 'thought');
    await ctx.tool({ toolName: 'Edit', kind: 'edit', inputSummary: 'src/hello.ts' });
    ctx.addUsage(1_500, 200);
    const decision = await ctx.requestApproval({
      toolName: 'Bash',
      kind: 'execute',
      inputSummary: 'npm test',
    });
    if (decision === 'allow') {
      await ctx.tool({ toolName: 'Bash', kind: 'execute', inputSummary: 'npm test' });
      await ctx.say('Done. The function is in place and the tests pass.');
    } else {
      await ctx.say('Understood, I did not run the tests. The function is in place.');
    }
    ctx.addUsage(400, 90);
    return 'end_turn';
  },
};

const network: Scenario = {
  name: 'network',
  description: 'Asks to fetch a URL. Fetches only if allowed.',
  async turn(ctx) {
    await ctx.say('I need the API docs first.', 'thought');
    const decision = await ctx.requestApproval({
      toolName: 'WebFetch',
      kind: 'fetch',
      inputSummary: 'https://example.com/api-docs',
    });
    if (decision === 'allow') {
      await ctx.tool({
        toolName: 'WebFetch',
        kind: 'fetch',
        inputSummary: 'https://example.com/api-docs',
      });
    }
    ctx.addUsage(500, 80);
    await ctx.say(
      workerSummary(
        decision === 'allow' ? 'read the docs' : 'nothing, the fetch was denied',
        'not run',
      ),
    );
    return 'end_turn';
  },
};

const error: Scenario = {
  name: 'error',
  description: 'A tool fails, then the turn ends with an error.',
  async turn(ctx) {
    await ctx.say('Running the build first.', 'thought');
    await ctx.tool({
      toolName: 'Bash',
      kind: 'execute',
      inputSummary: 'npm run build',
      fails: true,
    });
    ctx.addUsage(900, 60);
    ctx.emit({
      type: 'error',
      message: 'Build failed: cannot find module "./hello"',
      fatal: false,
    });
    return 'error';
  },
};

const crash: Scenario = {
  name: 'crash',
  description: 'The agent process dies in the middle of a tool call, every time.',
  async turn(ctx) {
    await ctx.say('Starting work.', 'thought');
    ctx.emit({
      type: 'tool.started',
      toolCallId: `crash-${String(ctx.turn)}`,
      toolName: 'Write',
      kind: 'edit',
      inputSummary: 'src/hello.ts',
    });
    await ctx.sleep(300);
    throw new SimulatedCrash('mock agent crashed');
  },
};

const flaky: Scenario = {
  name: 'flaky',
  description: 'Crashes on the first attempt, succeeds when told it is a retry.',
  async turn(ctx) {
    if (!/previous attempt/i.test(ctx.prompt)) return crash.turn(ctx);
    return happyPath.turn(ctx);
  },
};

const hang: Scenario = {
  name: 'hang',
  description: 'Starts a long tool call and never finishes. For stuck, kill and interrupt tests.',
  async turn(ctx) {
    await ctx.say('This will take a while.', 'thought');
    await ctx.tool({
      toolName: 'Bash',
      kind: 'execute',
      inputSummary: 'sleep infinity',
      durationMs: Number.POSITIVE_INFINITY,
    });
    return 'end_turn';
  },
};

const expensive: Scenario = {
  name: 'expensive',
  description: 'Spends tokens steadily, for budget tests.',
  async turn(ctx) {
    for (let i = 0; i < 20; i++) {
      await ctx.tool({ toolName: 'Read', kind: 'read', inputSummary: `src/file-${String(i)}.ts` });
      ctx.addUsage(20_000, 2_000);
    }
    await ctx.say(workerSummary('read a lot', 'not run'));
    return 'end_turn';
  },
};

interface TaskView {
  readonly id: string;
  readonly title: string;
  readonly status: string;
}

/**
 * The orchestrator. On a user request it splits the work into an
 * implementation task and a test task (one task for `/single`), passing the
 * request text on so scenario lines reach the workers. When the daemon
 * reports a finished task it reads the result and tells the user.
 */
const orchestrator: Scenario = {
  name: 'orchestrator',
  description: 'Delegates through the agentcats MCP tools and reports results.',
  async turn(ctx) {
    if (ctx.prompt.startsWith('[agentcats]')) {
      const { tasks } = (await ctx.callTool('list_tasks', {})) as { tasks: TaskView[] };
      const reported = (ctx.state.get('reported') as Set<string> | undefined) ?? new Set<string>();
      ctx.state.set('reported', reported);
      const lines: string[] = [];
      for (const task of tasks) {
        if (reported.has(task.id) || !['review', 'failed'].includes(task.status)) continue;
        reported.add(task.id);
        if (task.status === 'failed') {
          lines.push(`- "${task.title}" failed.`);
          continue;
        }
        const result = (await ctx.callTool('get_task_result', { task_id: task.id })) as {
          branch: string;
          diffStat: { files: number };
        };
        lines.push(
          `- "${task.title}" is ready for review on \`${result.branch}\` (${String(result.diffStat.files)} files).`,
        );
      }
      ctx.addUsage(400, 60);
      if (lines.length > 0) await ctx.say(`Update:\n${lines.join('\n')}`);
      return 'end_turn';
    }

    await ctx.say('Let me split this into independent pieces of work.', 'thought');
    await ctx.callTool('list_cats', {});
    const request = ctx.prompt.trim();
    const headline = request.split('\n', 1)[0] ?? request;
    const titles = /^\/single\b/m.test(request)
      ? [headline]
      : [`Implement: ${headline}`, `Write tests: ${headline}`];
    const assigned: string[] = [];
    for (const title of titles) {
      const { task_id } = (await ctx.callTool('assign_task', {
        title: title.slice(0, 200),
        description: request,
      })) as { task_id: string };
      assigned.push(task_id);
    }
    ctx.addUsage(1_200, 150);
    await ctx.say(
      `I assigned ${String(assigned.length)} task${assigned.length === 1 ? '' : 's'} to workers. I will report back when they are ready for review.`,
    );
    return 'end_turn';
  },
};

export const SCENARIOS: Readonly<Record<string, Scenario>> = Object.fromEntries(
  [happyPath, approval, network, error, crash, flaky, hang, expensive, orchestrator].map((s) => [
    s.name,
    s,
  ]),
);

/**
 * The built-in scenario a prompt asks for: the first line of the form
 * `/name` (optionally followed by more text) naming a known scenario.
 */
export function scenarioForPrompt(prompt: string): Scenario | undefined {
  for (const match of prompt.matchAll(/^\/([a-z-]+)(?=\s|$)/gm)) {
    const scenario = SCENARIOS[match[1] ?? ''];
    if (scenario && scenario.name !== 'orchestrator') return scenario;
  }
  return undefined;
}
