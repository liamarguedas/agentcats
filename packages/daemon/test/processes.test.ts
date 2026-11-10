import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { isProcessAlive, killProcessTree } from '@agentcats/kit';
import { createMockAdapter } from '@agentcats/adapter-mock';
import { AgentcatsConfig } from '@agentcats/protocol';
import { describe, expect, it } from 'vitest';

import { startDaemon } from '../src/index.js';
import { connectEvents, isType, tempProject } from './harness.js';

const pidsFile = (projectPath: string) => join(projectPath, '.agentcats', 'run', 'pids.json');

async function recordedPids(projectPath: string): Promise<number[]> {
  const file = JSON.parse(await readFile(pidsFile(projectPath), 'utf8')) as {
    processes: { pid: number }[];
  };
  return file.processes.map((p) => p.pid);
}

async function startTask(url: string, token: string): Promise<void> {
  const res = await fetch(`${url}/api/tasks`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'long job' }),
  });
  expect(res.status).toBe(201);
}

async function waitUntilDead(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isProcessAlive(pid)) {
    if (Date.now() > deadline) throw new Error(`pid ${pid} is still alive`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** A process the test owns, standing in for a leftover agent. */
async function spawnSleeper(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  await new Promise((r) => child.once('spawn', r));
  return child.pid!;
}

describe('agent process cleanup', () => {
  it('records the agent pid and kills it on graceful shutdown', async () => {
    const projectPath = await tempProject();
    const daemon = await startDaemon({
      projectPath,
      adapter: createMockAdapter({ timeScale: 0, scenario: 'hang', spawnProcess: true }),
      config: AgentcatsConfig.parse({ adapter: 'mock' }),
    });
    const stream = await connectEvents(daemon);
    await startTask(daemon.url, daemon.token);
    await stream.waitFor(isType('tool.called'));

    const [pid] = await recordedPids(projectPath);
    expect(pid).toBeDefined();
    expect(isProcessAlive(pid!)).toBe(true);

    stream.close();
    await daemon.close();
    expect(isProcessAlive(pid!)).toBe(false);
    await rm(projectPath, { recursive: true, force: true, maxRetries: 5 });
  });

  it('leaves no orphan when the daemon is hard-killed', async () => {
    const projectPath = await tempProject();
    const fixture = fileURLToPath(new URL('./fixtures/run-daemon.ts', import.meta.url));
    const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
    const daemonProcess = spawn(
      process.execPath,
      ['--conditions=@agentcats/source', '--import', tsx, fixture, projectPath],
      { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true },
    );
    const line = await new Promise<string>((resolve) =>
      createInterface({ input: daemonProcess.stdout }).once('line', resolve),
    );
    const { url, token } = JSON.parse(line) as { url: string; token: string };
    await startTask(url, token);
    const [agentPid] = await recordedPids(projectPath);
    expect(isProcessAlive(agentPid!)).toBe(true);

    process.kill(daemonProcess.pid!, 'SIGKILL'); // no shutdown code runs

    await waitUntilDead(agentPid!);
    await rm(projectPath, { recursive: true, force: true, maxRetries: 5 });
  }, 30_000);

  it('reaps a recorded leftover on startup, but spares a reused pid', async () => {
    const projectPath = await tempProject();
    const leftover = await spawnSleeper();
    const reused = await spawnSleeper();
    await mkdir(join(projectPath, '.agentcats', 'run'), { recursive: true });
    await writeFile(
      pidsFile(projectPath),
      JSON.stringify({
        version: 1,
        processes: [
          { pid: leftover, startedAt: Date.now(), catId: 'old' },
          // Recorded a day ago: the live process with this pid is not ours.
          { pid: reused, startedAt: Date.now() - 86_400_000, catId: 'old' },
        ],
      }),
    );

    const daemon = await startDaemon({
      projectPath,
      adapter: createMockAdapter({ timeScale: 0 }),
      config: AgentcatsConfig.parse({ adapter: 'mock' }),
    });

    expect(isProcessAlive(leftover)).toBe(false);
    expect(isProcessAlive(reused)).toBe(true);
    expect(await recordedPids(projectPath)).toEqual([]);

    await daemon.close();
    await killProcessTree(reused);
    await rm(projectPath, { recursive: true, force: true, maxRetries: 5 });
  }, 30_000);
});
