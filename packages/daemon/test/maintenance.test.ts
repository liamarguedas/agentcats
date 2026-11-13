import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createMockAdapter } from '@agentcats/adapter-mock';
import { AgentcatsConfig, Snapshot, type Task } from '@agentcats/protocol';
import { describe, expect, it, vi } from 'vitest';

import { cleanupProject, inspectProject, startDaemon } from '../src/index.js';
import { tempDir, tempProject } from './harness.js';

/** A project after a run: one task in review, two killed (one with uncommitted work), one stray directory. */
async function projectWithLeftovers() {
  const projectPath = await tempProject();
  const worktreesDir = await tempDir('agentcats-wt-');
  const config = AgentcatsConfig.parse({ adapter: 'mock', worktreesDir });
  const daemon = await startDaemon({
    projectPath,
    adapter: createMockAdapter({ timeScale: 0, realFiles: true }),
    config,
  });
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${daemon.url}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${daemon.token}`,
        Origin: daemon.url,
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return text ? (JSON.parse(text) as unknown) : null;
  };
  const task = async (title: string, description: string) =>
    ((await api('POST', '/api/tasks', { title, description })) as { task: Task }).task;
  const status = async (id: string, wanted: string) => {
    let found: Task | undefined;
    await vi.waitFor(
      async () => {
        found = Snapshot.parse(await api('GET', '/api/snapshot')).board.tasks[id];
        expect(found?.status).toBe(wanted);
      },
      { timeout: 15_000, interval: 25 },
    );
    return found!;
  };
  try {
    const reviewed = await task('done work', '');
    const killed = await task('long job', '/hang');
    const dirty = await task('another long job', '/hang');
    await status(reviewed.id, 'review');
    for (const t of [killed, dirty]) {
      const running = await status(t.id, 'running');
      await api('POST', `/api/cats/${running.assigneeCatId!}/kill`);
      await status(t.id, 'failed');
    }
    const dirtyTree = (await status(dirty.id, 'failed')).worktreePath!;
    await writeFile(join(dirtyTree, 'unsaved.txt'), 'work in progress\n');
    await mkdir(join(worktreesDir, 'stray'));
    return {
      projectPath,
      worktreesDir,
      config,
      daemon,
      trees: {
        reviewed: join(worktreesDir, reviewed.id),
        killed: join(worktreesDir, killed.id),
        dirty: dirtyTree,
      },
    };
  } catch (error) {
    await daemon.close();
    throw error;
  }
}

describe('doctor and cleanup', () => {
  it('reports leftovers, refuses while running, then removes only clean worktrees of finished tasks', async () => {
    const p = await projectWithLeftovers();
    try {
      const running = await inspectProject(p.projectPath, p.config);
      expect(running.daemon?.url).toBe(p.daemon.url);
      await expect(cleanupProject(p.projectPath, p.config)).rejects.toThrow(
        /running for this project .* Stop it before cleaning up/,
      );
    } finally {
      await p.daemon.close();
    }

    const report = await inspectProject(p.projectPath, p.config);
    expect(report.daemon).toBeNull();
    const byPath = Object.fromEntries(report.worktrees.map((w) => [w.path, w]));
    expect(byPath[p.trees.reviewed]).toMatchObject({ removable: false, dirty: false });
    expect(byPath[p.trees.killed]).toMatchObject({ removable: true, dirty: false });
    expect(byPath[p.trees.dirty]).toMatchObject({ removable: true, dirty: true });
    expect(byPath[join(p.worktreesDir, 'stray')]).toMatchObject({
      owner: 'unknown',
      removable: false,
    });

    const result = await cleanupProject(p.projectPath, p.config);
    expect(result.removed).toEqual([p.trees.killed]);
    const kept = Object.fromEntries(result.kept.map((k) => [k.path, k.reason]));
    expect(kept[p.trees.reviewed]).toMatch(/in use \(task .* \(review\)\)/);
    expect(kept[p.trees.dirty]).toBe('uncommitted changes');
    expect(await stat(p.trees.killed).catch(() => null)).toBeNull();
    expect(await stat(join(p.trees.dirty, 'unsaved.txt'))).toBeTruthy();

    for (const dir of [p.projectPath, p.worktreesDir]) {
      await rm(dir, { recursive: true, force: true, maxRetries: 10 });
    }
  }, 60_000);
});
