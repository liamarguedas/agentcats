import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { createMockAdapter } from '@agentcats/adapter-mock';
import {
  AgentcatsConfig,
  type AgentcatsConfigInput,
  type BoardState,
  type Settings,
  type SettingsResponse,
  Snapshot,
  type Task,
} from '@agentcats/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type RunningDaemon, startDaemon } from '../src/index.js';
import { tempDir, tempProject } from './harness.js';

/** Two agents: `mock` and a cost-blind mock registered as `codex`. */
const agents = () => [
  createMockAdapter({ timeScale: 0, realFiles: true }),
  createMockAdapter({ id: 'codex', reportsCost: false, timeScale: 0, realFiles: true }),
];

let daemon: RunningDaemon | null = null;
let home = '';
const dirs: string[] = [];
beforeEach(async () => {
  home = await tempDir('agentcats-home-');
  dirs.push(home);
  vi.stubEnv('AGENTCATS_HOME', home);
});
afterEach(async () => {
  await daemon?.close();
  daemon = null;
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true, maxRetries: 5 });
});

async function start(config: AgentcatsConfigInput = {}, projectPath?: string) {
  const project = projectPath ?? (await tempProject());
  const worktreesDir = await tempDir('agentcats-wt-');
  if (!projectPath) dirs.push(project);
  dirs.push(worktreesDir);
  const [first, ...rest] = agents();
  daemon = await startDaemon({
    projectPath: project,
    adapter: first!,
    adapters: rest,
    config: AgentcatsConfig.parse({ adapter: 'mock', worktreesDir, ...config }),
  });
  return project;
}

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${daemon!.url}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${daemon!.token}`,
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as unknown) : null };
}

const board = async (): Promise<BoardState> =>
  Snapshot.parse((await api('GET', '/api/snapshot')).body).board;

async function waitFor<T>(read: (b: BoardState) => T | undefined | null | false): Promise<T> {
  let value: T | undefined | null | false;
  await vi.waitFor(
    async () => {
      value = read(await board());
      expect(value).toBeTruthy();
    },
    { timeout: 15_000, interval: 25 },
  );
  return value as T;
}

const readJson = async (file: string) => JSON.parse(await readFile(file, 'utf8')) as unknown;

describe('settings', () => {
  it('saves for the project only what changed, applies it, and moves the cats picked', async () => {
    const project = await start();
    const created = (await api('POST', '/api/tasks', { title: 'First' })).body as { task: Task };
    const done = await waitFor(
      (b) => b.tasks[created.task.id]?.status === 'review' && b.tasks[created.task.id],
    );
    const workerId = done.assigneeCatId!;

    const read = (await api('GET', '/api/settings')).body as SettingsResponse;
    expect(read.settings).toMatchObject({ adapter: 'mock', workers: { max: 3 } });
    expect(read.builtIn.adapter).toBe('claude');
    expect(read.files.global).toBe(join(home, 'agentcats.config.json'));

    const next: Settings = {
      ...read.settings,
      workers: { ...read.settings.workers, adapter: 'codex', max: 5 },
      captions: { enabled: false },
    };
    const saved = await api('POST', '/api/settings', {
      scope: 'project',
      settings: next,
      moveCats: [workerId],
    });
    expect(saved.status).toBe(200);
    expect((saved.body as SettingsResponse).settings.workers).toMatchObject({
      adapter: 'codex',
      max: 5,
    });
    // Only what differs from the built-in defaults is pinned in the project file.
    expect(await readJson(join(project, '.agentcats', 'agentcats.config.json'))).toEqual({
      adapter: 'mock',
      workers: { adapter: 'codex', max: 5 },
      captions: { enabled: false },
    });
    const after = await board();
    expect(after.cats[workerId]?.adapter).toBe('codex');
    const lead = Object.values(after.cats).find((c) => c.role === 'orchestrator')!;
    expect(lead.adapter).toBe('mock');
  });

  it('saves as the user defaults, and refuses an agent this run does not have', async () => {
    const project = await start();
    const { settings } = (await api('GET', '/api/settings')).body as SettingsResponse;
    const global = await api('POST', '/api/settings', {
      scope: 'global',
      settings: { ...settings, budget: { ...settings.budget, perCatUsd: 4 } },
    });
    expect(global.status).toBe(200);
    expect(await readJson(join(home, 'agentcats.config.json'))).toMatchObject({
      budget: { perCatUsd: 4 },
    });

    const refused = await api('POST', '/api/settings', {
      scope: 'project',
      settings: { ...settings, orchestrator: { adapter: 'claude', model: null } },
    });
    expect(refused.status).toBe(400);
    expect((refused.body as { error: { message: string } }).error.message).toMatch(
      /claude is not available/,
    );
    // Nothing was written for the refused save.
    await expect(readFile(join(project, '.agentcats', 'agentcats.config.json'))).rejects.toThrow();
  });

  it('says at start when a cat runs on another agent than the defaults', async () => {
    const project = await start({ orchestrator: { adapter: 'codex' } });
    await daemon!.close();
    daemon = null;
    await start({}, project);
    const { events } = Snapshot.parse((await api('GET', '/api/snapshot')).body);
    const notice = events.find(
      (e) => e.type === 'notice' && e.payload.code === 'cat_agent_differs',
    );
    expect(notice?.type === 'notice' && notice.payload.message).toMatch(
      /Tux \(the lead\) runs on Mock \(codex\)/,
    );
  });
});
