import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { PidRegistry } from './pid-registry.js';

let dir = '';
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  dir = '';
});

const recorded = async (file: string) =>
  (JSON.parse(await readFile(file, 'utf8')) as { processes: { pid: number }[] }).processes.map(
    (p) => p.pid,
  );

describe('PidRegistry', () => {
  it('settles once the writes started so far are done', async () => {
    dir = await mkdtemp(join(tmpdir(), 'agentcats-pids-'));
    const file = join(dir, 'run', 'pids.json');
    const registry = new PidRegistry(file);
    const write = registry.add(4242, 'cat');
    await registry.settled();
    await write;
    expect(await recorded(file)).toEqual([4242]);
  });

  it('keeps every write while another process keeps reading the file', async () => {
    dir = await mkdtemp(join(tmpdir(), 'agentcats-pids-'));
    const file = join(dir, 'run', 'pids.json');
    const registry = new PidRegistry(file);
    await registry.reapOrphans();

    // A reader holding the file open is what breaks a rename-over on Windows.
    // It polls every 10 ms: five times more often than the hard-kill test that
    // first hit this, and far more than an editor or antivirus would.
    const reader = { active: true };
    const reading = (async () => {
      while (reader.active) {
        await readFile(file).catch(() => undefined);
        await new Promise((r) => setTimeout(r, 10));
      }
    })();

    const pids = Array.from({ length: 60 }, (_, i) => 100_000 + i);
    for (const pid of pids) await registry.add(pid, 'cat');
    for (const pid of pids.slice(0, 30)) await registry.remove(pid);
    reader.active = false;
    await reading;

    expect(await recorded(file)).toEqual(pids.slice(30));
  }, 30_000); // 90 serialized writes, some retried while the reader holds the file
});
