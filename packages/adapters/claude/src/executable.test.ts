import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

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
