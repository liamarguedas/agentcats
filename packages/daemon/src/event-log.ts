import { randomUUID } from 'node:crypto';

import {
  AgentcatsEvent,
  applyEvent,
  type BoardState,
  emptyBoard,
  SNAPSHOT_EVENT_LIMIT,
} from '@agentcats/protocol';

/** An event before the log assigns `id`, `seq` and `ts`. */
export type EventDraft = AgentcatsEvent extends infer E
  ? E extends AgentcatsEvent
    ? Omit<E, 'id' | 'seq' | 'ts'>
    : never
  : never;

export type EventListener = (event: AgentcatsEvent) => void;

/**
 * Append-only event log and the board state projected from it. The single
 * source of truth for the daemon: everything the UI sees comes from here.
 *
 * In-memory for M0. M1 replaces the storage with SQLite behind the same
 * methods, writing each event before it is broadcast.
 */
export class EventLog {
  readonly #events: AgentcatsEvent[] = [];
  readonly #listeners = new Set<EventListener>();
  readonly #retain: number;
  #board: BoardState = emptyBoard();
  #seq = 0;

  constructor(
    private readonly now: () => number = Date.now,
    /** Events kept in memory. The board keeps the full state regardless. */
    retain = SNAPSHOT_EVENT_LIMIT * 4,
  ) {
    this.#retain = retain;
  }

  get board(): BoardState {
    return this.#board;
  }

  get lastSeq(): number {
    return this.#seq;
  }

  /**
   * Validate, number, store, project and broadcast one event.
   *
   * @throws ZodError if the draft does not match the protocol. That is a
   *   daemon bug, so it fails loudly instead of sending bad data to the UI.
   */
  append(draft: EventDraft): AgentcatsEvent {
    const event = AgentcatsEvent.parse({
      ...draft,
      id: randomUUID(),
      seq: this.#seq + 1,
      ts: this.now(),
    });
    this.#seq = event.seq;
    this.#events.push(event);
    if (this.#events.length > this.#retain)
      this.#events.splice(0, this.#events.length - this.#retain);
    this.#board = applyEvent(this.#board, event);
    for (const listener of this.#listeners) listener(event);
    return event;
  }

  /** The most recent events, oldest first. */
  recent(limit = SNAPSHOT_EVENT_LIMIT): AgentcatsEvent[] {
    return this.#events.slice(-limit);
  }

  subscribe(listener: EventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
