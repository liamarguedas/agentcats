import { z } from 'zod';

import { Id, Usage } from './common.js';
import { Cat, PendingApproval, Task } from './entities.js';
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
});
export type BoardState = z.infer<typeof BoardState>;

export function emptyBoard(): BoardState {
  return { lastSeq: 0, cats: {}, tasks: {}, pendingApprovals: {}, usage: {} };
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
 * `daemon.error`) only advance `lastSeq`.
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
          status: 'idle',
          statusReason: null,
          createdAt: event.ts,
        },
      };
      return next;

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
          summary: null,
          createdAt: event.ts,
          updatedAt: event.ts,
        },
      };
      return next;

    case 'task.updated': {
      const task = state.tasks[event.taskId];
      if (!task) return next;
      const { status, assigneeCatId, summary } = event.payload;
      next.tasks = {
        ...state.tasks,
        [event.taskId]: {
          ...task,
          ...(status !== undefined && { status }),
          ...(assigneeCatId !== undefined && { assigneeCatId }),
          ...(summary !== undefined && { summary }),
          updatedAt: event.ts,
        },
      };
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
    case 'daemon.error':
      return next;
  }
}
