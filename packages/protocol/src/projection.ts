import { z } from 'zod';

import { Id, Usage } from './common.js';
import { Cat, LearningProposal, PendingApproval, Task } from './entities.js';
import type { AgentcatsEvent } from './events.js';

/**
 * Board state derived from the event log. The daemon builds it for the
 * snapshot endpoint and the UI keeps it current by applying live events with
 * the same {@link applyEvent}, so both sides always agree.
 */
export const BoardState = z.strictObject({
  /** `seq` of the last event applied; 0 for an empty log. */
  lastSeq: z.int().nonnegative(),
  cats: z.record(Id, Cat),
  tasks: z.record(Id, Task),
  pendingApprovals: z.record(Id, PendingApproval),
  usage: z.record(Id, Usage),
  /** Learnings waiting for the user's accept or discard. */
  proposals: z.record(Id, LearningProposal),
});
export type BoardState = z.infer<typeof BoardState>;

export function emptyBoard(): BoardState {
  return { lastSeq: 0, cats: {}, tasks: {}, pendingApprovals: {}, usage: {}, proposals: {} };
}

/**
 * How an incoming event relates to the state: the expected next one, one
 * already applied (safe to drop), or one after a gap (refetch the snapshot).
 */
export function classifySeq(
  state: BoardState,
  event: AgentcatsEvent,
): 'next' | 'duplicate' | 'gap' {
  if (event.seq <= state.lastSeq) return 'duplicate';
  return event.seq === state.lastSeq + 1 ? 'next' : 'gap';
}

/**
 * Apply one event and return the new state. Never mutates `state`.
 *
 * Events that refer to a cat or task the state does not know are ignored
 * rather than thrown on, so a UI holding a truncated history keeps working.
 * Events that carry no board state (`tool.called`, `message.agent`,
 * `notice`, `daemon.error`) only advance `lastSeq`. Transition rules are the
 * daemon's job (`assertTransition`); the projection applies what it is given.
 */
export function applyEvent(state: BoardState, event: AgentcatsEvent): BoardState {
  const next: BoardState = { ...state, lastSeq: event.seq };

  switch (event.type) {
    case 'cat.created':
      next.cats = {
        ...state.cats,
        [event.catId]: {
          id: event.catId,
          ...event.payload,
          billing: 'unknown',
          status: 'idle',
          statusReason: null,
          pausedReason: null,
          xp: 0,
          level: 1,
          stats: { completed: 0, accepted: 0, rejected: 0 },
          learnings: [],
          createdAt: event.ts,
        },
      };
      return next;

    case 'cat.updated':
    case 'cat.paused':
    case 'cat.resumed': {
      const cat = state.cats[event.catId];
      if (!cat) return next;
      const patch =
        event.type === 'cat.updated'
          ? definedOnly(event.payload)
          : { pausedReason: event.type === 'cat.paused' ? event.payload.reason : null };
      next.cats = { ...state.cats, [event.catId]: { ...cat, ...patch } };
      return next;
    }

    case 'cat.status_changed': {
      const cat = state.cats[event.catId];
      if (!cat) return next;
      next.cats = {
        ...state.cats,
        [event.catId]: { ...cat, status: event.payload.status, statusReason: event.payload.reason },
      };
      return next;
    }

    case 'task.created':
      next.tasks = {
        ...state.tasks,
        [event.taskId]: {
          id: event.taskId,
          ...event.payload,
          statusReason: null,
          reasonCode: null,
          attempt: 1,
          branch: null,
          worktreePath: null,
          result: null,
          summary: null,
          createdAt: event.ts,
          updatedAt: event.ts,
        },
      };
      return next;

    case 'task.updated': {
      const task = state.tasks[event.taskId];
      if (!task) return next;
      const { actor, ...changes } = event.payload;
      const updated = { ...task, ...definedOnly(changes), updatedAt: event.ts };
      next.tasks = { ...state.tasks, [event.taskId]: updated };
      const counter = statCounter(task.status, updated.status, actor);
      const cat = updated.assigneeCatId ? state.cats[updated.assigneeCatId] : undefined;
      if (counter && cat) {
        next.cats = {
          ...state.cats,
          [cat.id]: { ...cat, stats: { ...cat.stats, [counter]: cat.stats[counter] + 1 } },
        };
      }
      return next;
    }

    case 'xp.changed':
    case 'cat.level_changed':
    case 'learnings.changed': {
      const cat = state.cats[event.catId];
      if (!cat) return next;
      const patch =
        event.type === 'xp.changed'
          ? { xp: event.payload.xp }
          : event.type === 'cat.level_changed'
            ? { level: event.payload.to }
            : { learnings: event.payload.learnings };
      next.cats = { ...state.cats, [event.catId]: { ...cat, ...patch } };
      return next;
    }

    case 'learnings.proposed': {
      const { proposalId, ...rest } = event.payload;
      next.proposals = {
        ...state.proposals,
        [proposalId]: {
          id: proposalId,
          catId: event.catId,
          taskId: event.taskId ?? null,
          ...rest,
          createdAt: event.ts,
        },
      };
      return next;
    }

    case 'learnings.proposal_resolved': {
      const { [event.payload.proposalId]: _resolved, ...remaining } = state.proposals;
      next.proposals = remaining;
      return next;
    }

    case 'approval.requested': {
      const { approvalId, ...rest } = event.payload;
      next.pendingApprovals = {
        ...state.pendingApprovals,
        [approvalId]: {
          id: approvalId,
          catId: event.catId,
          taskId: event.taskId ?? null,
          ...rest,
          requestedAt: event.ts,
        },
      };
      return next;
    }

    case 'approval.resolved': {
      const { [event.payload.approvalId]: _resolved, ...remaining } = state.pendingApprovals;
      next.pendingApprovals = remaining;
      return next;
    }

    case 'usage.updated':
      next.usage = { ...state.usage, [event.catId]: event.payload };
      return next;

    case 'tool.called':
    case 'message.agent':
    case 'message.user':
    case 'notice':
    case 'daemon.error':
      return next;
  }
}

/** Which of a cat's stats a status change counts toward, if any. */
function statCounter(
  from: Task['status'],
  to: Task['status'],
  actor: string | undefined,
): keyof Cat['stats'] | null {
  if (from === to) return null;
  if (to === 'review') return 'completed';
  if (from === 'review' && actor === 'user') {
    if (to === 'done') return 'accepted';
    if (to === 'rejected') return 'rejected';
  }
  return null;
}

/** Drop `undefined` values, so an optional field that is absent never overwrites state. */
function definedOnly<T extends object>(value: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}
