import type { Cat } from '@agentcats/protocol';
import { describe, expect, it } from 'vitest';

import { areaOf, placeCats } from './Office.js';

const cat = (id: string, status: Cat['status'], role: Cat['role'] = 'worker', paused = false) =>
  ({ id, role, status, pausedReason: paused ? 'user' : null }) as Cat;

describe('the office', () => {
  it('sends each cat where its status belongs', () => {
    expect(areaOf(cat('l', 'working', 'orchestrator'))).toBe('whiteboard');
    expect(areaOf(cat('a', 'working'))).toBe('desks');
    expect(areaOf(cat('a', 'thinking'))).toBe('desks');
    expect(areaOf(cat('a', 'waiting_approval'))).toBe('meeting');
    expect(areaOf(cat('a', 'error'))).toBe('meeting');
    expect(areaOf(cat('a', 'working', 'worker', true))).toBe('meeting');
    expect(areaOf(cat('a', 'idle'))).toBe('whiteboard');
    expect(areaOf(cat('a', 'done'))).toBe('whiteboard');
  });

  it('keeps a worker at its own desk while others come and go', () => {
    const team = [cat('a', 'working'), cat('b', 'idle'), cat('c', 'working')];
    const before = placeCats(cat('l', 'idle', 'orchestrator'), team);
    const after = placeCats(cat('l', 'idle', 'orchestrator'), [
      cat('a', 'working'),
      cat('b', 'working'),
      cat('c', 'working'),
    ]);
    expect(after.get('a')).toEqual(before.get('a'));
    expect(after.get('c')).toEqual(before.get('c'));
    expect(new Set([...after.values()].map((s) => `${String(s.x)},${String(s.y)}`)).size).toBe(4);
  });
});
