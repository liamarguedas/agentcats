import type { Cat } from '@agentcats/protocol';
import { describe, expect, it } from 'vitest';

import { areaOf, layoutFor, needsYou, placeCats } from './Office.js';

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

  it('lays out zones that never overlap, for any team up to 16', () => {
    const apart = (
      a: { x: number; y: number; width: number; height: number },
      b: { x: number; y: number; width: number; height: number },
    ) =>
      a.x + a.width <= b.x ||
      b.x + b.width <= a.x ||
      a.y + a.height <= b.y ||
      b.y + b.height <= a.y;
    for (let workers = 0; workers <= 16; workers++) {
      for (let meeting = 0; meeting <= workers; meeting += 3) {
        const layout = layoutFor(workers, meeting, workers - meeting);
        expect(apart(layout.whiteboard, layout.desks)).toBe(true);
        expect(apart(layout.whiteboard, layout.meeting)).toBe(true);
        expect(apart(layout.desks, layout.meeting)).toBe(true);
        expect(layout.deskCount).toBeGreaterThanOrEqual(workers);
        expect(layout.tables * 2).toBeGreaterThanOrEqual(meeting);
      }
    }
  });

  it('grows the whiteboard only by the rows of cats waiting at it', () => {
    expect(layoutFor(16, 0, 0).whiteboard.height).toBe(layoutFor(16, 0, 5).whiteboard.height);
    expect(layoutFor(16, 0, 16).whiteboard.height).toBeGreaterThan(
      layoutFor(16, 0, 5).whiteboard.height,
    );
  });

  it('gives every cat its own spot, 16 workers included', () => {
    const team = Array.from({ length: 16 }, (_, i) =>
      cat(String(i), (['working', 'idle', 'waiting_approval', 'error'] as const)[i % 4]!),
    );
    const spots = [...placeCats(cat('l', 'idle', 'orchestrator'), team).values()];
    expect(new Set(spots.map((s) => `${String(s.x)},${String(s.y)}`)).size).toBe(17);
  });

  it('counts the cats that need you', () => {
    expect(needsYou(cat('a', 'waiting_approval'))).toBe(true);
    expect(needsYou(cat('a', 'error'))).toBe(true);
    expect(needsYou(cat('a', 'working', 'worker', true))).toBe(true);
    expect(needsYou(cat('l', 'waiting_approval', 'orchestrator'))).toBe(true);
    expect(needsYou(cat('a', 'working'))).toBe(false);
    expect(needsYou(cat('c', 'error', 'candidate'))).toBe(false);
  });
});
