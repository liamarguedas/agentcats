import { stat } from 'node:fs/promises';

import {
  type BoardState,
  type EventOfType,
  Snapshot,
  type Task,
  type TaskStatus,
} from '@agentcats/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  connectEvents,
  type EventStream,
  git,
  isType,
  startTestDaemon,
  type TestDaemon,
} from './harness.js';

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

async function createTask(title: string, description = ''): Promise<Task> {
  const res = await t.api('POST', '/api/tasks', { title, description });
  expect(res.status).toBe(201);
  return (res.body as { task: Task }).task;
}

async function waitForStatus(taskId: string, status: TaskStatus, timeout = 10_000): Promise<Task> {
  await vi.waitFor(
    async () => {
      expect((await board()).tasks[taskId]?.status).toBe(status);
    },
    { timeout, interval: 25 },
  );
  return (await board()).tasks[taskId]!;
}

const statusHistory = (taskId: string) =>
  stream.events
    .filter(
      (e) => e.type === 'task.updated' && e.taskId === taskId && e.payload.status !== undefined,
    )
    .map((e) => (e.type === 'task.updated' ? e.payload.status : null));

const workerOf = async (taskId: string) => (await board()).tasks[taskId]!.assigneeCatId!;

describe('orchestration', () => {
  it('splits a request into two workers in parallel worktrees, each with a reviewable branch', async () => {
    await setup();
    const orchestrator = Object.values((await board()).cats)[0]!;
    expect(orchestrator).toMatchObject({ role: 'orchestrator', name: 'Tux' });

    const res = await t.api('POST', '/api/chat', {
      text: 'Add a login endpoint and write tests for it',
    });
    expect(res.status).toBe(202);

    await vi.waitFor(
      async () => {
        const tasks = Object.values((await board()).tasks);
        expect(tasks).toHaveLength(2);
        for (const task of tasks) expect(task.status).toBe('review');
      },
      { timeout: 15_000, interval: 25 },
    );

    const state = await board();
    const tasks = Object.values(state.tasks);
    const workers = new Set(tasks.map((task) => task.assigneeCatId));
    expect(workers.size).toBe(2);
    expect(new Set(tasks.map((task) => task.worktreePath)).size).toBe(2);
    for (const task of tasks) {
      expect(task.result).toMatchObject({
        branch: task.branch,
        tests: 'passed',
        diffStat: { files: 1, deletions: 0 },
      });
      expect(task.branch).toMatch(/^agentcats\/[a-z]+\/[0-9a-f]{8}$/);
      expect(task.worktreePath!.startsWith(t.worktreesDir)).toBe(true);
      // The branch is in the user's repo, with the worker's commit on it.
      expect(Number(git(t.projectPath, 'rev-list', '--count', `main..${task.branch!}`))).toBe(1);
    }
    // The main checkout is untouched.
    expect(git(t.projectPath, 'status', '--porcelain')).toBe('');
    expect(git(t.projectPath, 'branch', '--show-current')).toBe('main');

    // Both workers were running at the same time.
    let running = 0;
    let peak = 0;
    for (const event of stream.events) {
      if (event.type !== 'task.updated' || event.payload.status === undefined) continue;
      if (event.payload.status === 'running') running += 1;
      if (event.payload.status === 'review') running -= 1;
      peak = Math.max(peak, running);
    }
    expect(peak).toBe(2);

    // The orchestrator was told and reported back.
    await vi.waitFor(
      () => {
        const text = stream.events
          .filter((e) => e.type === 'message.agent' && e.catId === orchestrator.id)
          .map((e) => (e.type === 'message.agent' ? e.payload.text : ''))
          .join('');
        expect(text).toContain('ready for review');
      },
      { timeout: 10_000 },
    );
  });

  it('accepts a result: done, worktree removed, branch kept', async () => {
    await setup();
    const task = await createTask('/single add hello');
    const review = await waitForStatus(task.id, 'review');

    const res = await t.api('POST', `/api/tasks/${task.id}/review`, { decision: 'accept' });
    expect(res.status).toBe(200);
    expect((res.body as { task: Task }).task.status).toBe('done');
    await expect(stat(review.worktreePath!)).rejects.toThrow();
    expect(git(t.projectPath, 'branch', '--list', review.branch!)).toContain(review.branch!);
  });

  it('rejects a result', async () => {
    await setup();
    const task = await createTask('add hello');
    await waitForStatus(task.id, 'review');
    const res = await t.api('POST', `/api/tasks/${task.id}/review`, { decision: 'reject' });
    expect((res.body as { task: Task }).task.status).toBe('rejected');
  });

  it('runs at most workers.max tasks at once and queues the rest', async () => {
    await setup({}, { workers: { max: 2 } });
    const tasks = [
      await createTask('/hang a'),
      await createTask('/hang b'),
      await createTask('/hang c'),
    ];
    await waitForStatus(tasks[0]!.id, 'running');
    await waitForStatus(tasks[1]!.id, 'running');
    expect((await board()).tasks[tasks[2]!.id]?.status).toBe('queued');
    expect(Object.values((await board()).cats).filter((c) => c.role === 'worker')).toHaveLength(2);

    await t.api('POST', `/api/tasks/${tasks[0]!.id}/cancel`);
    await waitForStatus(tasks[2]!.id, 'running');
  });
});

describe('failures', () => {
  it('retries a crashed worker once, then shows failed', async () => {
    await setup();
    const task = await createTask('build it', '/crash');
    const failed = await waitForStatus(task.id, 'failed');

    expect(failed).toMatchObject({ attempt: 2, reasonCode: 'crashed' });
    expect(statusHistory(task.id)).toEqual(['running', 'queued', 'running', 'failed']);
    const cat = (await board()).cats[failed.assigneeCatId!];
    expect(cat?.status).toBe('error');
  });

  it('recovers when the automatic retry succeeds', async () => {
    await setup();
    const task = await createTask('build it', '/flaky');
    const review = await waitForStatus(task.id, 'review');
    expect(review.attempt).toBe(2);
    expect(statusHistory(task.id)).toEqual(['running', 'queued', 'running', 'review']);
  });

  it('flags a stuck worker after the timeout, and a nudge gets it going', async () => {
    await setup({}, { stuckTimeoutMs: 150 });
    const task = await createTask('long job', '/hang');
    const blocked = await waitForStatus(task.id, 'blocked');
    expect(blocked.reasonCode).toBe('stuck');
    await stream.waitFor(isType('notice', (e) => e.payload.code === 'stuck'));
    const catId = await workerOf(task.id);
    expect((await board()).cats[catId]?.status).toBe('blocked');

    const res = await t.api('POST', `/api/cats/${catId}/nudge`, {});
    expect(res.status).toBe(202);
    await waitForStatus(task.id, 'running');
  });

  it('kills a worker: the task fails and can be re-run', async () => {
    await setup();
    const task = await createTask('long job', '/hang');
    await waitForStatus(task.id, 'running');
    const catId = await workerOf(task.id);

    expect((await t.api('POST', `/api/cats/${catId}/kill`)).status).toBe(202);
    const failed = await waitForStatus(task.id, 'failed');
    expect(failed.reasonCode).toBe('killed');

    const rerun = await t.api('POST', `/api/tasks/${task.id}/rerun`);
    expect((rerun.body as { task: Task }).task).toMatchObject({ status: 'queued', attempt: 2 });
    await waitForStatus(task.id, 'running');
  });

  it('cancels a task and removes its clean worktree', async () => {
    await setup();
    const task = await createTask('long job', '/hang');
    const running = await waitForStatus(task.id, 'running');
    const res = await t.api('POST', `/api/tasks/${task.id}/cancel`);
    expect((res.body as { task: Task }).task.status).toBe('cancelled');
    await expect(stat(running.worktreePath!)).rejects.toThrow();
  });
});

describe('usage limits', () => {
  it('does not retry into a plan or rate limit', async () => {
    await setup();
    const task = await createTask('limited', '/limit');
    const failed = await waitForStatus(task.id, 'failed');
    expect(failed).toMatchObject({ attempt: 1, reasonCode: 'agent_error' });
    expect(failed.statusReason).toContain('session limit');
  });
});

describe('budgets and pause', () => {
  it('pauses a metered cat at its budget and resumes only after the user raises it', async () => {
    // Each step of /expensive costs about $0.09: a warning at 80%, then a pause.
    await setup({}, { budget: { perCatUsd: 0.5 } });
    const task = await createTask('read everything', '/expensive');
    const blocked = await waitForStatus(task.id, 'blocked');
    expect(blocked.reasonCode).toBe('budget');
    const catId = blocked.assigneeCatId!;
    const cat = (await board()).cats[catId]!;
    expect(cat.pausedReason).toBe('budget');
    expect(stream.events.some(isType('notice', (e) => e.payload.code === 'budget_warning'))).toBe(
      true,
    );

    // Still over budget: resuming is refused.
    expect((await t.api('POST', `/api/cats/${catId}/resume`)).status).toBe(409);
    await new Promise((r) => setTimeout(r, 100));
    expect((await board()).tasks[task.id]?.status).toBe('blocked');

    const patch = await t.api('PATCH', `/api/cats/${catId}`, {
      budget: { maxUsd: 100, maxTokens: null },
    });
    expect(patch.status).toBe(200);
    expect((await t.api('POST', `/api/cats/${catId}/resume`)).status).toBe(202);
    await waitForStatus(task.id, 'review');
  });

  it('shows but does not enforce budgets on a subscription plan', async () => {
    await setup({ billing: 'subscription' }, { budget: { perCatUsd: 0.05 } });
    const task = await createTask('read everything', '/expensive');
    await waitForStatus(task.id, 'review');
    const cat = (await board()).cats[(await board()).tasks[task.id]!.assigneeCatId!]!;
    expect(cat).toMatchObject({ billing: 'subscription', pausedReason: null });
    expect((await board()).usage[cat.id]?.costUsd).toBeGreaterThan(0.05);
  });

  it('pauses and resumes a cat on request, continuing the same task', async () => {
    await setup();
    const task = await createTask('long job', '/hang');
    await waitForStatus(task.id, 'running');
    const catId = await workerOf(task.id);

    expect((await t.api('POST', `/api/cats/${catId}/pause`)).status).toBe(202);
    const blocked = await waitForStatus(task.id, 'blocked');
    expect(blocked.reasonCode).toBe('paused');
    expect((await board()).cats[catId]?.pausedReason).toBe('user');

    expect((await t.api('POST', `/api/cats/${catId}/resume`)).status).toBe(202);
    await waitForStatus(task.id, 'running');
    expect((await board()).cats[catId]?.pausedReason).toBeNull();
  });
});

describe('pause while starting', () => {
  it('holds the task until resume when the cat is paused before its session is up', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    await setup({ scenario: 'hang' }, {}, null, (adapter) => ({
      ...adapter,
      spawn: async (options) => {
        await gate;
        return adapter.spawn(options);
      },
    }));
    const task = await createTask('long job');
    await waitForStatus(task.id, 'running');
    const catId = await workerOf(task.id);

    expect((await t.api('POST', `/api/cats/${catId}/pause`)).status).toBe(202);
    release();
    await new Promise((r) => setTimeout(r, 300));
    expect(stream.events.some((e) => e.type === 'tool.called' && e.catId === catId)).toBe(false);

    expect((await t.api('POST', `/api/cats/${catId}/resume`)).status).toBe(202);
    await stream.waitFor(
      isType('tool.called', (e) => e.catId === catId),
      10_000,
    );
    expect((await board()).tasks[task.id]?.status).toBe('running');
  });

  it('kills a cat before its session is up; the task fails and re-runs', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    await setup({ scenario: 'hang' }, {}, null, (adapter) => ({
      ...adapter,
      spawn: async (options) => {
        await gate;
        return adapter.spawn(options);
      },
    }));
    const task = await createTask('long job');
    await waitForStatus(task.id, 'running');
    const catId = await workerOf(task.id);

    // The kill waits for the session it stops, so let the spawn finish meanwhile.
    const kill = t.api('POST', `/api/cats/${catId}/kill`);
    await new Promise((r) => setTimeout(r, 50));
    release();
    expect((await kill).status).toBe(202);
    const failed = await waitForStatus(task.id, 'failed');
    expect(failed.reasonCode).toBe('killed');
    await t.api('POST', `/api/tasks/${task.id}/rerun`);
    await waitForStatus(task.id, 'running');
    await stream.waitFor(
      isType('tool.called', (e) => e.catId === catId),
      10_000,
    );
  });
});

describe('approvals', () => {
  it('raises a network approval on the board; deny blocks the fetch', async () => {
    await setup();
    const task = await createTask('read the api docs', '/network');
    const requested = await stream.waitFor<EventOfType<'approval.requested'>>(
      isType('approval.requested'),
    );
    expect(requested.payload).toMatchObject({ toolName: 'WebFetch', kind: 'fetch' });
    expect(requested.taskId).toBe(task.id);

    await t.api('POST', `/api/approvals/${requested.payload.approvalId}`, { decision: 'deny' });
    const review = await waitForStatus(task.id, 'review');
    expect(review.result?.summary).toContain('denied');
    const fetched = stream.events.some(
      isType(
        'tool.called',
        (e) => e.payload.toolName === 'WebFetch' && e.payload.status === 'success',
      ),
    );
    expect(fetched).toBe(false);
  });
});

describe('rules', () => {
  it('refuses illegal transitions with 409', async () => {
    await setup();
    const task = await createTask('long job', '/hang');
    await waitForStatus(task.id, 'running');
    expect(
      (await t.api('POST', `/api/tasks/${task.id}/review`, { decision: 'accept' })).status,
    ).toBe(409);
    expect((await t.api('POST', `/api/tasks/${task.id}/rerun`)).status).toBe(409);
  });

  it('returns the full history of one task', async () => {
    await setup();
    const a = await createTask('first');
    await createTask('second');
    await waitForStatus(a.id, 'review');
    const res = await t.api('GET', `/api/tasks/${a.id}/events`);
    const events = (res.body as { events: { taskId?: string }[] }).events;
    expect(events.length).toBeGreaterThan(3);
    expect(events.every((e) => e.taskId === a.id)).toBe(true);
  });

  it('refuses MCP calls without an agent token, and with the UI token', async () => {
    await setup();
    for (const auth of [undefined, `Bearer ${t.daemon.token}`]) {
      const res = await fetch(`${t.daemon.url}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...(auth && { Authorization: auth }),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(res.status).toBe(401);
    }
  });
});
