import { describe, expect, it } from 'vitest';

import { sampleEvents, sampleLog } from './fixtures.test-util.js';
import { applyEvent, BoardState, classifySeq, emptyBoard } from './projection.js';

const replay = (events = sampleLog) => events.reduce(applyEvent, emptyBoard());

describe('applyEvent', () => {
  it('projects the sample log into a valid board', () => {
    const board = replay();

    expect(BoardState.parse(board)).toEqual(board);
    expect(board.lastSeq).toBe(20);
    expect(board.cats['cat-1']).toMatchObject({
      name: 'Mochi',
      role: 'worker',
      status: 'thinking',
      billing: 'metered',
      budget: { maxUsd: 5, maxTokens: null },
      pausedReason: null,
      xp: 10,
      level: 2,
      learnings: [{ id: 'l1', text: 'Use the makeUser fixture in tests', sourceTaskId: 'task-1' }],
      createdAt: 1_000,
    });
    expect(board.proposals).toEqual({});
    expect(board.tasks['task-1']).toMatchObject({
      status: 'running',
      assigneeCatId: 'cat-1',
      attempt: 1,
      branch: null,
      result: null,
      updatedAt: 4_000,
    });
    expect(board.pendingApprovals).toEqual({});
    expect(board.usage['cat-1']?.outputTokens).toBe(300);
  });

  it('tracks an approval until it is resolved', () => {
    const upToRequest = sampleLog.filter((e) => e.seq <= 7);
    expect(replay(upToRequest).pendingApprovals['ap1']).toMatchObject({
      catId: 'cat-1',
      taskId: 'task-1',
      toolName: 'Bash',
      requestedAt: 7_000,
    });
  });

  it('tracks a learnings proposal until it is resolved', () => {
    const proposed = replay(sampleLog.filter((e) => e.seq <= 18));
    expect(proposed.proposals['p1']).toEqual({
      id: 'p1',
      catId: 'cat-1',
      taskId: 'task-1',
      kind: 'add',
      trigger: 'debrief',
      lines: [{ text: 'Use the makeUser fixture in tests', sourceTaskId: 'task-1' }],
      base: [],
      createdAt: 18_000,
    });
    expect(BoardState.parse(proposed)).toEqual(proposed);
  });

  it("counts a worker's completed, accepted and rejected results", () => {
    let seq = 20;
    const update = (taskId: string, status: 'review' | 'done' | 'rejected', actor?: 'user') =>
      ({
        ...sampleEvents['task.updated'],
        id: `u${String(++seq)}`,
        seq,
        ts: seq * 1_000,
        taskId,
        payload: { status, ...(actor && { actor }) },
      }) as const;
    const second = { ...sampleEvents['task.created'], id: 'c2', seq: 99, taskId: 'task-2' };
    const board = [
      second,
      update('task-1', 'review'),
      update('task-1', 'done', 'user'),
      update('task-2', 'review'),
      update('task-2', 'rejected', 'user'),
    ].reduce(applyEvent, replay());
    expect(board.cats['cat-1']?.stats).toEqual({ completed: 2, accepted: 1, rejected: 1 });
  });

  it('tracks a pause until it is resumed', () => {
    const paused = replay(sampleLog.filter((e) => e.seq <= 12));
    expect(paused.cats['cat-1']?.pausedReason).toBe('budget');
    expect(replay().cats['cat-1']?.pausedReason).toBeNull();
  });

  it('never stores the actor of a task update on the task', () => {
    const next = applyEvent(replay(), {
      ...sampleEvents['task.updated'],
      seq: 21,
      ts: 21_000,
      payload: { status: 'blocked', actor: 'user', reasonCode: 'paused', statusReason: 'Paused' },
    });
    expect(next.tasks['task-1']).toMatchObject({ status: 'blocked', reasonCode: 'paused' });
    expect(next.tasks['task-1']).not.toHaveProperty('actor');
    expect(BoardState.parse(next)).toEqual(next);
  });

  it('only overwrites task fields present in task.updated', () => {
    const base = replay();
    const next = applyEvent(base, {
      ...sampleEvents['task.updated'],
      seq: 16,
      ts: 16_000,
      payload: { summary: 'Added hello()' },
    });
    expect(next.tasks['task-1']).toMatchObject({ status: 'running', summary: 'Added hello()' });
  });

  it('ignores events about unknown cats and tasks', () => {
    const board = applyEvent(emptyBoard(), sampleEvents['cat.status_changed']);
    expect(board.cats).toEqual({});
    expect(board.lastSeq).toBe(3);
  });

  it('does not mutate its input', () => {
    const before = replay(sampleLog.slice(0, 2));
    const frozen = structuredClone(before);
    applyEvent(before, sampleEvents['cat.status_changed']);
    expect(before).toEqual(frozen);
  });
});

describe('classifySeq', () => {
  it('classifies next, duplicate and gap', () => {
    const board = replay(sampleLog.slice(0, 3));
    expect(classifySeq(board, sampleEvents['task.updated'])).toBe('next');
    expect(classifySeq(board, sampleEvents['cat.created'])).toBe('duplicate');
    expect(classifySeq(board, sampleEvents['tool.called'])).toBe('gap');
  });
});
