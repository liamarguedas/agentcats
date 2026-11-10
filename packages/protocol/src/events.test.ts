import { describe, expect, it } from 'vitest';

import { AgentcatsEvent, EVENT_TYPES } from './events.js';
import { sampleEvents } from './fixtures.test-util.js';

describe('AgentcatsEvent', () => {
  it('defines exactly the M0 event types', () => {
    expect([...EVENT_TYPES].sort()).toEqual(
      [
        'approval.requested',
        'approval.resolved',
        'cat.created',
        'cat.status_changed',
        'daemon.error',
        'message.agent',
        'task.created',
        'task.updated',
        'tool.called',
        'usage.updated',
      ].sort(),
    );
  });

  it.each(Object.entries(sampleEvents))('accepts a valid %s sample', (_type, sample) => {
    expect(AgentcatsEvent.parse(sample)).toEqual(sample);
  });

  it('rejects an unknown event type', () => {
    const bad = { ...sampleEvents['daemon.error'], type: 'daemon.exploded' };
    expect(AgentcatsEvent.safeParse(bad).success).toBe(false);
  });

  it.each(['cat.created', 'cat.status_changed', 'tool.called', 'usage.updated'] as const)(
    'requires catId on %s',
    (type) => {
      const { catId: _catId, ...withoutCat } = sampleEvents[type];
      expect(AgentcatsEvent.safeParse(withoutCat).success).toBe(false);
    },
  );

  it.each(['task.created', 'task.updated'] as const)('requires taskId on %s', (type) => {
    const { taskId: _taskId, ...withoutTask } = sampleEvents[type];
    expect(AgentcatsEvent.safeParse(withoutTask).success).toBe(false);
  });

  it('rejects seq 0 and fractional seq', () => {
    const base = sampleEvents['daemon.error'];
    expect(AgentcatsEvent.safeParse({ ...base, seq: 0 }).success).toBe(false);
    expect(AgentcatsEvent.safeParse({ ...base, seq: 1.5 }).success).toBe(false);
  });

  it('rejects unknown fields in envelope and payload', () => {
    const base = sampleEvents['cat.status_changed'];
    expect(AgentcatsEvent.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(
      AgentcatsEvent.safeParse({ ...base, payload: { ...base.payload, mood: 'grumpy' } }).success,
    ).toBe(false);
  });

  it('rejects an invalid cat status', () => {
    const base = sampleEvents['cat.status_changed'];
    const bad = { ...base, payload: { status: 'napping', reason: null } };
    expect(AgentcatsEvent.safeParse(bad).success).toBe(false);
  });

  it('rejects a task.updated that changes nothing', () => {
    const bad = { ...sampleEvents['task.updated'], payload: {} };
    expect(AgentcatsEvent.safeParse(bad).success).toBe(false);
  });

  it('accepts unknown cost but rejects negative token counts', () => {
    const base = sampleEvents['usage.updated'];
    expect(
      AgentcatsEvent.safeParse({
        ...base,
        payload: { ...base.payload, costUsd: null, costSource: 'unknown' },
      }).success,
    ).toBe(true);
    expect(
      AgentcatsEvent.safeParse({ ...base, payload: { ...base.payload, inputTokens: -1 } }).success,
    ).toBe(false);
  });

  it('rejects an approval decision other than allow or deny', () => {
    const base = sampleEvents['approval.resolved'];
    const bad = { ...base, payload: { ...base.payload, decision: 'maybe' } };
    expect(AgentcatsEvent.safeParse(bad).success).toBe(false);
  });
});
