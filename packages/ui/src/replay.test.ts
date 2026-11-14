import { type AgentcatsEvent, emptyBoard } from '@agentcats/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { IDLE_CAP_MS, ReplayPlayer } from './replay.js';

let seq = 0;
function catCreated(ts: number, name: string): AgentcatsEvent {
  seq++;
  return {
    id: `e${String(seq)}`,
    seq,
    ts,
    type: 'cat.created',
    catId: `cat-${name}`,
    payload: {
      name,
      role: 'worker',
      adapter: 'mock',
      model: null,
      permissionMode: 'accept_edits',
      budget: { maxUsd: 2, maxTokens: null, maxMinutes: null },
      variant: null,
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ReplayPlayer', () => {
  it('shortens long idle gaps, starts on the first event, and seeks both ways', () => {
    seq = 0;
    const player = new ReplayPlayer(emptyBoard(), [
      catCreated(1_000, 'Mochi'),
      catCreated(2_000, 'Miso'),
      catCreated(3_600_000, 'Tofu'),
    ]);
    expect(player.duration).toBe(1_000 + IDLE_CAP_MS);
    expect(Object.keys(player.getView().board.cats)).toEqual(['cat-Mochi']);
    expect(player.getView().connection).toBe('replay');

    player.seek(player.duration);
    expect(Object.keys(player.getView().board.cats)).toHaveLength(3);
    expect(player.getState()).toMatchObject({ shown: 3, total: 3 });

    player.seek(1_000);
    expect(Object.keys(player.getView().board.cats)).toEqual(['cat-Mochi', 'cat-Miso']);
    expect(player.getView().events.map((e) => e.seq)).toEqual([1, 2]);
  });

  it('plays at the chosen speed and stops at the end', () => {
    vi.useFakeTimers();
    seq = 0;
    const player = new ReplayPlayer(emptyBoard(), [
      catCreated(0, 'Mochi'),
      catCreated(2_000, 'Miso'),
    ]);
    player.setSpeed(4);
    player.play();
    vi.advanceTimersByTime(400);
    expect(player.getState().position).toBeGreaterThanOrEqual(1_500);
    expect(player.getState().shown).toBe(1);
    vi.advanceTimersByTime(200);
    expect(player.getState()).toMatchObject({ shown: 2, playing: false, position: 2_000 });
    player.dispose();
  });

  it('starts from the board the session began with', () => {
    seq = 0;
    const earlier = new ReplayPlayer(emptyBoard(), [catCreated(0, 'Mochi')]);
    earlier.seek(0);
    const player = new ReplayPlayer(earlier.getView().board, [catCreated(10, 'Miso')]);
    expect(Object.keys(player.getView().board.cats).sort()).toEqual(['cat-Miso', 'cat-Mochi']);
    player.seek(0);
    expect(Object.keys(player.getView().board.cats)).toHaveLength(2);
  });
});
