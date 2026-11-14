import {
  type AdapterInfo,
  type AgentcatsEvent,
  applyEvent,
  type BoardState,
  SNAPSHOT_EVENT_LIMIT,
} from '@agentcats/protocol';

import type { BoardView } from './board-client.js';

export const REPLAY_SPEEDS = [1, 2, 4, 8, 16] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];

/**
 * Idle time between two events is shortened to this in replay, so an hour a
 * cat spent waiting for an approval does not play as an hour. Documented on
 * the replay bar.
 */
export const IDLE_CAP_MS = 3_000;
const TICK_MS = 50;
/** A board is kept every this many events, so scrubbing back does not replay from the start. */
const CHECKPOINT_EVERY = 250;

export interface ReplayState {
  readonly playing: boolean;
  readonly speed: ReplaySpeed;
  /** Replay time in ms, from 0 to {@link duration}. */
  readonly position: number;
  readonly duration: number;
  /** Events shown so far, from 0 to the session's event count. */
  readonly shown: number;
  readonly total: number;
  /** Wall-clock time of the last event shown, for the label. */
  readonly at: number;
}

/**
 * Plays stored events onto a board, read-only. The board is the same
 * projection the live board uses, so a replay looks exactly like the run.
 */
export class ReplayPlayer {
  readonly #initial: BoardState;
  readonly #events: readonly AgentcatsEvent[];
  readonly #adapters: readonly AdapterInfo[];
  /** Replay time at which each event appears. */
  readonly #times: number[] = [];
  readonly #checkpoints = new Map<number, BoardState>();
  readonly #listeners = new Set<() => void>();
  #shown = 0;
  #board: BoardState;
  #position = 0;
  #playing = false;
  #speed: ReplaySpeed = 1;
  #timer: ReturnType<typeof setInterval> | undefined;
  #lastTick = 0;
  #view: BoardView;
  #state: ReplayState;

  constructor(
    initialBoard: BoardState,
    events: readonly AgentcatsEvent[],
    adapters: readonly AdapterInfo[] = [],
  ) {
    this.#initial = initialBoard;
    this.#events = events;
    this.#adapters = adapters;
    let time = 0;
    events.forEach((event, i) => {
      const previous = events[i - 1];
      if (previous) time += Math.min(Math.max(event.ts - previous.ts, 0), IDLE_CAP_MS);
      this.#times.push(time);
    });
    this.#board = initialBoard;
    this.#checkpoints.set(0, initialBoard);
    this.#view = this.#makeView();
    this.#state = this.#makeState();
    // Show the first event (usually `daemon.started`) right away.
    this.#showUpTo(0);
  }

  getView = (): BoardView => this.#view;
  getState = (): ReplayState => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  get duration(): number {
    return this.#times.at(-1) ?? 0;
  }

  play(): void {
    if (this.#playing) return;
    if (this.#position >= this.duration) this.seek(0);
    this.#playing = true;
    this.#lastTick = performance.now();
    this.#timer = setInterval(() => {
      const now = performance.now();
      this.#advance((now - this.#lastTick) * this.#speed);
      this.#lastTick = now;
    }, TICK_MS);
    this.#emit();
  }

  pause(): void {
    if (!this.#playing) return;
    this.#playing = false;
    clearInterval(this.#timer);
    this.#emit();
  }

  setSpeed(speed: ReplaySpeed): void {
    this.#speed = speed;
    this.#emit();
  }

  /** Jump to a replay time, forward or back. */
  seek(position: number): void {
    this.#position = Math.min(Math.max(position, 0), this.duration);
    this.#showUpTo(this.#position);
  }

  /** Stop the timer for good. */
  dispose(): void {
    this.pause();
    this.#listeners.clear();
  }

  #advance(ms: number): void {
    this.#position = Math.min(this.#position + ms, this.duration);
    this.#showUpTo(this.#position);
    if (this.#position >= this.duration) this.pause();
  }

  /** Show every event whose replay time is at or before `position`. */
  #showUpTo(position: number): void {
    const target = this.#countAt(position);
    if (target < this.#shown) {
      // Back: start from the nearest checkpoint at or before the target.
      const base = Math.floor(target / CHECKPOINT_EVERY) * CHECKPOINT_EVERY;
      this.#board = this.#checkpoints.get(base) ?? this.#initial;
      this.#shown = this.#checkpoints.has(base) ? base : 0;
    }
    while (this.#shown < target) {
      const event = this.#events[this.#shown];
      if (!event) break;
      this.#board = applyEvent(this.#board, event);
      this.#shown++;
      if (this.#shown % CHECKPOINT_EVERY === 0) this.#checkpoints.set(this.#shown, this.#board);
    }
    this.#emit();
  }

  /** How many events have a replay time at or before `position` (binary search). */
  #countAt(position: number): number {
    let lo = 0;
    let hi = this.#times.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.#times[mid] ?? 0) <= position) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  #makeView(): BoardView {
    return {
      connection: 'replay',
      board: this.#board,
      events: this.#events.slice(Math.max(0, this.#shown - SNAPSHOT_EVENT_LIMIT), this.#shown),
      adapters: this.#adapters,
    };
  }

  #makeState(): ReplayState {
    return {
      playing: this.#playing,
      speed: this.#speed,
      position: this.#position,
      duration: this.duration,
      shown: this.#shown,
      total: this.#events.length,
      at: this.#events[Math.max(0, this.#shown - 1)]?.ts ?? 0,
    };
  }

  #emit(): void {
    this.#view = this.#makeView();
    this.#state = this.#makeState();
    for (const listener of this.#listeners) listener();
  }
}
