import { describe, expect, it } from 'vitest';

import {
  alwaysAskReason,
  autonomousCommands,
  isPush,
  LEVELS,
  levelForXp,
  levelProgress,
  type ProjectCommands,
  readablePathsFor,
  scriptRisk,
  scriptsInvoked,
  selectLearnings,
} from './levels.js';

const project: ProjectCommands = {
  packageManager: 'pnpm',
  scripts: {
    test: 'vitest run',
    lint: 'eslint .',
    format: 'prettier --write .',
    build: 'tsc -p .',
    postinstall: 'node scripts/setup.js',
    deploy: 'curl -X POST https://example.com/deploy',
    clean: 'rm -rf dist',
    setup: 'pnpm install && node seed.js',
    release: 'git push --tags',
  },
};

describe('level curve', () => {
  it.each([
    [0, 1],
    [29, 1],
    [30, 2],
    [79, 2],
    [80, 3],
    [149, 3],
    [150, 4],
    [10_000, 4],
  ])('%i XP is level %i', (xp, level) => {
    expect(levelForXp(xp)).toBe(level);
  });

  it('has increasing thresholds starting at 0', () => {
    expect(LEVELS[0]?.minXp).toBe(0);
    for (let i = 1; i < LEVELS.length; i++) {
      expect(LEVELS[i]?.minXp).toBeGreaterThan(LEVELS[i - 1]?.minXp ?? 0);
    }
  });

  it('reports progress inside a level, with no next level at the top', () => {
    expect(levelProgress(40)).toEqual({ level: 2, current: 30, next: 80 });
    expect(levelProgress(200)).toEqual({ level: 4, current: 150, next: null });
  });
});

describe('always ask', () => {
  it.each([
    ['curl -sI https://example.com', 'network'],
    ['npm test && curl https://evil.example', 'network'],
    ['git fetch origin', 'network'],
    ['Invoke-WebRequest https://example.com', 'network'],
    ['pnpm add left-pad', 'install'],
    ['npm ci', 'install'],
    ['npx some-tool', 'install'],
    ['npm exec some-tool', 'install'],
    ['pip install requests', 'install'],
    ['rm -rf node_modules', 'destructive'],
    ['rm -fr dist', 'destructive'],
    ['rm -r build', 'destructive'],
    ['Remove-Item -Path dist -Recurse -Force', 'destructive'],
    ['git reset --hard HEAD~1', 'destructive'],
    ['git clean -fdx', 'destructive'],
    ['git checkout -- src/app.ts', 'destructive'],
    ['git checkout .', 'destructive'],
    ['git restore src', 'destructive'],
    ['git branch -D feature', 'destructive'],
    ['git stash drop', 'destructive'],
    ['find . -name "*.tmp" -delete', 'destructive'],
    ['del /s /q build', 'destructive'],
  ] as const)('%s asks (%s)', (command, reason) => {
    expect(alwaysAskReason(command)).toBe(reason);
  });

  it.each([
    'npm test',
    'pnpm lint',
    'pnpm format',
    'git add -A',
    'git commit -m "Add login"',
    'git checkout -b feature',
    'git status',
    'vitest run',
    'rm stale.txt',
    'node --test',
    'git diff --stat',
  ])('%s does not ask on that account', (command) => {
    expect(alwaysAskReason(command)).toBeNull();
  });

  it('recognizes pushes, which are refused rather than asked', () => {
    expect(isPush('git push origin HEAD')).toBe(true);
    expect(isPush('git -C . push --force')).toBe(true);
    expect(isPush('git --no-pager -c core.x=1 push')).toBe(true);
    expect(isPush('npm test && git push')).toBe(true);
    expect(isPush('git commit -m "push the button"')).toBe(false);
  });
});

describe('scriptRisk', () => {
  const scripts = {
    test: 'vitest run',
    pretest: 'pnpm run fetch-fixtures',
    'fetch-fixtures': 'curl -o fixtures.json https://example.com',
    ci: 'pnpm lint && pnpm run pretest',
    lint: 'eslint .',
    wipe: 'rm -rf .',
    ship: 'git push',
  };

  it('finds the scripts a command runs', () => {
    expect(scriptsInvoked('pnpm test && npm run lint; yarn build | bun run x')).toEqual([
      'test',
      'lint',
      'build',
      'x',
    ]);
    expect(scriptsInvoked('npm test')).toEqual(['test']);
    expect(scriptsInvoked('git status')).toEqual([]);
  });

  it('is clear for scripts that stay local', () => {
    expect(scriptRisk('pnpm test', scripts)).toBeNull();
    expect(scriptRisk('pnpm lint', scripts)).toBeNull();
    expect(scriptRisk('pnpm unknown-script', scripts)).toBeNull();
  });

  it('flags scripts that fetch, delete or push, also through other scripts', () => {
    expect(scriptRisk('pnpm run fetch-fixtures', scripts)).toEqual({
      script: 'fetch-fixtures',
      reason: 'network',
    });
    expect(scriptRisk('pnpm ci', scripts)).toEqual({ script: 'ci', reason: 'network' });
    expect(scriptRisk('npm run wipe', scripts)).toEqual({ script: 'wipe', reason: 'destructive' });
    expect(scriptRisk('yarn ship', scripts)).toEqual({ script: 'ship', reason: 'push' });
  });

  it('does not loop on scripts that call each other', () => {
    expect(scriptRisk('pnpm a', { a: 'pnpm b', b: 'pnpm a' })).toBeNull();
  });
});

describe('autonomy', () => {
  it('gives levels 1 and 2 nothing beyond the defaults', () => {
    expect(autonomousCommands(1, project)).toEqual([]);
    expect(autonomousCommands(2, project)).toEqual([]);
    expect(readablePathsFor(2, '/repo')).toEqual([]);
  });

  it('lets level 3 run the project scripts that stay local', () => {
    const commands = autonomousCommands(3, project);
    expect(commands).toEqual(
      expect.arrayContaining([
        'pnpm test',
        'pnpm run test',
        'pnpm lint',
        'pnpm format',
        'pnpm build',
      ]),
    );
    for (const name of ['postinstall', 'deploy', 'clean', 'setup', 'release']) {
      expect(commands.some((c) => c.endsWith(` ${name}`))).toBe(false);
    }
    expect(commands).not.toContain('vitest');
  });

  it('lets level 4 also run local dev tools and read the main checkout', () => {
    const commands = autonomousCommands(4, project);
    expect(commands).toEqual(
      expect.arrayContaining(['pnpm test', 'vitest', 'pnpm exec vitest', 'tsc', 'pytest']),
    );
    expect(readablePathsFor(4, '/repo')).toEqual(['/repo']);
  });

  it('never auto-approves a command that would ask anyway', () => {
    for (const command of autonomousCommands(4, project)) {
      expect(alwaysAskReason(command), command).toBeNull();
    }
  });

  it('runs npm scripts with npm run, and test with npm test', () => {
    const commands = autonomousCommands(3, { packageManager: 'npm', scripts: { test: 'jest' } });
    expect(commands).toEqual(['npm test', 'npm run test']);
  });

  it('has no project scripts without a package.json', () => {
    expect(autonomousCommands(3, { packageManager: null, scripts: {} })).toEqual([]);
    expect(autonomousCommands(4, { packageManager: null, scripts: {} })).toContain('pytest');
  });
});

describe('selectLearnings', () => {
  const lines = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ text: `generic learning number ${String(i)}` }));

  it('loads everything when there are fewer lines than the limit', () => {
    expect(selectLearnings(lines(4), 'anything', 1)).toHaveLength(4);
  });

  it('loads everything from level 3', () => {
    expect(selectLearnings(lines(30), 'anything', 3)).toHaveLength(30);
  });

  it('keeps the top 5 at level 1 and the top 10 at level 2', () => {
    expect(selectLearnings(lines(30), 'anything', 1)).toHaveLength(5);
    expect(selectLearnings(lines(30), 'anything', 2)).toHaveLength(10);
  });

  it('prefers lines that share words with the task, then newer lines, in file order', () => {
    const learnings = [
      { text: 'Login handlers live in src/routes/auth.ts' },
      { text: 'Old note about the build' },
      { text: 'Another old note' },
      { text: 'Use the makeUser fixture for login tests' },
      { text: 'Recent note one' },
      { text: 'Recent note two' },
      { text: 'Recent note three' },
    ];
    const picked = selectLearnings(learnings, 'Add a login endpoint with tests', 1);
    expect(picked.map((l) => l.text)).toEqual([
      'Login handlers live in src/routes/auth.ts',
      'Use the makeUser fixture for login tests',
      'Recent note one',
      'Recent note two',
      'Recent note three',
    ]);
  });
});
