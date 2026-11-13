import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Snapshot } from '@agentcats/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MINIMUM, nodeVersionProblem } from '../bin/check-node.mjs';
import cliPackage from '../package.json' with { type: 'json' };
import { type CliIo, main, parseCliArgs } from '../src/main.js';

let project = '';
afterEach(async () => {
  if (project) await rm(project, { recursive: true, force: true, maxRetries: 5 });
  project = '';
});

/** A temp git repo with one commit and a config that keeps worktrees out of the home dir. */
async function gitProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agentcats-cli-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  await writeFile(join(dir, 'README.md'), '# cli test\n');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  await mkdir(join(dir, '.agentcats'));
  await writeFile(
    join(dir, '.agentcats', 'agentcats.config.json'),
    JSON.stringify({ worktreesDir: join(dir, '.agentcats', 'worktrees') }),
  );
  return dir;
}

function testIo() {
  const out: string[] = [];
  const err: string[] = [];
  let stop!: () => void;
  const stopped = new Promise<void>((resolve) => (stop = resolve));
  const io: CliIo = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    open: vi.fn(),
    stopSignal: () => stopped,
  };
  return { io, out, err, stop };
}

describe('parseCliArgs', () => {
  it('defaults the project to the current directory and opens the browser', () => {
    expect(parseCliArgs([], '/work/repo')).toMatchObject({
      project: expect.stringContaining('repo') as unknown,
      adapter: null,
      port: null,
      open: true,
    });
  });

  it('reads every option', () => {
    expect(
      parseCliArgs(['-p', 'sub', '--adapter', 'mock', '--port', '4545', '--no-open'], '/work'),
    ).toMatchObject({ adapter: 'mock', port: 4545, open: false });
  });

  it.each([
    [['--adapter', 'gemini'], /--adapter/],
    [['--port', 'abc'], /--port/],
    [['--port', '70000'], /--port/],
    [['--wat'], /Unknown option/],
  ])('rejects %j', (argv, message) => {
    expect(() => parseCliArgs(argv)).toThrow(message);
  });
});

describe('main', () => {
  it('starts the daemon, prints the board URL, and stops cleanly', async () => {
    project = await gitProject();
    const { io, out, stop } = testIo();
    const running = main(['--project', project, '--adapter', 'mock', '--no-open'], io);

    await vi.waitFor(
      () => {
        expect(out.some((l) => l.startsWith('Board: '))).toBe(true);
      },
      { timeout: 15_000 },
    ); // startup checks the git repo, which is slow on CI
    const url = new URL(out.find((l) => l.startsWith('Board: '))!.slice('Board: '.length));
    const token = new URLSearchParams(url.hash.slice(1)).get('token')!;
    expect(url.hostname).toBe('127.0.0.1');
    expect(io.open).not.toHaveBeenCalled();

    const res = await fetch(`${url.origin}/api/snapshot`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const snapshot = Snapshot.parse(await res.json());
    expect(Object.values(snapshot.board.cats)[0]).toMatchObject({
      adapter: 'mock',
      role: 'orchestrator',
    });

    stop();
    expect(await running).toBe(0);
    await expect(fetch(`${url.origin}/api/snapshot`)).rejects.toThrow();
  });

  it('opens the browser unless --no-open is given', async () => {
    project = await gitProject();
    const { io, stop } = testIo();
    const running = main(['--project', project, '--adapter', 'mock'], io);
    await vi.waitFor(
      () => {
        expect(io.open).toHaveBeenCalledWith(
          expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/#token=/),
        );
      },
      { timeout: 15_000 },
    );
    stop();
    expect(await running).toBe(0);
  });

  it('fails with exit code 1 for a missing project', async () => {
    const { io, err } = testIo();
    expect(await main(['--project', join(tmpdir(), 'agentcats-does-not-exist')], io)).toBe(1);
    expect(err.join(' ')).toMatch(/Project directory not found/);
  });

  it('fails with exit code 2 and usage for a bad option', async () => {
    const { io, err } = testIo();
    expect(await main(['--adapter', 'gemini'], io)).toBe(2);
    expect(err.join(' ')).toMatch(/Usage: agentcats/);
  });

  it('explains a project that is not a git repository', async () => {
    project = await mkdtemp(join(tmpdir(), 'agentcats-cli-'));
    const { io, err } = testIo();
    expect(await main(['--project', project, '--adapter', 'mock', '--no-open'], io)).toBe(1);
    expect(err.join(' ')).toMatch(/not a git repository/);
  });

  it('explains an invalid config file', async () => {
    project = await mkdtemp(join(tmpdir(), 'agentcats-cli-'));
    await mkdir(join(project, '.agentcats'));
    await writeFile(
      join(project, '.agentcats', 'agentcats.config.json'),
      JSON.stringify({ permissionMode: 'bypassPermissions' }),
    );
    const { io, err } = testIo();
    expect(await main(['--project', project, '--no-open'], io)).toBe(1);
    expect(err.join(' ')).toMatch(/agentcats\.config\.json is invalid/);
    expect(err.join(' ')).toMatch(/permissionMode/);
  });

  it('explains a missing claude CLI', async () => {
    project = await mkdtemp(join(tmpdir(), 'agentcats-cli-'));
    const path = process.env['PATH'];
    process.env['PATH'] = project;
    try {
      const { io, err } = testIo();
      expect(await main(['--project', project, '--adapter', 'claude', '--no-open'], io)).toBe(1);
      expect(err.join(' ')).toMatch(/was not found on PATH/);
    } finally {
      process.env['PATH'] = path;
    }
  });
});

describe('the Node version check', () => {
  it('explains an old Node before anything loads, and accepts the minimum and newer', () => {
    expect(nodeVersionProblem('v20.11.0')).toMatch(
      /needs Node.js 22.13 or newer .* this is Node.js v20.11.0/,
    );
    expect(nodeVersionProblem('v22.12.0')).not.toBeNull();
    expect(nodeVersionProblem('v22.13.0')).toBeNull();
    expect(nodeVersionProblem('v24.1.0')).toBeNull();
  });

  it('matches engines in package.json', () => {
    expect(cliPackage.engines.node).toBe(`>=${MINIMUM.join('.')}`);
  });
});

describe('doctor and cleanup commands', () => {
  it('parses the command, and rejects an unknown one', () => {
    expect(parseCliArgs(['doctor', '-p', '/work/repo'], '/')).toMatchObject({ command: 'doctor' });
    expect(parseCliArgs([], '/')).toMatchObject({ command: 'run' });
    expect(() => parseCliArgs(['fix-everything'])).toThrow('Unknown command "fix-everything"');
  });

  it('doctor checks a mock project and fails only on what a run needs', async () => {
    project = await gitProject();
    await writeFile(
      join(project, '.agentcats', 'agentcats.config.json'),
      JSON.stringify({ adapter: 'mock', worktreesDir: join(project, '.agentcats', 'worktrees') }),
    );
    const { io, out } = testIo();
    expect(await main(['doctor', '--project', project], io)).toBe(0);
    expect(out).toEqual(
      expect.arrayContaining([
        `✓ Node.js ${process.version}`,
        '✓ Config is valid',
        '✓ agentcats is not running for this project',
      ]),
    );
    // Claude and Codex are optional here: present or not, they never fail the check.
    expect(out.some((l) => l.startsWith('✗'))).toBe(false);
  });

  it('doctor fails on an invalid config and outside a git repository', async () => {
    project = await gitProject();
    await writeFile(join(project, '.agentcats', 'agentcats.config.json'), '{"port": "x"}');
    const { io, out } = testIo();
    expect(await main(['doctor', '--project', project], io)).toBe(1);
    expect(out.join('\n')).toMatch(/✗ .*agentcats.config.json is invalid/);

    const plain = await mkdtemp(join(tmpdir(), 'agentcats-cli-'));
    const second = testIo();
    try {
      expect(await main(['doctor', '--project', plain], second.io)).toBe(1);
      expect(second.out.join('\n')).toMatch(/✗ .*is not a git repository/);
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });

  it('cleanup on a fresh project has nothing to do', async () => {
    project = await gitProject();
    const { io, out } = testIo();
    expect(await main(['cleanup', '--project', project], io)).toBe(0);
    expect(out).toEqual([
      'No leftover agent processes.',
      expect.stringMatching(/^Removed 0 worktree/),
    ]);
  });
});
