import { randomUUID } from 'node:crypto';

import {
  AgentcatsEvent,
  applyEvent,
  type BoardState,
  emptyBoard,
  redactDeep,
  SNAPSHOT_EVENT_LIMIT,
} from '@agentcats/protocol';

import type { z } from 'zod';

import type { Store } from './store.js';

/**
 * An event before the log assigns `id`, `seq` and `ts`. Typed as the schema's
 * input, so fields with a default may be left out: `append` parses it.
 */
type EventInput = z.input<typeof AgentcatsEvent>;
export type EventDraft = EventInput extends infer E
  ? E extends EventInput
    ? Omit<E, 'id' | 'seq' | 'ts'>
    : never
  : never;

export type EventListener = (event: AgentcatsEvent) => void;

/**
 * Append-only event log and the board state projected from it. The single
 * source of truth for the daemon: everything the UI sees comes from here.
 *
 * Every event is validated, written to the {@link Store}, then projected and
 * broadcast, in that order. On construction the board is rebuilt by replaying
 * the stored log.
 */
export class EventLog {
  readonly #recent: AgentcatsEvent[];
  readonly #listeners = new Set<EventListener>();
  #board: BoardState;
  #seq: number;

  constructor(
    private readonly store: Store,
    private readonly now: () => number = Date.now,
  ) {
    const stored = store.allEvents();
    this.#board = stored.reduce(applyEvent, emptyBoard());
    this.#seq = store.lastSeq();
    this.#recent = stored.slice(-SNAPSHOT_EVENT_LIMIT);
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
    // The one door into the log: nothing stored, shown or exported keeps a secret.
    const event = AgentcatsEvent.parse({
      ...redactDeep(draft),
      id: randomUUID(),
      seq: this.#seq + 1,
      ts: this.now(),
    });
    this.store.appendEvent(event);
    this.#seq = event.seq;
    this.#recent.push(event);
    if (this.#recent.length > SNAPSHOT_EVENT_LIMIT) this.#recent.shift();
    this.#board = applyEvent(this.#board, event);
    for (const listener of this.#listeners) listener(event);
    return event;
  }

  /** The most recent events, oldest first. */
  recent(limit = SNAPSHOT_EVENT_LIMIT): AgentcatsEvent[] {
    return this.#recent.slice(-limit);
  }

  /** Every stored event, oldest first. */
  allEvents(): AgentcatsEvent[] {
    return this.store.allEvents();
  }

  /** Stored events with `from <= seq <= to`, oldest first. */
  eventsBetween(from: number, to: number): AgentcatsEvent[] {
    return this.store.allEvents().filter((e) => e.seq >= from && e.seq <= to);
  }

  /** Every stored event about one task, oldest first. */
  taskEvents(taskId: string): AgentcatsEvent[] {
    return this.store.taskEvents(taskId);
  }

  subscribe(listener: EventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
