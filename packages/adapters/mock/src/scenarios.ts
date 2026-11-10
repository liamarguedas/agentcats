import type { AgentEvent, StopReason } from '@agentcats/protocol/adapter';
import type { ApprovalDecision, ToolKind } from '@agentcats/protocol';

/** What a scenario can do during one turn. Provided by the mock session. */
export interface TurnContext {
  /** The text passed to `Session.send`. */
  readonly prompt: string;
  /** 1 for the first turn of the session. */
  readonly turn: number;
  /** Wait, scaled by the adapter's `timeScale`. `Infinity` waits until interrupted. Rejects when the turn is interrupted. */
  sleep(ms: number): Promise<void>;
  /** Stream `text` as a few chunks of one message. */
  say(text: string, channel?: 'text' | 'thought'): Promise<void>;
  /** Run a tool: emits `tool.started`, waits, emits `tool.finished`. */
  tool(spec: ToolSpec): Promise<void>;
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

const happyPath: Scenario = {
  name: 'happy-path',
  description: 'Thinks, reads a file, writes a file, reports success.',
  async turn(ctx) {
    await ctx.say('The user wants a hello function. I will look at the project first.', 'thought');
    await ctx.tool({ toolName: 'Read', kind: 'read', inputSummary: 'src/index.ts' });
    ctx.addUsage(1_800, 120);
    await ctx.say('There is no hello function yet. I will add one in src/hello.ts.', 'thought');
    await ctx.tool({
      toolName: 'Write',
      kind: 'edit',
      inputSummary: 'src/hello.ts',
      durationMs: 1_500,
    });
    ctx.addUsage(600, 340);
    await ctx.say('Added `hello(name)` in src/hello.ts. It returns "Hello, <name>!".');
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
  description: 'The agent process dies in the middle of a tool call.',
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

const hang: Scenario = {
  name: 'hang',
  description: 'Starts a long tool call and never finishes. For kill and interrupt tests.',
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

export const SCENARIOS: Readonly<Record<string, Scenario>> = Object.fromEntries(
  [happyPath, approval, error, crash, hang].map((s) => [s.name, s]),
);
