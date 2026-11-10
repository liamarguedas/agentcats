import { describe, expect, it } from 'vitest';

import { sampleEvents, sampleLog } from './fixtures.test-util.js';
import { applyEvent, BoardState, classifySeq, emptyBoard } from './projection.js';

const replay = (events = sampleLog) => events.reduce(applyEvent, emptyBoard());

describe('applyEvent', () => {
  it('projects the sample log into a valid board', () => {
    const board = replay();

    expect(BoardState.parse(board)).toEqual(board);
    expect(board.lastSeq).toBe(10);
    expect(board.cats['cat-1']).toMatchObject({
      name: 'Mochi',
      status: 'thinking',
      createdAt: 1_000,
    });
    expect(board.tasks['task-1']).toMatchObject({
      status: 'running',
      assigneeCatId: 'cat-1',
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

  it('only overwrites task fields present in task.updated', () => {
    const base = replay();
    const next = applyEvent(base, {
      ...sampleEvents['task.updated'],
      seq: 11,
      ts: 11_000,
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
