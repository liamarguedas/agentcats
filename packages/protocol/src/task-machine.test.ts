import { describe, expect, it } from 'vitest';

import { TaskStatus } from './common.js';
import {
  ACTIVE_TASK_STATUSES,
  assertTransition,
  canTransition,
  IllegalTransitionError,
  TASK_TRANSITIONS,
  TERMINAL_TASK_STATUSES,
  TransitionActor,
} from './task-machine.js';

const STATUSES = TaskStatus.options;
const ACTORS = TransitionActor.options;

describe('task state machine', () => {
  it('defines rules for every status', () => {
    expect(Object.keys(TASK_TRANSITIONS).sort()).toEqual([...STATUSES].sort());
  });

  it.each([
    ['queued', 'running', 'system'],
    ['running', 'review', 'system'],
    ['running', 'blocked', 'system'],
    ['running', 'blocked', 'user'],
    ['blocked', 'running', 'user'],
    ['running', 'queued', 'system'],
    ['running', 'failed', 'system'],
    ['review', 'done', 'user'],
    ['review', 'rejected', 'user'],
    ['failed', 'queued', 'user'],
    ['interrupted', 'queued', 'user'],
    ['running', 'interrupted', 'system'],
    ['running', 'cancelled', 'orchestrator'],
    ['queued', 'cancelled', 'user'],
  ] as const)('allows %s → %s by %s', (from, to, actor) => {
    expect(canTransition(from, to, actor)).toBe(true);
    expect(() => {
      assertTransition(from, to, actor);
    }).not.toThrow();
  });

  it.each([
    // Only the user judges a result.
    ['review', 'done', 'system'],
    ['review', 'done', 'orchestrator'],
    ['review', 'rejected', 'orchestrator'],
    // A worker cannot skip review.
    ['running', 'done', 'system'],
    // Only the daemon marks interruption, only on restart.
    ['running', 'interrupted', 'user'],
    // Re-runs are a user decision.
    ['failed', 'queued', 'system'],
    ['interrupted', 'queued', 'orchestrator'],
    // No way back from review into work in M1.
    ['review', 'running', 'user'],
    // A cancelled or accepted task is finished.
    ['cancelled', 'queued', 'user'],
    ['done', 'review', 'user'],
    // No self-loops.
    ['running', 'running', 'system'],
  ] as const)('rejects %s → %s by %s', (from, to, actor) => {
    expect(canTransition(from, to, actor)).toBe(false);
    expect(() => {
      assertTransition(from, to, actor);
    }).toThrow(IllegalTransitionError);
  });

  it('names the transition in the error', () => {
    expect(() => {
      assertTransition('review', 'done', 'orchestrator');
    }).toThrow('Task cannot go from review to done (requested by orchestrator)');
  });

  it('lets nothing leave a terminal status', () => {
    for (const from of TERMINAL_TASK_STATUSES) {
      for (const to of STATUSES) {
        for (const actor of ACTORS) expect(canTransition(from, to, actor)).toBe(false);
      }
    }
  });

  it('can cancel every active task, from any actor', () => {
    for (const from of ACTIVE_TASK_STATUSES) {
      for (const actor of ACTORS) expect(canTransition(from, 'cancelled', actor)).toBe(true);
    }
  });

  it('reaches every status from queued', () => {
    const seen = new Set<string>(['queued']);
    const frontier: TaskStatus[] = ['queued'];
    while (frontier.length > 0) {
      const from = frontier.pop()!;
      for (const to of Object.keys(TASK_TRANSITIONS[from]) as TaskStatus[]) {
        if (!seen.has(to)) {
          seen.add(to);
          frontier.push(to);
        }
      }
    }
    expect([...seen].sort()).toEqual([...STATUSES].sort());
  });
});
