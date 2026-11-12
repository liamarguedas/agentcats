import { AgentcatsConfig, type CandidateResult } from '@agentcats/protocol';
import { describe, expect, it } from 'vitest';

import { scoreCandidates } from './scoring.js';

const weights = AgentcatsConfig.parse({}).interviews.weights;

const result = (overrides: Partial<CandidateResult>): CandidateResult => ({
  passed: true,
  lintClean: true,
  typecheckClean: null,
  diff: { files: 1, insertions: 10, deletions: 0 },
  costUsd: 0.1,
  durationMs: 60_000,
  failure: null,
  ...overrides,
});

describe('scoreCandidates', () => {
  it('gives the smallest, cheapest, fastest clean candidate 100', () => {
    const [best, worse] = scoreCandidates(
      [
        result({}),
        result({
          diff: { files: 2, insertions: 15, deletions: 5 },
          costUsd: 0.2,
          durationMs: 120_000,
          lintClean: false,
        }),
      ],
      weights,
    );
    expect(best).toEqual({ total: 100, diff: 100, cost: 100, time: 100, quality: 100 });
    expect(worse).toEqual({ total: 40, diff: 50, cost: 50, time: 50, quality: 0 });
  });

  it('never gives a failing candidate a total, however good its numbers', () => {
    const [failing, passing] = scoreCandidates(
      [
        result({ passed: false, diff: { files: 1, insertions: 1, deletions: 0 }, costUsd: 0.01 }),
        result({ diff: { files: 5, insertions: 200, deletions: 50 }, costUsd: 1 }),
      ],
      weights,
    );
    expect(failing?.total).toBeNull();
    expect(passing?.total).toBe(100);
  });

  it('counts an unknown cost as 50 and no lint or typecheck as full quality', () => {
    const [score] = scoreCandidates([result({ costUsd: null, lintClean: null })], weights);
    expect(score).toMatchObject({ cost: 50, quality: 100 });
  });

  it('uses the configured weights', () => {
    const scores = scoreCandidates(
      [result({}), result({ diff: { files: 1, insertions: 40, deletions: 0 } })],
      { diff: 1, cost: 0, time: 0, quality: 0 },
    );
    expect(scores.map((s) => s.total)).toEqual([100, 25]);
  });

  it('scores nobody when everybody failed', () => {
    const scores = scoreCandidates([result({ passed: false }), result({ passed: false })], weights);
    expect(scores.every((s) => s.total === null)).toBe(true);
  });
});
