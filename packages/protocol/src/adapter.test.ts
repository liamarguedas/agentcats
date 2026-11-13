import { describe, expect, it } from 'vitest';

import {
  type Adapter,
  AdapterError,
  AgentEvent,
  checkSessionInvariants,
  type Session,
} from './adapter.js';

const usage = (outputTokens: number, costUsd: number | null = null) => ({
  type: 'usage' as const,
  usage: {
    inputTokens: 10,
    outputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd,
    costSource: costUsd === null ? ('unknown' as const) : ('reported' as const),
    activeMs: 0,
  },
});

const started: AgentEvent = {
  type: 'session.started',
  resumeId: 'r1',
  model: 'some-model',
  agentVersion: '1.0.0',
  billing: 'metered',
};
const ended: AgentEvent = { type: 'session.ended', reason: 'killed', exitCode: null };

/** A complete, valid session: one turn with a tool call, an approval and usage. */
const validSession: AgentEvent[] = [
  started,
  { type: 'turn.started' },
  { type: 'message.chunk', messageId: 'm1', channel: 'thought', text: 'Plan: write a file.' },
  {
    type: 'tool.started',
    toolCallId: 't1',
    toolName: 'Write',
    kind: 'edit',
    inputSummary: 'src/hello.ts',
  },
  {
    type: 'approval.requested',
    requestId: 'a1',
    toolCallId: 't1',
    toolName: 'Write',
    kind: 'edit',
    inputSummary: 'src/hello.ts',
  },
  { type: 'tool.finished', toolCallId: 't1', status: 'success', outputSummary: null },
  usage(5, 0.001),
  { type: 'message.chunk', messageId: 'm2', channel: 'text', text: 'Done.' },
  usage(9, 0.002),
  { type: 'turn.ended', stopReason: 'end_turn' },
  { type: 'error', message: 'transient retry', fatal: false },
  ended,
];

describe('AgentEvent', () => {
  it.each(validSession.map((e) => [e.type, e] as const))('accepts a valid %s', (_type, event) => {
    expect(AgentEvent.parse(event)).toEqual(event);
  });

  it('rejects agent-specific extra fields', () => {
    const bad = { type: 'turn.started', claudeSessionId: 'x' };
    expect(AgentEvent.safeParse(bad).success).toBe(false);
  });

  it('rejects an unknown stop reason and tool kind', () => {
    expect(AgentEvent.safeParse({ type: 'turn.ended', stopReason: 'tired' }).success).toBe(false);
    expect(AgentEvent.safeParse({ ...validSession[3], kind: 'browse' }).success).toBe(false);
  });
});

describe('checkSessionInvariants', () => {
  it('accepts a valid session', () => {
    expect(checkSessionInvariants(validSession)).toEqual([]);
  });

  it('requires session.started first and session.ended last', () => {
    expect(checkSessionInvariants(validSession.slice(1, -1))).toEqual([
      '#0 first event must be session.started',
      '#9 last event must be session.ended',
    ]);
  });

  it('flags overlapping turns and unmatched turn ends', () => {
    const events: AgentEvent[] = [
      started,
      { type: 'turn.started' },
      { type: 'turn.started' },
      { type: 'turn.ended', stopReason: 'end_turn' },
      { type: 'turn.ended', stopReason: 'end_turn' },
      ended,
    ];
    expect(checkSessionInvariants(events)).toEqual([
      '#2 turn.started while a turn is running',
      '#4 turn.ended without turn.started',
    ]);
  });

  it('flags a tool still running when its turn ends', () => {
    const events = validSession.filter((e) => e.type !== 'tool.finished');
    expect(checkSessionInvariants(events)).toContain('#8 turn ended with tool t1 still running');
  });

  it('flags a session that ends mid-turn', () => {
    const events = validSession.filter((e) => e.type !== 'turn.ended');
    expect(checkSessionInvariants(events)).toContain(
      '#10 session ended inside a turn without turn.ended',
    );
  });

  it('flags decreasing usage', () => {
    const events = [...validSession];
    events.splice(9, 0, usage(3, 0.0015));
    expect(checkSessionInvariants(events)).toEqual([
      '#9 usage.outputTokens decreased',
      '#9 usage.costUsd decreased',
    ]);
  });
});

describe('Adapter interface', () => {
  it('can be implemented without agent-specific types', async () => {
    // Compile-time check that the interface is implementable as written.
    const session: Session = {
      id: 's1',
      pid: null,
      send: () => Promise.reject(new AdapterError('closed', 'ended')),
      events: async function* () {
        for (const event of validSession) yield await Promise.resolve(event);
      },
      approve: () => Promise.resolve(),
      interrupt: () => Promise.resolve(),
      kill: () => Promise.resolve(),
    };
    const adapter: Adapter = {
      id: 'fake',
      displayName: 'Fake',
      capabilities: {
        mcp: false,
        approvals: true,
        resume: false,
        reportsCost: false,
        modelSelection: false,
        interrupt: true,
        permissionModes: ['ask'],
        policyEnforcement: 'none',
        complete: true,
      },
      modelTiers: { fast: null, balanced: null, best: null },
      estimateUsd: () => null,
      complete: () =>
        Promise.resolve({
          text: 'none',
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costUsd: null,
            costSource: 'unknown',
            activeMs: 0,
          },
        }),
      spawn: () => Promise.resolve(session),
    };

    const spawned = await adapter.spawn({
      catId: 'cat-1',
      cwd: '.',
      model: null,
      systemPrompt: null,
      permissionMode: 'ask',
    });
    await expect(spawned.send('hi')).rejects.toMatchObject({ code: 'closed' });
    const seen: AgentEvent[] = [];
    for await (const event of spawned.events()) seen.push(event);
    expect(checkSessionInvariants(seen)).toEqual([]);
  });
});
