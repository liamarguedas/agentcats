import {
  type AgentcatsEvent,
  applyEvent,
  emptyBoard,
  type EventOfType,
  Snapshot,
} from '@agentcats/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import {
  connectEvents,
  type EventStream,
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

const catStatuses = (events: AgentcatsEvent[]) =>
  events.filter((e) => e.type === 'cat.status_changed').map((e) => e.payload.status);

const taskDone = (status: string) => isType('task.updated', (e) => e.payload.status === status);

async function createTask(title = 'Add a hello function') {
  const res = await t.api('POST', '/api/tasks', { title });
  expect(res.status).toBe(201);
  return (res.body as { task: { id: string } }).task;
}

describe('task flow with the mock adapter', () => {
  it('runs the happy path: thinking, working, done, with a summary', async () => {
    await setup({ scenario: 'happy-path' });
    const task = await createTask();

    const done = await stream.waitFor<EventOfType<'task.updated'>>(taskDone('done'));
    expect(done.taskId).toBe(task.id);
    expect(done.payload.summary).toContain('hello(name)');
    await stream.waitFor(isType('cat.status_changed', (e) => e.payload.status === 'done'));

    expect(catStatuses(stream.events)).toEqual([
      'thinking',
      'working',
      'thinking',
      'working',
      'thinking',
      'done',
    ]);
    const tools = stream.events.filter((e) => e.type === 'tool.called');
    expect(tools.map((e) => `${e.payload.toolName}:${e.payload.status}`)).toEqual([
      'Read:running',
      'Read:success',
      'Write:running',
      'Write:success',
    ]);
    const usage = stream.events.filter((e) => e.type === 'usage.updated').at(-1);
    expect(usage?.payload.costSource).toBe('estimated');
  });

  it('numbers events without gaps and the snapshot matches a replay', async () => {
    await setup();
    await createTask();
    await stream.waitFor(taskDone('done'));

    const res = await t.api('GET', '/api/snapshot');
    const snapshot = Snapshot.parse(res.body);
    const seqs = snapshot.events.map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    expect(snapshot.events.reduce(applyEvent, emptyBoard())).toEqual(snapshot.board);
  });

  it('accepts a follow-up chat after the task is done', async () => {
    await setup();
    await createTask();
    await stream.waitFor(taskDone('done'));

    const res = await t.api('POST', '/api/chat', { text: 'thanks, now add a test' });
    expect(res).toEqual({ status: 202, body: { accepted: true } });
    const doneEvents = () =>
      stream.events.filter(isType('cat.status_changed', (e) => e.payload.status === 'done'));
    await expect.poll(() => doneEvents().length).toBe(2);
  });

  it('rejects a second task while the cat is busy', async () => {
    await setup({ scenario: 'hang' });
    await createTask();
    const res = await t.api('POST', '/api/tasks', { title: 'another' });
    expect(res.status).toBe(409);
  });
});

describe('approvals', () => {
  it.each(['allow', 'deny'] as const)('shows a bubble and resumes after %s', async (decision) => {
    await setup({ scenario: 'approval' });
    await createTask();

    const requested = await stream.waitFor<EventOfType<'approval.requested'>>(
      isType('approval.requested'),
    );
    expect(requested.payload).toMatchObject({ toolName: 'Bash', inputSummary: 'npm test' });
    await stream.waitFor(
      isType('cat.status_changed', (e) => e.payload.status === 'waiting_approval'),
    );
    const snapshot = Snapshot.parse((await t.api('GET', '/api/snapshot')).body);
    expect(Object.keys(snapshot.board.pendingApprovals)).toEqual([requested.payload.approvalId]);

    const res = await t.api('POST', `/api/approvals/${requested.payload.approvalId}`, { decision });
    expect(res).toEqual({
      status: 200,
      body: { approvalId: requested.payload.approvalId, decision },
    });

    await stream.waitFor(taskDone('done'));
    const resolved = stream.events.find(isType('approval.resolved'));
    expect(resolved?.type === 'approval.resolved' && resolved.payload).toMatchObject({
      decision,
      resolvedBy: 'user',
    });
    const ranTests = stream.events.some(
      isType('tool.called', (e) => e.payload.toolName === 'Bash'),
    );
    expect(ranTests).toBe(decision === 'allow');
  });

  it('auto-denies after the configured timeout', async () => {
    await setup({ scenario: 'approval' }, { approvalTimeoutMs: 50 });
    await createTask();

    const resolved = await stream.waitFor<EventOfType<'approval.resolved'>>(
      isType('approval.resolved'),
    );
    expect(resolved.payload).toMatchObject({ decision: 'deny', resolvedBy: 'timeout' });
    await stream.waitFor(taskDone('done'));
  });

  it('returns 404 for an unknown approval', async () => {
    await setup();
    const res = await t.api('POST', '/api/approvals/nope', { decision: 'allow' });
    expect(res.status).toBe(404);
  });
});

describe('failures and kill', () => {
  it('renders an error turn as a failed task and an error cat', async () => {
    await setup({ scenario: 'error' });
    await createTask();

    await stream.waitFor(taskDone('failed'));
    const status = await stream.waitFor<EventOfType<'cat.status_changed'>>(
      isType('cat.status_changed', (e) => e.payload.status === 'error'),
    );
    expect(status.payload.reason).toBe('Build failed: cannot find module "./hello"');
    expect(
      stream.events.some(isType('daemon.error', (e) => e.payload.code === 'agent_error')),
    ).toBe(true);
  });

  it('marks the cat as crashed when the agent dies', async () => {
    await setup({ scenario: 'crash' });
    await createTask();

    await stream.waitFor(taskDone('failed'));
    await stream.waitFor(
      isType('cat.status_changed', (e) => e.payload.reason?.startsWith('Agent crashed') ?? false),
    );
  });

  it('kills a busy cat, cancels its task, and can start a new one', async () => {
    await setup({ scenario: 'hang' });
    const [catId] = Object.keys(
      Snapshot.parse((await t.api('GET', '/api/snapshot')).body).board.cats,
    );
    await createTask();
    await stream.waitFor(isType('tool.called'));

    const res = await t.api('POST', `/api/cats/${catId!}/kill`);
    expect(res).toEqual({ status: 202, body: { accepted: true } });
    await stream.waitFor(taskDone('cancelled'));
    await stream.waitFor(
      isType(
        'cat.status_changed',
        (e) => e.payload.status === 'idle' && e.payload.reason === 'killed',
      ),
    );

    await createTask('try again');
    await expect.poll(() => stream.events.filter(isType('task.created')).length).toBe(2);
  });
});

describe('request validation', () => {
  it.each([
    ['a task without a title', 'POST', '/api/tasks', {}, 400],
    ['an unknown cat', 'POST', '/api/tasks', { title: 'x', catId: 'nope' }, 404],
    ['kill for an unknown cat', 'POST', '/api/cats/nope/kill', undefined, 404],
    ['the wrong method', 'GET', '/api/tasks', undefined, 405],
    ['an unknown route', 'GET', '/api/nope', undefined, 404],
  ])('rejects %s', async (_label, method, path, body, status) => {
    await setup();
    expect((await t.api(method, path, body)).status).toBe(status);
  });

  it('rejects a body that is not JSON', async () => {
    await setup();
    const res = await fetch(`${t.daemon.url}/api/tasks`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${t.daemon.token}`, 'Content-Type': 'text/plain' },
      body: 'title=x',
    });
    expect(res.status).toBe(400);
  });
});
