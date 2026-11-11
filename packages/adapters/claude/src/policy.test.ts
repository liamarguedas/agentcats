import { join, resolve } from 'node:path';

import type { AgentPolicy } from '@agentcats/protocol/adapter';
import { describe, expect, it } from 'vitest';

import { decideCommand, decideWrite, isInside, policyOptions } from './policy.js';

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

  it.each(['npm test', 'git status', 'git commit -m "add login"', 'ls src', 'node index.js'])(
    'leaves %s to the normal flow',
    (command) => {
      expect(decideCommand(command, policy).kind).toBe('pass');
    },
  );
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
    const web = matchers[2]!.hooks[0]!;
    expect(await web({} as never, 'toolu_2', { signal })).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'ask' },
    });
  });

  it('adds nothing without a policy', () => {
    expect(policyOptions(undefined, worktree)).toEqual({});
  });
});

describe('isInside', () => {
  it('compares paths, not string prefixes', () => {
    expect(isInside('/a/b', '/a/b/c')).toBe(true);
    expect(isInside('/a/b', '/a/b')).toBe(true);
    expect(isInside('/a/b', '/a/bc')).toBe(false);
  });
});
