import { AgentcatsConfig, type Task, type TaskResult } from '@agentcats/protocol';
import { describe, expect, it } from 'vitest';

import { medianCost, xpForVerdict } from './xp.js';

const weights = AgentcatsConfig.parse({}).xp;

const result = (tests: TaskResult['tests'], costUsd: number | null): TaskResult => ({
  summary: '',
  branch: 'agentcats/mochi/1',
  diffStat: { files: 1, insertions: 1, deletions: 0 },
  tests,
  costUsd,
});

describe('xpForVerdict', () => {
  it.each([
    // decision, attempt, tests, cost, median, current XP, expected awards
    [
      'accept',
      1,
      'passed',
      0.1,
      0.2,
      0,
      [
        ['accepted', 10],
        ['tests_first_try', 5],
        ['under_cost', 3],
      ],
    ],
    [
      'accept',
      1,
      'passed',
      0.3,
      0.2,
      0,
      [
        ['accepted', 10],
        ['tests_first_try', 5],
      ],
    ],
    [
      'accept',
      2,
      'passed',
      0.1,
      0.2,
      0,
      [
        ['accepted', 10],
        ['under_cost', 3],
      ],
    ],
    ['accept', 1, 'failed', 0.1, null, 0, [['accepted', 10]]],
    ['accept', 1, 'not_run', null, 0.2, 0, [['accepted', 10]]],
    ['accept', 1, 'unknown', 0.2, 0.2, 0, [['accepted', 10]]],
    ['reject', 1, 'passed', 0.1, 0.2, 40, [['rejected', -10]]],
    ['reject', 1, 'passed', 0.1, 0.2, 4, [['rejected', -4]]],
    ['reject', 1, 'passed', 0.1, 0.2, 0, []],
  ] as const)(
    '%s on attempt %i with tests %s, cost %s vs median %s, from %i XP',
    (decision, attempt, tests, cost, median, current, expected) => {
      const awards = xpForVerdict(
        decision,
        { attempt, result: result(tests, cost) },
        current,
        median,
        weights,
      );
      expect(awards.map((a) => [a.reason, a.delta])).toEqual(expected);
    },
  );

  it('gives only the base when there is no result', () => {
    expect(xpForVerdict('accept', { attempt: 1, result: null }, 0, 1, weights)).toEqual([
      { reason: 'accepted', delta: 10 },
    ]);
  });

  it('uses the configured weights and leaves out zero awards', () => {
    const custom = { accepted: 20, testsFirstTry: 0, underCost: 0, rejectedPenalty: 5 };
    expect(
      xpForVerdict('accept', { attempt: 1, result: result('passed', 0) }, 0, 1, custom),
    ).toEqual([{ reason: 'accepted', delta: 20 }]);
  });
});

describe('medianCost', () => {
  const task = (id: string, status: Task['status'], costUsd: number | null, updatedAt = 0) =>
    ({ id, status, result: result('passed', costUsd), updatedAt }) as Task;

  it('needs five accepted tasks with a known cost', () => {
    const tasks = [1, 2, 3, 4].map((n) => task(`t${String(n)}`, 'done', n / 10));
    expect(medianCost(tasks, 'x')).toBeNull();
    expect(medianCost([...tasks, task('t5', 'done', 0.5)], 'x')).toBeCloseTo(0.3);
  });

  it('ignores the task being reviewed, unaccepted tasks and unknown costs', () => {
    const tasks = [
      ...[1, 2, 3, 4, 5, 6].map((n) => task(`t${String(n)}`, 'done', n / 10)),
      task('self', 'done', 9),
      task('rejected', 'rejected', 9),
      task('unknown', 'done', null),
    ];
    expect(medianCost(tasks, 'self')).toBeCloseTo(0.35);
  });

  it('only looks at the 20 most recent accepted tasks', () => {
    const old = Array.from({ length: 20 }, (_, i) => task(`old${String(i)}`, 'done', 10, i));
    const recent = Array.from({ length: 20 }, (_, i) =>
      task(`new${String(i)}`, 'done', 1, 100 + i),
    );
    expect(medianCost([...old, ...recent], 'x')).toBe(1);
  });
});
