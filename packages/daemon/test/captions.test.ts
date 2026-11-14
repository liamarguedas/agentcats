import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { type EventOfType, Snapshot, type Task } from '@agentcats/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CAPTIONS } from '../src/captions.js';
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

async function failTask(): Promise<Task> {
  const res = await t.api('POST', '/api/tasks', { title: 'build it', description: '/crash' });
  const task = (res.body as { task: Task }).task;
  await vi.waitFor(
    async () => {
      const board = Snapshot.parse((await t.api('GET', '/api/snapshot')).body).board;
      expect(board.tasks[task.id]?.status).toBe('failed');
    },
    { timeout: 15_000, interval: 25 },
  );
  return task;
}

const writeCaptions = (content: string) => async (projectPath: string) => {
  await mkdir(join(projectPath, '.agentcats'), { recursive: true });
  await writeFile(join(projectPath, '.agentcats', 'captions.json'), content);
};

describe('captions', () => {
  it('captions a failed task from the template file, and writes the defaults there first', async () => {
    t = await startTestDaemon();
    stream = await connectEvents(t.daemon);
    const task = await failTask();
    const caption = await stream.waitFor<EventOfType<'caption'>>(isType('caption'));
    expect(caption).toMatchObject({ taskId: task.id, payload: { kind: 'task_failed' } });
    expect(caption.payload.text).not.toMatch(/\{(cat|task)\}/);
    expect(DEFAULT_CAPTIONS.task_failed?.length).toBeGreaterThan(1);
    const onDisk = JSON.parse(
      await readFile(join(t.projectPath, '.agentcats', 'captions.json'), 'utf8'),
    ) as unknown;
    expect(onDisk).toEqual(DEFAULT_CAPTIONS);
  });

  it('uses the user’s own lines', async () => {
    t = await startTestDaemon(
      {},
      {},
      null,
      undefined,
      writeCaptions(JSON.stringify({ task_failed: ['{cat} dropped "{task}".'] })),
    );
    stream = await connectEvents(t.daemon);
    await failTask();
    const caption = await stream.waitFor<EventOfType<'caption'>>(isType('caption'));
    expect(caption.payload.text).toMatch(/^\w+ dropped "build it"\.$/);
  });

  it('falls back to the defaults, with a warning, when the file is broken', async () => {
    t = await startTestDaemon({}, {}, null, undefined, writeCaptions('{"task_failed": []'));
    stream = await connectEvents(t.daemon);
    const snapshot = Snapshot.parse((await t.api('GET', '/api/snapshot')).body);
    const notice = snapshot.events.find(
      (e) => e.type === 'notice' && e.payload.code === 'captions_invalid',
    );
    expect(notice?.type === 'notice' && notice.payload.message).toMatch(/not valid JSON/);
    await failTask();
    const caption = await stream.waitFor<EventOfType<'caption'>>(isType('caption'));
    // One of the default lines, filled in: its fixed words match around the placeholders.
    const matchesDefault = (DEFAULT_CAPTIONS.task_failed ?? []).some((line) =>
      new RegExp(
        `^${line.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{(cat|task)\}/g, '.+')}$`,
      ).test(caption.payload.text),
    );
    expect(matchesDefault).toBe(true);
  });

  it('stays quiet in serious mode', async () => {
    t = await startTestDaemon({}, { captions: { enabled: false } });
    stream = await connectEvents(t.daemon);
    await failTask();
    await new Promise((r) => setTimeout(r, 200));
    expect(stream.events.some(isType('caption'))).toBe(false);
  });
});
