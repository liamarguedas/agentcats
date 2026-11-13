import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { codexReadiness } from './codex-adapter.js';

let home = '';
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('codexReadiness', () => {
  it('is ready with a Codex login in ~/.codex', async () => {
    home = await mkdtemp(join(tmpdir(), 'agentcats-codex-'));
    await mkdir(join(home, '.codex'));
    await writeFile(join(home, '.codex', 'auth.json'), '{}');
    const readiness = await codexReadiness({}, home);
    expect(readiness.ready).toBe(true);
    expect(readiness.detail).toContain(`with your Codex login in ${join(home, '.codex')}`);
  });

  it('honors CODEX_HOME, and an API key in the environment', async () => {
    home = await mkdtemp(join(tmpdir(), 'agentcats-codex-'));
    await writeFile(join(home, 'auth.json'), '{}');
    expect((await codexReadiness({ CODEX_HOME: home }, '/nowhere')).ready).toBe(true);
    const withKey = await codexReadiness({ OPENAI_API_KEY: 'sk-test' }, home);
    expect(withKey.ready).toBe(true);
    expect(withKey.detail).toContain('with OPENAI_API_KEY');
  });

  it('is not ready without a login, and says how to log in', async () => {
    home = await mkdtemp(join(tmpdir(), 'agentcats-codex-'));
    expect(await codexReadiness({}, home)).toEqual({
      ready: false,
      detail:
        'Codex is not logged in. Install the Codex CLI and run `codex login`, or set OPENAI_API_KEY.',
    });
  });
});
