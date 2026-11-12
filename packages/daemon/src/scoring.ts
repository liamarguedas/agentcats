import type { AgentcatsConfig, CandidateResult, CandidateScore } from '@agentcats/protocol';

type Weights = AgentcatsConfig['interviews']['weights'];

/** Changed lines, at least 1, so an empty diff cannot divide by zero. */
const lines = (r: CandidateResult) => Math.max(1, r.diff.insertions + r.diff.deletions);

/** `best / own` as 0 to 100: the best candidate gets 100, one twice as big 50. */
const relative = (best: number, own: number) =>
  own <= 0 ? 100 : Math.min(100, (100 * best) / own);

/**
 * Score every candidate of one interview. Passing the check is a gate: a
 * candidate that failed gets `total: null` and cannot be hired, whatever its
 * other numbers. Among the ones that passed, each part compares with the best
 * passing candidate:
 *
 * - `diff`: the smallest change wins (changed lines).
 * - `cost`: the cheapest wins; an unknown cost counts as 50.
 * - `time`: the fastest wins.
 * - `quality`: the share of lint and typecheck runs that came out clean; 100
 *   when the sample defines neither.
 *
 * `total` is the weighted mean of the parts. Weights are in the config.
 */
export function scoreCandidates(
  results: readonly CandidateResult[],
  weights: Weights,
): CandidateScore[] {
  const passing = results.filter((r) => r.passed);
  const minOf = (values: number[]) => (values.length === 0 ? 0 : Math.min(...values));
  const bestLines = minOf(passing.map(lines));
  const bestCost = minOf(passing.flatMap((r) => (r.costUsd === null ? [] : [r.costUsd])));
  const bestTime = minOf(passing.map((r) => r.durationMs));
  const weightSum = weights.diff + weights.cost + weights.time + weights.quality;

  return results.map((r) => {
    const checks = [r.lintClean, r.typecheckClean].filter((c) => c !== null);
    const quality =
      checks.length === 0 ? 100 : (100 * checks.filter(Boolean).length) / checks.length;
    if (!r.passed) return { total: null, diff: 0, cost: 0, time: 0, quality: round(quality) };
    const parts = {
      diff: relative(bestLines, lines(r)),
      cost: r.costUsd === null ? 50 : relative(bestCost, r.costUsd),
      time: relative(bestTime, r.durationMs),
      quality,
    };
    const total =
      weightSum === 0
        ? 100
        : (weights.diff * parts.diff +
            weights.cost * parts.cost +
            weights.time * parts.time +
            weights.quality * parts.quality) /
          weightSum;
    return {
      total: round(total),
      diff: round(parts.diff),
      cost: round(parts.cost),
      time: round(parts.time),
      quality: round(parts.quality),
    };
  });
}

const round = (n: number) => Math.round(n * 10) / 10;
