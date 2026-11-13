import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createMockAdapter, type MockAdapterOptions } from '@agentcats/adapter-mock';
import {
  AgentcatsConfig,
  type AgentcatsConfigInput,
  type BoardState,
  type Interview,
  Snapshot,
  type Task,
} from '@agentcats/protocol';
import type { Adapter } from '@agentcats/protocol/adapter';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type RunningDaemon, startDaemon } from '../src/index.js';
import { tempDir, tempProject } from './harness.js';

/**
 * Two adapters: `mock` (the default; reports cost, has MCP) and `blind`,
 * which reports no cost, like Codex.
 */
const mock = (options: MockAdapterOptions = {}) =>
  createMockAdapter({ timeScale: 0, realFiles: true, ...options });
const blind = (options: MockAdapterOptions = {}) =>
  mock({ id: 'blind', reportsCost: false, ...options });

let daemon: RunningDaemon | null = null;
const dirs: string[] = [];
afterEach(async () => {
  await daemon?.close();
  daemon = null;
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true, maxRetries: 5 });
});

async function start(config: AgentcatsConfigInput, adapters: Adapter[] = [mock(), blind()]) {
  const projectPath = await tempProject();
  const worktreesDir = await tempDir('agentcats-wt-');
  dirs.push(projectPath, worktreesDir);
  const [first, ...rest] = adapters;
  daemon = await startDaemon({
    projectPath,
    adapter: first!,
    adapters: rest,
    config: AgentcatsConfig.parse({ adapter: 'mock', worktreesDir, ...config }),
  });
  return { projectPath, worktreesDir };
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

async function snapshot() {
  return Snapshot.parse((await api('GET', '/api/snapshot')).body);
}

async function waitFor<T>(read: (b: BoardState) => T | null | undefined | false): Promise<T> {
  let value: T | null | undefined | false;
  await vi.waitFor(
    async () => {
      value = read((await snapshot()).board);
      expect(value).toBeTruthy();
    },
    { timeout: 15_000, interval: 25 },
  );
  return value as T;
}

describe('teams that mix adapters', () => {
  it('runs a lead on one adapter and workers on another, to a reviewable branch', async () => {
    await start({ workers: { adapter: 'blind' } });
    const res = await api('POST', '/api/chat', { text: 'Add a login endpoint\n/single' });
    expect(res.status).toBe(202);
    const task = await waitFor((b) => Object.values(b.tasks).find((t) => t.status === 'review'));
    const board = (await snapshot()).board;
    const lead = Object.values(board.cats).find((c) => c.role === 'orchestrator')!;
    const worker = board.cats[task.assigneeCatId!]!;
    expect(lead.adapter).toBe('mock');
    expect(worker.adapter).toBe('blind');
    expect(worker.model).toBe('mock-balanced'); // the adapter's balanced tier
    expect(task.result?.branch).toMatch(/^agentcats\//);
    expect(task.result?.diffStat.files).toBeGreaterThan(0);
  });

  it('lists every adapter with its capabilities in the snapshot', async () => {
    await start({});
    const { adapters } = await snapshot();
    expect(adapters.map((a) => [a.id, a.capabilities.reportsCost])).toEqual([
      ['mock', true],
      ['blind', false],
    ]);
  });

  it('refuses to start a lead on an adapter without MCP', async () => {
    const noMcp: Adapter = { ...blind(), capabilities: { ...blind().capabilities, mcp: false } };
    await expect(start({ orchestrator: { adapter: 'blind' } }, [mock(), noMcp])).rejects.toThrow(
      /cannot run on .* no MCP support/,
    );
  });

  it('moves a cat to another adapter from its next session, and refuses unknown ones', async () => {
    await start({});
    const created = (await api('POST', '/api/tasks', { title: 'First' })).body as { task: Task };
    const done = await waitFor(
      (b) => b.tasks[created.task.id]?.status === 'review' && b.tasks[created.task.id],
    );
    const catId = done.assigneeCatId!;
    expect((await api('PATCH', `/api/cats/${catId}`, { adapter: 'nope' })).status).toBe(400);
    expect((await api('PATCH', `/api/cats/${catId}`, { adapter: 'blind' })).status).toBe(200);
    const next = (await api('POST', '/api/tasks', { title: 'Second', catId })).body as {
      task: Task;
    };
    await waitFor((b) => b.tasks[next.task.id]?.status === 'review');
    const usage = (await snapshot()).board.usage[catId];
    expect(usage?.costUsd).toBeNull(); // its last session ran on the cost-blind adapter
  });
});

describe('cats whose adapter reports no cost', () => {
  it('show cost unknown, and are paused by their time budget', async () => {
    await start({ workers: { adapter: 'blind' }, budget: { perCatMinutes: 0.001 } }, [
      mock(),
      blind({ timeScale: 0.05 }),
    ]);
    const created = (
      await api('POST', '/api/tasks', { title: 'Slow job', description: '/expensive' })
    ).body as {
      task: Task;
    };
    const paused = await waitFor((b) => {
      const task = b.tasks[created.task.id];
      const cat = task?.assigneeCatId ? b.cats[task.assigneeCatId] : undefined;
      return cat?.pausedReason === 'budget' && cat;
    });
    const board = (await snapshot()).board;
    expect(board.usage[paused.id]).toMatchObject({ costUsd: null, costSource: 'unknown' });
    expect(board.usage[paused.id]?.activeMs).toBeGreaterThan(0);
    expect(board.tasks[created.task.id]?.status).toBe('blocked');
    expect(paused.budget.maxMinutes).toBe(0.001);
  });

  it('measures working time for every cat', async () => {
    await start({});
    const created = (await api('POST', '/api/tasks', { title: 'Timed' })).body as { task: Task };
    const done = await waitFor(
      (b) => b.tasks[created.task.id]?.status === 'review' && b.tasks[created.task.id],
    );
    expect((await snapshot()).board.usage[done.assigneeCatId!]?.activeMs).toBeGreaterThanOrEqual(0);
  });
});

describe('interviews across adapters', () => {
  it('compares candidates on two adapters, with an unknown estimate', async () => {
    const { projectPath } = await start({}, [
      mock({ scenarioFor: () => 'interview-pass' }),
      blind({ scenarioFor: () => 'interview-pass' }),
    ]);
    const dir = join(projectPath, '.agentcats', 'interviews');
    await mkdir(join(dir, 'answer', 'hidden'), { recursive: true });
    await writeFile(
      join(dir, 'answer.md'),
      '---\ntitle: Answer\nrepo: fixture\ncheck: node check.cjs\n---\n\nWrite 42 to answer.txt.\n',
    );
    await writeFile(
      join(dir, 'answer', 'hidden', 'check.cjs'),
      "process.exit(require('node:fs').readFileSync('answer.txt', 'utf8').trim() === '42' ? 0 : 1);\n",
    );
    const proposed = await api('POST', '/api/interviews', {
      role: { description: 'Compare agents', tier: 'balanced' },
      sampleId: 'answer',
      adapters: ['mock', 'blind'],
    });
    expect(proposed.status).toBe(201);
    const interview = (proposed.body as { interview: Interview }).interview;
    expect(interview).toMatchObject({
      candidateCount: 2,
      candidateAdapters: ['mock', 'blind'],
      estimateUsd: null,
    });

    await api('POST', `/api/interviews/${interview.id}/start`);
    const decided = await waitFor(
      (b) => b.interviews[interview.id]?.status === 'deciding' && b.interviews[interview.id],
    );
    const board = (await snapshot()).board;
    expect(decided.candidates.map((c) => board.cats[c.catId]?.adapter)).toEqual(['mock', 'blind']);
    expect(decided.candidates.every((c) => c.result?.passed)).toBe(true);
    const blindCandidate = decided.candidates[1]!;
    expect(blindCandidate.result?.costUsd).toBeNull();
    expect(blindCandidate.score?.cost).toBe(50); // unknown cost is neither rewarded nor punished
  });

  it('refuses an adapter the daemon does not have', async () => {
    await start({});
    const res = await api('POST', '/api/interviews', {
      role: { description: 'x', tier: 'fast' },
      sampleId: 'add-function',
      adapters: ['nope'],
    });
    expect(res.status).toBe(400);
  });
});
