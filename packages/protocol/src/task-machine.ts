import { z } from 'zod';

import type { TaskStatus } from './common.js';

/**
 * Who asks for a transition. The daemon checks it, so for example only the
 * user can accept or reject a worker's result (these decisions feed XP in M2).
 *
 * - `system`: the daemon itself (worker started, finished, crashed, stuck, budget).
 * - `orchestrator`: the orchestrator cat, through its MCP tools.
 * - `user`: someone on the board.
 */
export const TransitionActor = z.enum(['system', 'orchestrator', 'user']);
export type TransitionActor = z.infer<typeof TransitionActor>;

type Rules = Readonly<Record<TaskStatus, Partial<Record<TaskStatus, readonly TransitionActor[]>>>>;

const SYSTEM = ['system'] as const;
const USER = ['user'] as const;
const ANYONE_CANCELS = ['system', 'orchestrator', 'user'] as const;

/**
 * Every allowed task transition and who may make it. Anything not listed is
 * illegal. `interrupted` is only set by the daemon on restart; `done` and
 * `rejected` only by the user.
 *
 * ```
 * queued ──► running ──► review ──► done | rejected      (user)
 *    ▲          │  ▲
 *    │          ▼  │
 *    │       blocked            (stuck, budget, paused)
 *    │          │
 *    ├── retry ─┤ running → queued once after a crash
 *    │          ▼
 *    └──── failed | interrupted ──► queued                (user re-run)
 * any non-terminal ──► cancelled
 * ```
 */
export const TASK_TRANSITIONS: Rules = {
  queued: {
    running: SYSTEM,
    failed: SYSTEM,
    cancelled: ANYONE_CANCELS,
    interrupted: SYSTEM,
  },
  running: {
    // Automatic retry after a crash goes back through the queue.
    queued: SYSTEM,
    blocked: ['system', 'user'],
    review: SYSTEM,
    // `user`: the user killed the worker; the task stays re-runnable.
    failed: ['system', 'user'],
    cancelled: ANYONE_CANCELS,
    interrupted: SYSTEM,
  },
  blocked: {
    running: ['system', 'user'],
    failed: ['system', 'user'],
    cancelled: ANYONE_CANCELS,
    interrupted: SYSTEM,
  },
  review: {
    done: USER,
    rejected: USER,
  },
  failed: {
    queued: USER,
  },
  interrupted: {
    queued: USER,
    cancelled: USER,
  },
  done: {},
  rejected: {},
  cancelled: {},
};

/** States no transition leaves. */
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ['done', 'rejected', 'cancelled'];

/** States where a worker is (or should be) attached and spending. */
export const ACTIVE_TASK_STATUSES: readonly TaskStatus[] = ['queued', 'running', 'blocked'];

export class IllegalTransitionError extends Error {
  override readonly name = 'IllegalTransitionError';
  constructor(
    readonly from: TaskStatus,
    readonly to: TaskStatus,
    readonly actor: TransitionActor,
  ) {
    super(`Task cannot go from ${from} to ${to} (requested by ${actor})`);
  }
}

/** Whether `actor` may move a task from `from` to `to`. */
export function canTransition(from: TaskStatus, to: TaskStatus, actor: TransitionActor): boolean {
  return TASK_TRANSITIONS[from][to]?.includes(actor) ?? false;
}

/**
 * Check a transition.
 *
 * @throws IllegalTransitionError if the transition is not allowed for `actor`.
 */
export function assertTransition(from: TaskStatus, to: TaskStatus, actor: TransitionActor): void {
  if (!canTransition(from, to, actor)) throw new IllegalTransitionError(from, to, actor);
}
