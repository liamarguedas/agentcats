import type { AgentcatsConfig, Task, XpReason } from '@agentcats/protocol';

export interface XpAward {
  readonly reason: XpReason;
  readonly delta: number;
}

/** How many recent accepted tasks the cost median is taken over. */
export const COST_WINDOW = 20;
/** Below this many accepted tasks with a known cost there is no median, so no cost bonus. */
export const COST_MIN_SAMPLES = 5;

/**
 * Median cost of the most recent accepted tasks (status `done`) with a known
 * cost, excluding `exceptTaskId`. `null` while there are too few to compare.
 */
export function medianCost(tasks: readonly Task[], exceptTaskId: string): number | null {
  const costs = tasks
    .filter((t) => t.status === 'done' && t.id !== exceptTaskId && t.result?.costUsd != null)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, COST_WINDOW)
    .map((t) => t.result?.costUsd ?? 0)
    .sort((a, b) => a - b);
  if (costs.length < COST_MIN_SAMPLES) return null;
  const mid = Math.floor(costs.length / 2);
  return costs.length % 2 === 1
    ? (costs[mid] ?? 0)
    : ((costs[mid - 1] ?? 0) + (costs[mid] ?? 0)) / 2;
}

/**
 * XP for the user's verdict on a task. Accepting earns the base, plus a bonus
 * for tests reported passing on the first attempt and one for costing less
 * than the team's median. Rejecting costs the penalty, but never takes XP
 * below 0. Zero awards are left out.
 *
 * @param currentXp The cat's XP before this verdict.
 * @param median From {@link medianCost}; `null` means no cost bonus.
 */
export function xpForVerdict(
  decision: 'accept' | 'reject',
  task: Pick<Task, 'attempt' | 'result'>,
  currentXp: number,
  median: number | null,
  weights: AgentcatsConfig['xp'],
): XpAward[] {
  if (decision === 'reject') {
    const delta = -Math.min(weights.rejectedPenalty, currentXp);
    return delta === 0 ? [] : [{ reason: 'rejected', delta }];
  }
  const awards: XpAward[] = [{ reason: 'accepted', delta: weights.accepted }];
  if (task.attempt === 1 && task.result?.tests === 'passed') {
    awards.push({ reason: 'tests_first_try', delta: weights.testsFirstTry });
  }
  const cost = task.result?.costUsd ?? null;
  if (cost !== null && median !== null && cost < median) {
    awards.push({ reason: 'under_cost', delta: weights.underCost });
  }
  return awards.filter((a) => a.delta !== 0);
}
