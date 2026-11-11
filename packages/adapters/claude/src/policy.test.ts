import { join, resolve } from 'node:path';

import type { AgentPolicy } from '@agentcats/protocol/adapter';
import { describe, expect, it } from 'vitest';

import {
  decideCommand,
  decideRead,
  decideWrite,
  isInside,
  policyOptions,
  sessionSettings,
} from './policy.js';

const main = resolve('/work/app');
const worktree = resolve('/home/me/.agentcats/worktrees/app-1234/task-1');
const policy: AgentPolicy = {
  access: 'workspace',
  allowedCommands: ['npm test', 'npm run lint'],
  protectedPaths: [main],
};

describe('decideCommand', () => {
  it.each([
    'git push',
    'git push origin agentcats/mochi/1234',
    'git -C . push --force',
    'cd x && git push',
  ])('denies %s', (command) => {
    expect(decideCommand(command, policy).kind).toBe('deny');
  });

  it('denies a command that names the main checkout', () => {
    expect(decideCommand(`cat ${main}/secret.txt > out`, policy).kind).toBe('deny');
    expect(decideCommand(`ls ${main.replace(/\//g, '\\')}`, policy).kind).toBe('deny');
  });

  it.each([
    'curl https://example.com',
    'wget -q https://example.com/x.tgz',
    'npm install left-pad',
    'pnpm add zod',
    'npx some-tool',
    'pip install requests',
    'git fetch origin',
    'git clone https://github.com/x/y',
    'Invoke-WebRequest https://example.com',
  ])('asks for %s', (command) => {
    expect(decideCommand(command, policy).kind).toBe('ask');
  });

  it.each(['rm -rf src', 'git reset --hard HEAD~1', 'git clean -fd', 'npm test && rm -rf ~'])(
    'asks for destructive %s, even with an allowed prefix',
    (command) => {
      expect(decideCommand(command, policy)).toMatchObject({
        kind: 'ask',
        reason: expect.stringContaining('delete') as unknown,
      });
    },
  );

  it.each([
    'npm test',
    'git status',
    'git commit -m "add login"',
    'git commit -m "Add push notifications"',
    'ls src',
    'node index.js',
  ])('leaves %s to the normal flow', (command) => {
    expect(decideCommand(command, policy).kind).toBe('pass');
  });
});

describe('decideCommand with package.json scripts', () => {
  const scripts = {
    test: 'vitest run',
    pretest: 'curl -o f.json https://example.com',
    clean: 'rm -rf dist',
  };

  it('lets a local script pass to the allow rules', () => {
    expect(decideCommand('npm test', policy, scripts).kind).toBe('pass');
  });

  it('asks when the script itself fetches or deletes, even if the command is allowed', () => {
    expect(decideCommand('npm run pretest', policy, scripts)).toMatchObject({
      kind: 'ask',
      reason: expect.stringContaining('"pretest" script') as unknown,
    });
    expect(decideCommand('npm run clean', policy, scripts).kind).toBe('ask');
  });
});

describe('decideWrite', () => {
  it('allows writes inside the worktree, relative or absolute', () => {
    expect(decideWrite('src/login.ts', worktree, policy).kind).toBe('pass');
    expect(decideWrite(join(worktree, 'test', 'login.test.ts'), worktree, policy).kind).toBe(
      'pass',
    );
  });

  it('denies writes to the main checkout and anywhere else outside the worktree', () => {
    expect(decideWrite(join(main, 'src', 'login.ts'), worktree, policy)).toMatchObject({
      kind: 'deny',
      reason: expect.stringContaining('main checkout') as unknown,
    });
    expect(decideWrite('../task-2/src/x.ts', worktree, policy).kind).toBe('deny');
    expect(decideWrite(resolve('/etc/passwd'), worktree, policy).kind).toBe('deny');
  });

  it('allows the worktree even when it sits inside a protected path', () => {
    const nested = join(main, '.worktrees', 'task-1');
    expect(decideWrite('a.ts', nested, policy).kind).toBe('pass');
  });
});

describe('decideRead', () => {
  const leveled: AgentPolicy = { ...policy, readablePaths: [main] };

  it('leaves reads inside the worktree to Claude Code', () => {
    expect(decideRead('src/a.ts', worktree, leveled).kind).toBe('pass');
  });

  it('allows reads in a readable path without a prompt', () => {
    expect(decideRead(join(main, 'package.json'), worktree, leveled).kind).toBe('allow');
  });

  it('leaves other reads outside the worktree to the normal prompt', () => {
    expect(decideRead(join(main, 'package.json'), worktree, policy).kind).toBe('pass');
    expect(decideRead(resolve('/home/me/.ssh/id_ed25519'), worktree, leveled).kind).toBe('pass');
  });
});

describe('policyOptions', () => {
  it('gives the orchestrator no edit or shell tools, and agentcats tools without prompts', () => {
    const options = policyOptions(
      { access: 'read_only', allowedCommands: [], protectedPaths: [] },
      main,
    );
    expect(options.disallowedTools).toEqual(expect.arrayContaining(['Write', 'Edit', 'Bash']));
    expect(options.allowedTools).toBeUndefined();
    const [matcher] = options.hooks?.PreToolUse ?? [];
    expect(matcher?.matcher).toBe('^mcp__agentcats__');
  });

  it('allows configured commands and installs guard hooks for workers', async () => {
    const options = policyOptions(policy, worktree);
    expect(options.allowedTools).toEqual([
      'Bash(npm test)',
      'Bash(npm test *)',
      'Bash(npm run lint)',
      'Bash(npm run lint *)',
    ]);
    const matchers = options.hooks?.PreToolUse ?? [];
    expect(matchers.map((m) => m.matcher)).toEqual([
      'Bash|PowerShell',
      'Write|Edit|MultiEdit|NotebookEdit',
      'Read|Grep|Glob|LS',
      'WebFetch|WebSearch',
    ]);
    const signal = new AbortController().signal;
    const bash = matchers[0]!.hooks[0]!;
    const output = await bash(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git push' },
      } as never,
      'toolu_1',
      { signal },
    );
    expect(output).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    const web = matchers[3]!.hooks[0]!;
    expect(await web({} as never, 'toolu_2', { signal })).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'ask' },
    });
  });

  it('adds nothing without a policy', () => {
    expect(policyOptions(undefined, worktree)).toEqual({});
  });
});

describe('sessionSettings', () => {
  it('hides commit and PR attribution when attribution is off', () => {
    expect(sessionSettings(false)).toEqual({ settings: { attribution: { commit: '', pr: '' } } });
  });

  it("keeps Claude Code's default when attribution is on or unspecified", () => {
    expect(sessionSettings(true)).toEqual({});
    expect(sessionSettings(undefined)).toEqual({});
  });
});

describe('isInside', () => {
  it('compares paths, not string prefixes', () => {
    expect(isInside('/a/b', '/a/b/c')).toBe(true);
    expect(isInside('/a/b', '/a/b')).toBe(true);
    expect(isInside('/a/b', '/a/bc')).toBe(false);
  });
});
