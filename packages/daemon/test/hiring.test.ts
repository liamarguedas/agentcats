import { readFileSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { isProcessAlive } from '@agentcats/kit';
import {
  type BoardState,
  type Cat,
  type Interview,
  Snapshot,
  type Task,
  type TaskStatus,
} from '@agentcats/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { connectEvents, type EventStream, startTestDaemon, type TestDaemon } from './harness.js';

let t: TestDaemon;
let stream: EventStream;
afterEach(async () => {
  stream.close();
  await t.close();
});

async function setup(...args: Parameters<typeof startTestDaemon>) {
  t = await startTestDaemon(...args);
  stream = await connectEvents(t.daemon);
}

async function board(): Promise<BoardState> {
  return Snapshot.parse((await t.api('GET', '/api/snapshot')).body).board;
}

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

async function createTask(title: string, description = ''): Promise<Task> {
  const res = await t.api('POST', '/api/tasks', { title, description });
  expect(res.status).toBe(201);
  return (res.body as { task: Task }).task;
}

const statusIs = (taskId: string, status: TaskStatus) => (b: BoardState) =>
  b.tasks[taskId]?.status === status && b.tasks[taskId];

const cats = (dir: string) => join(t.projectPath, '.agentcats', dir);
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** A worker with two learnings and some XP, done with its first task. */
async function seasonedWorker(): Promise<Cat> {
  const task = await createTask('First task');
  const reviewed = await waitFor(statusIs(task.id, 'review'));
  await t.api('POST', `/api/tasks/${task.id}/review`, { decision: 'accept' });
  const catId = reviewed.assigneeCatId!;
  for (const text of ['Tests use the makeUser fixture', 'Routes live in src/routes.js']) {
    expect((await t.api('POST', `/api/cats/${catId}/learnings`, { text })).status).toBe(200);
  }
  return waitFor((b) => ((b.cats[catId]?.xp ?? 0) > 0 ? b.cats[catId] : null));
}

describe('retire and bring back', () => {
  it('archives a cat and brings it back with its learnings, XP and level', async () => {
    await setup({}, { xp: { accepted: 40 } });
    const cat = await seasonedWorker();
    expect(cat.level).toBe(2);

    const res = await t.api('POST', `/api/cats/${cat.id}/retire`, { reason: 'Not needed now' });
    expect(res).toMatchObject({ status: 200, body: { retired: true } });
    const archive = join(cats('retired'), `${cat.name}-${cat.id.slice(0, 8)}`);
    expect(await exists(join(cats('cats'), cat.name))).toBe(false);
    expect(await readFile(join(archive, 'learnings.md'), 'utf8')).toContain('makeUser fixture');
    expect(JSON.parse(await readFile(join(archive, 'retired.json'), 'utf8'))).toMatchObject({
      reason: 'Not needed now',
      level: 2,
      xp: cat.xp,
    });
    const retired = await board();
    expect(retired.cats[cat.id]).toBeUndefined();
    expect(retired.retired[cat.id]?.retired).toMatchObject({ name: cat.name, level: 2 });

    const back = await t.api('POST', `/api/retired/${cat.id}/resurrect`);
    expect(back.status).toBe(200);
    const restored = (await board()).cats[cat.id]!;
    expect(restored).toMatchObject({ name: cat.name, xp: cat.xp, level: 2, role: 'worker' });
    expect(restored.learnings.map((l) => l.text)).toEqual(cat.learnings.map((l) => l.text));
    expect(await readFile(join(cats('cats'), cat.name, 'learnings.md'), 'utf8')).toContain(
      'makeUser fixture',
    );
    expect(await exists(archive)).toBe(false);

    // And it works again.
    const next = await t.api('POST', '/api/tasks', { title: 'Second task', catId: cat.id });
    await waitFor(statusIs((next.body as { task: Task }).task.id, 'review'));
  });

  it('warns about an open task, then cancels it and leaves no worktree or process behind', async () => {
    await setup({ spawnProcess: true });
    const task = await createTask('long job', '/hang');
    const running = await waitFor(statusIs(task.id, 'running'));
    const catId = running.assigneeCatId!;
    const check = await t.api('GET', `/api/cats/${catId}/retire-check`);
    expect(check.body).toMatchObject({ openTask: { id: task.id } });
    const pid = await waitFor(() => {
      const record = JSON.parse(readFileSyncSafe(join(cats('run'), 'pids.json'))) as {
        processes: { pid: number; catId: string }[];
      };
      return record.processes.find((p) => p.catId === catId)?.pid;
    });

    const res = await t.api('POST', `/api/cats/${catId}/retire`, {
      reason: 'Too slow',
      openTask: 'cancel',
    });
    expect(res.body).toEqual({ retired: true });
    const after = await board();
    expect(after.tasks[task.id]?.status).toBe('cancelled');
    expect(after.cats[catId]).toBeUndefined();
    expect(await exists(running.worktreePath!)).toBe(false);
    await vi.waitFor(
      () => {
        expect(isProcessAlive(pid)).toBe(false);
      },
      { timeout: 10_000 },
    );
  });

  it('retires after the current task when asked to', async () => {
    await setup({ timeScale: 0.2 });
    const task = await createTask('quick job');
    const running = await waitFor(statusIs(task.id, 'running'));
    const catId = running.assigneeCatId!;
    const res = await t.api('POST', `/api/cats/${catId}/retire`, {
      reason: 'Done after this',
      openTask: 'after_task',
    });
    expect(res.body).toEqual({ retired: false });
    expect((await board()).cats[catId]).toBeDefined();
    await waitFor(statusIs(task.id, 'review'));
    await waitFor((b) => b.retired[catId]);
  });

  it('lets the lead suggest a retirement, which the user can dismiss', async () => {
    await setup();
    const cat = await seasonedWorker();
    await t.api('POST', '/api/chat', { text: `/retire ${cat.name} Rejected too often` });
    const proposal = await waitFor((b) => b.retireProposals[cat.id]);
    expect(proposal.reason).toBe('Rejected too often');
    expect((await board()).cats[cat.id]).toBeDefined(); // nothing happens on its own
    expect((await t.api('POST', `/api/cats/${cat.id}/retire/dismiss`)).status).toBe(202);
    await waitFor((b) => !b.retireProposals[cat.id]);
  });
});

/** A sample whose check passes when answer.txt says 42; the mock candidates answer 42, 42 verbosely, or 41. */
async function answerSample(): Promise<void> {
  const dir = join(cats('interviews'));
  await mkdir(join(dir, 'answer', 'hidden'), { recursive: true });
  await writeFile(
    join(dir, 'answer.md'),
    '---\ntitle: Answer the question\nrepo: fixture\ncheck: node check.cjs\nlint: node scripts/lint.js\n---\n\nWrite the answer to answer.txt and commit it.\n',
  );
  await writeFile(
    join(dir, 'answer', 'hidden', 'check.cjs'),
    "const fs = require('node:fs');\nprocess.exit(fs.readFileSync('answer.txt', 'utf8').trim() === '42' ? 0 : 1);\n",
  );
}

/** Candidates play these in hiring order. */
function scripted(...scenarios: string[]) {
  let next = 0;
  return { scenarioFor: () => scenarios[next++] };
}

async function propose(body: Record<string, unknown>) {
  return t.api('POST', '/api/interviews', {
    role: {
      description: 'Writes small, careful changes',
      tier: 'balanced',
      learnings: ['Keep diffs small'],
    },
    sampleId: 'answer',
    ...body,
  });
}

describe('interviews', () => {
  it('scores three candidates, keeps the failing one from winning, and hires the pick', async () => {
    await setup(scripted('interview-verbose', 'interview-pass', 'interview-fail'));
    await answerSample();
    const samples = (await t.api('GET', '/api/interviews/samples')).body as {
      samples: { id: string }[];
    };
    expect(samples.samples.map((s) => s.id)).toEqual(
      expect.arrayContaining(['add-function', 'fix-failing-test', 'refactor', 'answer']),
    );

    const proposed = await propose({ candidates: 3 });
    expect(proposed.status).toBe(201);
    const interview = (proposed.body as { interview: Interview }).interview;
    expect(interview).toMatchObject({ status: 'proposed', estimateUsd: 0.75, candidates: [] });
    expect(Object.values((await board()).cats).some((c) => c.role === 'candidate')).toBe(false);

    await t.api('POST', `/api/interviews/${interview.id}/start`);
    const decided = await waitFor(
      (b) => b.interviews[interview.id]?.status === 'deciding' && b.interviews[interview.id],
    );
    const [verbose, pass, fail] = decided.candidates;
    expect(pass?.result).toMatchObject({ passed: true, lintClean: true });
    expect(verbose?.result).toMatchObject({ passed: true });
    expect(fail?.result).toMatchObject({ passed: false });
    expect(fail?.result?.failure).toContain('The check failed');
    expect(pass?.score?.total).toBeGreaterThan(verbose?.score?.total ?? 100);
    expect(fail?.score?.total).toBeNull();

    const refused = await t.api('POST', `/api/interviews/${interview.id}/pick`, {
      catId: fail!.catId,
    });
    expect(refused.status).toBe(409);

    const picked = await t.api('POST', `/api/interviews/${interview.id}/pick`, {
      catId: pass!.catId,
    });
    expect(picked.status).toBe(200);
    const after = await board();
    expect(after.interviews[interview.id]).toMatchObject({
      status: 'completed',
      winnerCatId: pass!.catId,
    });
    expect(
      Object.values(after.cats)
        .filter((c) => c.role !== 'orchestrator')
        .map((c) => [c.id, c.role]),
    ).toEqual([[pass!.catId, 'worker']]);
    const winner = after.cats[pass!.catId]!;
    expect(winner.learnings.map((l) => l.text)).toEqual(['Keep diffs small']);
    expect(await readFile(join(cats('cats'), winner.name, 'profile.md'), 'utf8')).toContain(
      'Writes small, careful changes',
    );
    expect(await exists(join(t.worktreesDir, 'interviews', interview.id))).toBe(false);

    // The hire works like any worker.
    const task = await t.api('POST', '/api/tasks', { title: 'Real work', catId: winner.id });
    await waitFor(statusIs((task.body as { task: Task }).task.id, 'review'));
  });

  it('refuses an interview over its budget, and one for a full team', async () => {
    await setup({}, { interviews: { budgetUsd: 0.1 }, workers: { max: 1 } });
    await answerSample();
    const over = await propose({});
    expect(over.status).toBe(409);
    expect(JSON.stringify(over.body)).toContain('interview budget');

    await t.api('POST', '/api/tasks', { title: 'fill the team' });
    await waitFor((b) => Object.values(b.cats).some((c) => c.role === 'worker'));
    const full = await propose({});
    expect(full.status).toBe(409);
    expect(JSON.stringify(full.body)).toMatch(/team is full|interview budget/);
  });

  it('cancels a running interview and leaves no candidate, repo or process behind', async () => {
    await setup({ ...scripted('hang', 'hang'), spawnProcess: true });
    await answerSample();
    const interview = ((await propose({})).body as { interview: Interview }).interview;
    await t.api('POST', `/api/interviews/${interview.id}/start`);
    await waitFor((b) =>
      b.interviews[interview.id]?.candidates.every((c) => b.cats[c.catId]?.status === 'working'),
    );
    const pids = (
      JSON.parse(readFileSyncSafe(join(cats('run'), 'pids.json'))) as {
        processes: { pid: number }[];
      }
    ).processes.map((p) => p.pid);
    expect(pids.length).toBeGreaterThanOrEqual(2);

    const res = await t.api('POST', `/api/interviews/${interview.id}/cancel`);
    expect(res.status).toBe(200);
    const after = await board();
    expect(after.interviews[interview.id]?.status).toBe('cancelled');
    expect(Object.values(after.cats).some((c) => c.role === 'candidate')).toBe(false);
    expect(await exists(join(t.worktreesDir, 'interviews', interview.id))).toBe(false);
    await vi.waitFor(
      () => {
        for (const pid of pids) expect(isProcessAlive(pid)).toBe(false);
      },
      { timeout: 10_000 },
    );
  });

  it('lets the lead propose an interview, which waits for the user', async () => {
    await setup();
    await t.api('POST', '/api/chat', { text: '/hire A careful test writer' });
    const proposed = await waitFor((b) => Object.values(b.interviews)[0]);
    expect(proposed).toMatchObject({
      status: 'proposed',
      proposedBy: 'orchestrator',
      role: { description: 'A careful test writer', tier: 'balanced' },
    });
  });
});

function readFileSyncSafe(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '{"processes":[]}';
  }
}
