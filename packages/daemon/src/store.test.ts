import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { EventLog } from './event-log.js';
import { SqliteStore } from './store.js';

let dir = '';
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  dir = '';
});

const catCreated = {
  type: 'cat.created' as const,
  catId: 'cat-1',
  payload: {
    name: 'Mochi',
    role: 'worker' as const,
    adapter: 'mock',
    model: null,
    permissionMode: 'accept_edits' as const,
    budget: { maxUsd: 2, maxTokens: null },
  },
};

const taskCreated = (taskId: string) => ({
  type: 'task.created' as const,
  taskId,
  payload: {
    title: `Task ${taskId}`,
    description: '',
    status: 'queued' as const,
    assigneeCatId: null,
  },
});

describe('SqliteStore and EventLog', () => {
  it('rebuilds the board and continues seq after a restart', async () => {
    dir = await mkdtemp(join(tmpdir(), 'agentcats-store-'));
    const file = join(dir, 'agentcats.db');

    const first = new SqliteStore(file);
    const log = new EventLog(first);
    log.append(catCreated);
    log.append(taskCreated('t1'));
    log.append({
      type: 'task.updated',
      taskId: 't1',
      payload: { status: 'running', actor: 'system' },
    });
    first.setResumeId('t1', 'session-abc');
    first.close();

    const second = new SqliteStore(file);
    const reopened = new EventLog(second);
    expect(reopened.lastSeq).toBe(3);
    expect(reopened.board.tasks['t1']?.status).toBe('running');
    expect(reopened.board.cats['cat-1']?.name).toBe('Mochi');
    expect(reopened.recent().map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(second.resumeIdFor('t1')).toBe('session-abc');

    const next = reopened.append({ type: 'task.updated', taskId: 't1', payload: { summary: 'x' } });
    expect(next.seq).toBe(4);
    second.close();
  });

  it('writes an event before listeners see it', () => {
    const store = new SqliteStore(':memory:');
    const log = new EventLog(store);
    const seenInStore: number[] = [];
    log.subscribe(() => seenInStore.push(store.lastSeq()));
    log.append(catCreated);
    expect(seenInStore).toEqual([1]);
    store.close();
  });

  it('returns only the events of one task, in order', () => {
    const store = new SqliteStore(':memory:');
    const log = new EventLog(store);
    log.append(taskCreated('t1'));
    log.append(taskCreated('t2'));
    log.append({
      type: 'task.updated',
      taskId: 't1',
      payload: { status: 'running', actor: 'system' },
    });
    expect(log.taskEvents('t1').map((e) => e.seq)).toEqual([1, 3]);
    store.close();
  });

  it('clears a resume id', () => {
    const store = new SqliteStore(':memory:');
    store.setResumeId('t1', 'a');
    store.setResumeId('t1', 'b');
    expect(store.resumeIdFor('t1')).toBe('b');
    store.setResumeId('t1', null);
    expect(store.resumeIdFor('t1')).toBeNull();
    store.close();
  });

  it('rejects an invalid event without storing it', () => {
    const store = new SqliteStore(':memory:');
    const log = new EventLog(store);
    expect(() =>
      log.append({ ...catCreated, payload: { ...catCreated.payload, role: 'boss' } } as never),
    ).toThrow();
    expect(store.lastSeq()).toBe(0);
    store.close();
  });
});
