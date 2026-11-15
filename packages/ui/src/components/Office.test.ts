import type { Cat } from '@agentcats/protocol';
import { describe, expect, it } from 'vitest';

import { areaOf, crosses, layoutFor, needsYou, placeCats } from './Office.js';

const cat = (id: string, status: Cat['status'], role: Cat['role'] = 'worker', paused = false) =>
  ({ id, role, status, pausedReason: paused ? 'user' : null }) as Cat;

describe('the office', () => {
  it('sends each cat where its status belongs', () => {
    expect(areaOf(cat('l', 'working', 'orchestrator'))).toBe('office');
    expect(areaOf(cat('a', 'working'))).toBe('desks');
    expect(areaOf(cat('a', 'thinking'))).toBe('desks');
    expect(areaOf(cat('a', 'waiting_approval'))).toBe('meeting');
    expect(areaOf(cat('a', 'error'))).toBe('meeting');
    expect(areaOf(cat('a', 'working', 'worker', true))).toBe('meeting');
    expect(areaOf(cat('a', 'idle'))).toBe('lounge');
    expect(areaOf(cat('a', 'done'))).toBe('lounge');
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

  it('lays out rooms that never overlap, for any team up to 16', () => {
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
        const layout = layoutFor(workers, meeting, workers - meeting, workers);
        const rooms = [layout.office, layout.desks, layout.meeting, layout.lounge];
        if (layout.away) rooms.push(layout.away);
        for (const [i, a] of rooms.entries()) {
          for (const b of rooms.slice(i + 1)) expect(apart(a, b)).toBe(true);
          expect(a.x + a.width).toBeLessThanOrEqual(layout.width);
          expect(a.y + a.height).toBeLessThanOrEqual(layout.height);
        }
        expect(layout.deskCount).toBeGreaterThanOrEqual(workers);
        expect(layout.tables * 2).toBeGreaterThanOrEqual(meeting);
      }
    }
  });

  it('grows each room on its own, and opens the out-of-office room for the first retired cat', () => {
    const small = layoutFor(4, 0, 0);
    expect(layoutFor(4, 0, 3).lounge.height).toBe(small.lounge.height);
    expect(layoutFor(4, 0, 4).lounge.height).toBeGreaterThan(small.lounge.height);
    expect(layoutFor(8, 0, 0).desks.height).toBeGreaterThan(small.desks.height);
    expect(layoutFor(8, 0, 0).office).toEqual(small.office);
    expect(small.away).toBeNull();
    const away = layoutFor(4, 0, 0, 1);
    expect(away.away).not.toBeNull();
    // The other rooms stay where they were.
    expect(away.lounge).toEqual(small.lounge);
    expect(away.desks).toEqual(small.desks);
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

  it("tells whether a bubble's line to its cat crosses a box", () => {
    const box = { left: 10, top: 10, right: 20, bottom: 20 };
    const line = (x1: number, y1: number, x2: number, y2: number) => ({
      from: { x: x1, y: y1 },
      to: { x: x2, y: y2 },
    });
    expect(crosses(line(0, 15, 30, 15), box)).toBe(true);
    expect(crosses(line(0, 0, 30, 30), box)).toBe(true);
    expect(crosses(line(0, 0, 5, 30), box)).toBe(false);
    expect(crosses(line(0, 25, 30, 25), box)).toBe(false);
    expect(crosses(line(12, 0, 12, 5), box)).toBe(false);
  });
});
