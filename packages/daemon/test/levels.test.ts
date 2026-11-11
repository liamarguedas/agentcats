import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { type BoardState, Snapshot, type Task, type TaskStatus } from '@agentcats/protocol';
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

async function board(): Promise<BoardState> {
  return Snapshot.parse((await t.api('GET', '/api/snapshot')).body).board;
}

async function waitForStatus(taskId: string, status: TaskStatus): Promise<Task> {
  await vi.waitFor(
    async () => {
      expect((await board()).tasks[taskId]?.status).toBe(status);
    },
    { timeout: 15_000, interval: 25 },
  );
  return (await board()).tasks[taskId]!;
}

/**
 * A pnpm project with test and lint scripts. Allows every approval as it
 * comes and remembers what asked, per task.
 */
async function setup(xpPerAcceptedTask: number) {
  t = await startTestDaemon({}, { xp: { accepted: xpPerAcceptedTask, testsFirstTry: 0 } });
  await writeFile(
    join(t.projectPath, 'package.json'),
    JSON.stringify({ name: 'sample', scripts: { test: 'vitest run', lint: 'eslint .' } }),
  );
  await writeFile(join(t.projectPath, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
  git(t.projectPath, 'add', '.');
  git(t.projectPath, 'commit', '-q', '-m', 'add package.json');
  stream = await connectEvents(t.daemon);
  stream.socket.on('message', (data: Buffer) => {
    const event = JSON.parse(data.toString('utf8')) as {
      type: string;
      payload: { approvalId?: string };
    };
    if (event.type === 'approval.requested' && event.payload.approvalId) {
      void t.api('POST', `/api/approvals/${event.payload.approvalId}`, { decision: 'allow' });
    }
  });
}

const askedFor = (taskId: string) =>
  stream.events.flatMap((e) =>
    e.type === 'approval.requested' && e.taskId === taskId ? [e.payload.inputSummary] : [],
  );

/** Level a fresh worker up with one accepted task, then give it the routine task. */
async function routineAtLevel(level: number): Promise<string[]> {
  const first = (await t.api('POST', '/api/tasks', { title: 'Warm up' })).body as { task: Task };
  const warm = await waitForStatus(first.task.id, 'review');
  await t.api('POST', `/api/tasks/${warm.id}/review`, { decision: 'accept' });
  const catId = warm.assigneeCatId!;
  await vi.waitFor(async () => {
    expect((await board()).cats[catId]?.level).toBe(level);
  });
  const res = await t.api('POST', '/api/tasks', {
    title: 'Routine change',
    description: '/routine',
    catId,
  });
  const task = (res.body as { task: Task }).task;
  await waitForStatus(task.id, 'review');
  return askedFor(task.id);
}

describe('levels gate approvals', () => {
  it('a level 1 cat asks for every script, tool and outside read', async () => {
    await setup(0);
    const asked = await routineAtLevel(1);
    expect(asked).toEqual([
      join(t.projectPath, 'package.json'),
      'pnpm test',
      'pnpm lint',
      'pnpm exec tsc --noEmit',
      'vitest run src',
      'curl -sI https://example.com',
      'pnpm add left-pad',
    ]);
  });

  it('a level 3 cat runs the project scripts without asking', async () => {
    await setup(80);
    const asked = await routineAtLevel(3);
    expect(asked).toEqual([
      join(t.projectPath, 'package.json'),
      'pnpm exec tsc --noEmit',
      'vitest run src',
      'curl -sI https://example.com',
      'pnpm add left-pad',
    ]);
  });

  it('a level 4 cat only asks for network and installs', async () => {
    await setup(150);
    const asked = await routineAtLevel(4);
    expect(asked).toEqual(['curl -sI https://example.com', 'pnpm add left-pad']);
    await stream.waitFor(isType('cat.level_changed', (e) => e.payload.to === 4));
  });
});
