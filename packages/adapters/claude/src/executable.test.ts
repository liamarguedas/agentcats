import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createClaudeAdapter } from './claude-adapter.js';
import { claudeVersion, resolveClaudeExecutable } from './executable.js';

const isWindows = process.platform === 'win32';
let dir = '';
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('resolveClaudeExecutable', () => {
  it('finds claude on PATH', async () => {
    dir = await mkdtemp(join(tmpdir(), 'agentcats-exe-'));
    const name = isWindows ? 'claude.exe' : 'claude';
    await writeFile(join(dir, name), '');
    const env = { PATH: [join(dir, 'missing'), dir].join(delimiter) };
    expect(await resolveClaudeExecutable(null, env)).toBe(join(dir, name));
  });

  it('returns null when claude is nowhere on PATH', async () => {
    dir = await mkdtemp(join(tmpdir(), 'agentcats-exe-'));
    expect(await resolveClaudeExecutable(null, { PATH: dir })).toBeNull();
  });

  it('prefers the configured path and rejects one that does not exist', async () => {
    dir = await mkdtemp(join(tmpdir(), 'agentcats-exe-'));
    const custom = join(dir, 'my-claude');
    await writeFile(custom, '');
    expect(await resolveClaudeExecutable(custom, { PATH: '' })).toBe(custom);
    expect(await resolveClaudeExecutable(join(dir, 'nope'), { PATH: '' })).toBeNull();
  });

  it.runIf(isWindows)('follows an npm claude.cmd shim to the script it runs', async () => {
    dir = await mkdtemp(join(tmpdir(), 'agentcats-exe-'));
    const target = join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, '');
    await writeFile(
      join(dir, 'claude.cmd'),
      '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n',
    );
    expect(await resolveClaudeExecutable(null, { PATH: dir })).toBe(target);
  });
});

describe('claudeVersion', () => {
  it('parses the version from --version output', async () => {
    dir = await mkdtemp(join(tmpdir(), 'agentcats-exe-'));
    const script = join(dir, 'fake-claude.mjs');
    await writeFile(script, "console.log('2.1.302 (Claude Code)');");
    expect(await claudeVersion(script)).toBe('2.1.302');
  });
});

describe('preflight', () => {
  /** A fake `claude` script answering `--version` and `auth status`, logged in or not. */
  async function fakeClaude(auth: string, exitCode: number): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), 'agentcats-exe-'));
    const file = join(dir, 'claude.mjs');
    await writeFile(
      file,
      `const args = process.argv.slice(2);
if (args[0] === '--version') console.log('2.1.302 (Claude Code)');
else if (args.join(' ') === 'auth status') { console.log(${JSON.stringify(auth)}); process.exitCode = ${String(exitCode)}; }`,
    );
    return file;
  }

  it('is ready when Claude Code is logged in, and says how', async () => {
    const file = await fakeClaude('{"loggedIn": true, "authMethod": "claude.ai"}', 0);
    expect(await createClaudeAdapter({ executablePath: file }).preflight?.()).toEqual({
      ready: true,
      detail: `Claude Code 2.1.302 at ${file}, logged in (claude.ai)`,
    });
  });

  it('is not ready when logged out, and says how to log in', async () => {
    const file = await fakeClaude('{"loggedIn": false, "authMethod": "none"}', 1);
    const readiness = await createClaudeAdapter({ executablePath: file }).preflight?.();
    expect(readiness?.ready).toBe(false);
    expect(readiness?.detail).toMatch(/is not logged in\. Run `claude` and log in with \/login/);
  });

  it('cannot tell on a CLI without `auth status`, so it does not block', async () => {
    const file = await fakeClaude('unknown command', 1);
    const readiness = await createClaudeAdapter({ executablePath: file }).preflight?.();
    expect(readiness).toEqual({ ready: true, detail: `Claude Code 2.1.302 at ${file}` });
  });

  it('is not ready when Claude Code is missing', async () => {
    dir = await mkdtemp(join(tmpdir(), 'agentcats-exe-'));
    const readiness = await createClaudeAdapter({
      executablePath: join(dir, 'missing'),
    }).preflight?.();
    expect(readiness?.ready).toBe(false);
    expect(readiness?.detail).toMatch(/not found/);
  });
});
