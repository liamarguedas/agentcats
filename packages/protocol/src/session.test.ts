import { describe, expect, it } from 'vitest';

import type { AgentcatsEvent } from './events.js';
import { emptyBoard } from './projection.js';
import { REDACTED } from './redact.js';
import { EXPORT_LIMITS, prepareExport, SessionExport, splitSessions } from './session.js';

let seq = 0;
const at = (ts: number, event: Record<string, unknown>) =>
  ({ id: `e${String(++seq)}`, seq, ts, ...event }) as AgentcatsEvent;
const started = (ts: number) => at(ts, { type: 'daemon.started', payload: { version: '0.1.0' } });
const notice = (ts: number, message = 'hi') =>
  at(ts, { type: 'notice', payload: { level: 'info', code: 'x', message } });
const agent = (messageId: string, text: string) =>
  at(1, { type: 'message.agent', catId: 'c1', payload: { messageId, channel: 'text', text } });

const OPTIONS = { projectPath: '/home/user/work/app', homeDir: '/home/user', now: 99 };

describe('splitSessions', () => {
  it('starts a session at each daemon.started, with an old log as its own first session', () => {
    seq = 0;
    const log = [notice(1), notice(2), started(10), notice(11), started(20)];
    expect(splitSessions(log)).toEqual([
      { index: 0, firstSeq: 1, lastSeq: 2, startedAt: 1, endedAt: 2, eventCount: 2, version: null },
      {
        index: 1,
        firstSeq: 3,
        lastSeq: 4,
        startedAt: 10,
        endedAt: 11,
        eventCount: 2,
        version: '0.1.0',
      },
      {
        index: 2,
        firstSeq: 5,
        lastSeq: 5,
        startedAt: 20,
        endedAt: 20,
        eventCount: 1,
        version: '0.1.0',
      },
    ]);
    expect(splitSessions([])).toEqual([]);
  });
});

describe('prepareExport', () => {
  it('cuts long agent output across chunks, and drops chunks past the cut', () => {
    seq = 0;
    const long = 'x'.repeat(EXPORT_LIMITS.agentMessage - 10);
    const file = prepareExport(
      emptyBoard(),
      [agent('m1', long), agent('m1', 'y'.repeat(50)), agent('m1', 'z')],
      {
        ...OPTIONS,
        includeContents: false,
      },
    );
    expect(file.events).toHaveLength(2);
    const texts = file.events.map((e) => (e.type === 'message.agent' ? e.payload.text : ''));
    expect(texts[0]).toBe(long);
    expect(texts[1]).toBe(`${'y'.repeat(10)} […]`);
  });

  it('keeps everything with contents, and redacts secrets and paths either way', () => {
    seq = 0;
    const events = [
      at(1, {
        type: 'task.created',
        taskId: 't1',
        payload: {
          title: 'Fix it',
          description: `${'long '.repeat(100)}in /home/user/work/app/src with sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx`,
          status: 'queued',
          assigneeCatId: null,
        },
      }),
      notice(2, 'Kept C:\\Users\\user\\x and /home/user/.agentcats'),
    ];
    for (const includeContents of [true, false]) {
      const file = prepareExport(emptyBoard(), events, {
        ...OPTIONS,
        projectPath: '/home/user/work/app',
        homeDir: '/home/user',
        includeContents,
      });
      const text = JSON.stringify(file);
      expect(text).not.toContain('/home/user');
      expect(text).not.toContain('AbCdEfGh');
      expect(SessionExport.parse(file)).toEqual(file);
      expect(file.includesContents).toBe(includeContents);
      const task = file.events[0];
      const description = task?.type === 'task.created' ? task.payload.description : '';
      if (includeContents) {
        expect(description).toContain(`<project>/src with ${REDACTED}`);
      } else {
        expect(description).toHaveLength(EXPORT_LIMITS.taskDescription + ' […]'.length);
      }
    }
  });
});
