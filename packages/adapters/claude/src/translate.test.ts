import {
  type AgentEvent,
  AgentEvent as AgentEventSchema,
  checkSessionInvariants,
} from '@agentcats/protocol/adapter';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { billingOf, summarizeInput, toolKind, Translator } from './translate.js';

// Minimal SDK message fixtures. Only the fields the translator reads are set.
const assistant = (id: string, content: unknown[], parent: string | null = null) =>
  ({
    type: 'assistant',
    parent_tool_use_id: parent,
    message: { id, content },
  }) as unknown as SDKMessage;

const toolResult = (toolUseId: string, isError = false, parent: string | null = null) =>
  ({
    type: 'user',
    parent_tool_use_id: parent,
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: toolUseId, is_error: isError, content: 'boom' },
      ],
    },
  }) as unknown as SDKMessage;

const result = (overrides: Record<string, unknown> = {}) =>
  ({
    type: 'result',
    subtype: 'success',
    is_error: false,
    stop_reason: 'end_turn',
    result: 'Done',
    total_cost_usd: 0.02,
    modelUsage: {
      'model-a': {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 1000,
        cacheCreationInputTokens: 200,
      },
    },
    ...overrides,
  }) as unknown as SDKMessage;

function run(messages: SDKMessage[]): AgentEvent[] {
  const translator = new Translator();
  return messages.flatMap((m) => translator.handle(m));
}

describe('Translator', () => {
  it('maps a turn with a tool call into a valid normalized stream', () => {
    const events = run([
      assistant('msg_1', [
        { type: 'thinking', thinking: 'Need a hello function.' },
        { type: 'text', text: 'Adding it now.' },
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'Write',
          input: { file_path: 'src/hello.ts', content: 'x' },
        },
      ]),
      toolResult('toolu_1'),
      assistant('msg_2', [{ type: 'text', text: 'Done.' }]),
      result(),
    ]);

    for (const event of events) expect(AgentEventSchema.parse(event)).toEqual(event);
    expect(events.map((e) => e.type)).toEqual([
      'message.chunk',
      'message.chunk',
      'tool.started',
      'tool.finished',
      'message.chunk',
      'usage',
      'turn.ended',
    ]);
    expect(events[0]).toMatchObject({ channel: 'thought' });
    expect(events[2]).toMatchObject({
      toolName: 'Write',
      kind: 'edit',
      inputSummary: 'src/hello.ts',
    });
    expect(events.at(-1)).toEqual({ type: 'turn.ended', stopReason: 'end_turn' });

    const stream: AgentEvent[] = [
      {
        type: 'session.started',
        resumeId: 'r',
        model: null,
        agentVersion: '2.1.302',
        billing: 'subscription',
      },
      { type: 'turn.started' },
      ...events,
      { type: 'session.ended', reason: 'killed', exitCode: null },
    ];
    expect(checkSessionInvariants(stream)).toEqual([]);
  });

  it('reports cumulative usage from modelUsage and total_cost_usd without summing turns', () => {
    const translator = new Translator();
    translator.handle(result());
    const second = translator.handle(
      result({
        total_cost_usd: 0.05,
        modelUsage: {
          'model-a': {
            inputTokens: 300,
            outputTokens: 90,
            cacheReadInputTokens: 2000,
            cacheCreationInputTokens: 200,
          },
          'model-b': {
            inputTokens: 10,
            outputTokens: 5,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
        },
      }),
    );
    expect(second[0]).toEqual({
      type: 'usage',
      usage: {
        inputTokens: 310,
        outputTokens: 95,
        cacheReadTokens: 2000,
        cacheWriteTokens: 200,
        costUsd: 0.05,
        costSource: 'reported',
      },
    });
  });

  it('never lets usage go backwards, for example after a /clear', () => {
    const translator = new Translator();
    translator.handle(result({ total_cost_usd: 0.05 }));
    const after = translator.handle(result({ total_cost_usd: 0.0, modelUsage: {} }));
    expect(after[0]).toMatchObject({ usage: { costUsd: 0.05, inputTokens: 100 } });
  });

  it('marks failed tool results and closes tools left open at the end of a turn', () => {
    const events = run([
      assistant('m', [
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } },
        { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'a.ts' } },
      ]),
      toolResult('t1', true),
      result({ subtype: 'error_during_execution', is_error: true, errors: ['aborted'] }),
    ]);
    expect(events.filter((e) => e.type === 'tool.finished')).toEqual([
      { type: 'tool.finished', toolCallId: 't1', status: 'error', outputSummary: 'boom' },
      { type: 'tool.finished', toolCallId: 't2', status: 'error', outputSummary: null },
    ]);
    expect(events).toContainEqual({ type: 'error', message: 'aborted', fatal: false });
    expect(events.at(-1)).toEqual({ type: 'turn.ended', stopReason: 'error' });
  });

  it('reports an interrupted turn as cancelled without an error', () => {
    const translator = new Translator();
    const events = translator.handle(
      result({ subtype: 'error_during_execution', is_error: true }),
      true,
    );
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.at(-1)).toEqual({ type: 'turn.ended', stopReason: 'cancelled' });
  });

  it.each([
    [{ subtype: 'error_max_turns', is_error: true }, 'max_turns'],
    [{ stop_reason: 'refusal' }, 'refusal'],
    [{ stop_reason: 'max_tokens' }, 'max_tokens'],
    [{ is_error: true, result: 'API Error: 529 overloaded' }, 'error'],
  ])('maps result %o to stop reason %s', (overrides, stopReason) => {
    expect(run([result(overrides)]).at(-1)).toEqual({ type: 'turn.ended', stopReason });
  });

  it('ignores subagent frames', () => {
    const events = run([
      assistant('sub', [{ type: 'tool_use', id: 'inner', name: 'Read', input: {} }], 'toolu_task'),
      toolResult('inner', false, 'toolu_task'),
    ]);
    expect(events).toEqual([]);
  });

  it('surfaces an assistant API error as a non-fatal error', () => {
    const message = {
      ...(assistant('m', []) as object),
      error: 'rate_limit',
    } as unknown as SDKMessage;
    expect(run([message])).toEqual([
      { type: 'error', message: 'Claude API error: rate_limit', fatal: false },
    ]);
  });
});

describe('tool helpers', () => {
  it.each([
    ['Read', 'read'],
    ['Edit', 'edit'],
    ['Bash', 'execute'],
    ['Grep', 'search'],
    ['WebFetch', 'fetch'],
    ['mcp__agentcats__list_cats', 'other'],
  ] as const)('classifies %s as %s', (name, kind) => {
    expect(toolKind(name)).toBe(kind);
  });

  it('summarizes the most telling input field on one line', () => {
    expect(summarizeInput({ command: 'npm\n  test', description: 'Run tests' })).toBe('npm test');
    expect(summarizeInput({ description: 'Explore the repo' })).toBe('Explore the repo');
    expect(summarizeInput({ todos: [1] })).toBe('{"todos":[1]}');
    expect(summarizeInput({ file_path: 'x'.repeat(300) })).toHaveLength(200);
  });
});

describe('billingOf', () => {
  it.each([
    [{ apiProvider: 'firstParty', subscriptionType: 'Claude Pro' }, 'subscription'],
    [{ apiProvider: 'firstParty', apiKeySource: 'ANTHROPIC_API_KEY' }, 'metered'],
    [{ apiProvider: 'bedrock' }, 'metered'],
    [{ apiProvider: 'vertex' }, 'metered'],
    [
      { apiProvider: 'firstParty', apiKeySource: 'none', subscriptionType: 'Claude Max' },
      'subscription',
    ],
    [{}, 'unknown'],
    [null, 'unknown'],
  ] as const)('classifies %o as %s', (account, billing) => {
    expect(billingOf(account)).toBe(billing);
  });
});
