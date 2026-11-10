import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createMockAdapter } from '@agentcats/adapter-mock';
import { isProcessAlive, killProcessTree } from '@agentcats/kit';
import { AgentcatsConfig, Snapshot, type Task } from '@agentcats/protocol';
import { describe, expect, it, vi } from 'vitest';

import { startDaemon } from '../src/index.js';
import { tempDir, tempProject } from './harness.js';

const pidsFile = (projectPath: string) => join(projectPath, '.agentcats', 'run', 'pids.json');

async function recordedPids(projectPath: string): Promise<number[]> {
  const file = JSON.parse(
    await readFile(pidsFile(projectPath), 'utf8').catch(() => '{"processes":[]}'),
  ) as {
    processes: { pid: number }[];
  };
  return file.processes.map((p) => p.pid);
}

async function waitForPid(projectPath: string): Promise<number> {
  let pid = 0;
  await vi.waitFor(
    async () => {
      [pid = 0] = await recordedPids(projectPath);
      expect(pid).toBeGreaterThan(0);
    },
    { timeout: 10_000, interval: 50 },
  );
  return pid;
}

function client(url: string, token: string) {
  return async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: await res.json() };
  };
}

async function waitUntilDead(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isProcessAlive(pid)) {
    if (Date.now() > deadline) throw new Error(`pid ${String(pid)} is still alive`);
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

async function cleanup(...dirs: string[]) {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true, maxRetries: 10 });
}

describe('agent process cleanup', () => {
  it('records the worker pid and kills it on graceful shutdown', async () => {
    const projectPath = await tempProject();
    const worktreesDir = await tempDir('agentcats-wt-');
    const daemon = await startDaemon({
      projectPath,
      adapter: createMockAdapter({
        timeScale: 0,
        scenario: 'hang',
        spawnProcess: true,
        realFiles: true,
      }),
      config: AgentcatsConfig.parse({ adapter: 'mock', worktreesDir }),
    });
    const api = client(daemon.url, daemon.token);
    expect((await api('POST', '/api/tasks', { title: 'long job' })).status).toBe(201);
    const pid = await waitForPid(projectPath);
    expect(isProcessAlive(pid)).toBe(true);

    await daemon.close();
    expect(isProcessAlive(pid)).toBe(false);
    await cleanup(projectPath, worktreesDir);
  });

  it('survives a hard kill mid-task: no orphan, tasks interrupted, nothing lost, re-runnable', async () => {
    const projectPath = await tempProject();
    const worktreesDir = await tempDir('agentcats-wt-');
    const fixture = fileURLToPath(new URL('./fixtures/run-daemon.ts', import.meta.url));
    const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
    const child = spawn(
      process.execPath,
      ['--conditions=@agentcats/source', '--import', tsx, fixture, projectPath, worktreesDir],
      { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true },
    );
    const line = await new Promise<string>((resolve) =>
      createInterface({ input: child.stdout }).once('line', resolve),
    );
    const { url, token } = JSON.parse(line) as { url: string; token: string };
    const api = client(url, token);
    const created = (await api('POST', '/api/tasks', { title: 'long job' })).body as { task: Task };
    const agentPid = await waitForPid(projectPath);
    await vi.waitFor(async () => {
      const snap = Snapshot.parse((await api('GET', '/api/snapshot')).body);
      expect(snap.board.tasks[created.task.id]?.status).toBe('running');
    });
    const before = Snapshot.parse((await api('GET', '/api/snapshot')).body);

    process.kill(child.pid!, 'SIGKILL'); // no shutdown code runs
    await waitUntilDead(agentPid);

    const restarted = await startDaemon({
      projectPath,
      adapter: createMockAdapter({ timeScale: 0, realFiles: true }),
      config: AgentcatsConfig.parse({ adapter: 'mock', worktreesDir }),
    });
    const api2 = client(restarted.url, restarted.token);
    const after = Snapshot.parse((await api2('GET', '/api/snapshot')).body);

    // Nothing lost: every event from before the kill is still there, in order.
    expect(after.events.slice(0, before.events.length).map((e) => e.id)).toEqual(
      before.events.map((e) => e.id),
    );
    const task = after.board.tasks[created.task.id]!;
    expect(task).toMatchObject({ status: 'interrupted', reasonCode: 'daemon_restarted' });
    expect(await stat(task.worktreePath!)).toBeTruthy();
    expect(Object.values(after.board.cats).every((c) => c.status === 'idle')).toBe(true);

    // The user can re-run it, in the same worktree.
    const rerun = (await api2('POST', `/api/tasks/${task.id}/rerun`)).body as { task: Task };
    expect(rerun.task).toMatchObject({ status: 'queued', attempt: 2 });
    await vi.waitFor(
      async () => {
        const snap = Snapshot.parse((await api2('GET', '/api/snapshot')).body);
        expect(snap.board.tasks[task.id]?.status).toBe('review');
      },
      { timeout: 10_000 },
    );

    await restarted.close();
    await cleanup(projectPath, worktreesDir);
  }, 60_000);

  it('reaps a recorded leftover on startup, but spares a reused pid', async () => {
    const projectPath = await tempProject();
    const worktreesDir = await tempDir('agentcats-wt-');
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
      config: AgentcatsConfig.parse({ adapter: 'mock', worktreesDir }),
    });

    expect(isProcessAlive(leftover)).toBe(false);
    expect(isProcessAlive(reused)).toBe(true);
    expect(await recordedPids(projectPath)).toEqual([]);

    await daemon.close();
    await killProcessTree(reused);
    await cleanup(projectPath, worktreesDir);
  }, 30_000);

  it('refuses to start outside a git repository, with a clear message', async () => {
    const dir = await tempDir();
    await expect(
      startDaemon({
        projectPath: dir,
        adapter: createMockAdapter({ timeScale: 0 }),
        config: AgentcatsConfig.parse({ adapter: 'mock', worktreesDir: dir }),
      }),
    ).rejects.toThrow(/not a git repository/);
    await cleanup(dir);
  });
});
