import { homedir } from 'node:os';
import { rm } from 'node:fs/promises';

import { createMockAdapter } from '@agentcats/adapter-mock';
import { AgentcatsConfig, SessionEventsResponse, SessionsResponse } from '@agentcats/protocol';
import { describe, expect, it } from 'vitest';

import { startDaemon } from '../src/index.js';
import { tempDir, tempProject } from './harness.js';

describe('sessions', () => {
  it('lists one session per run and serves each one’s events', async () => {
    const projectPath = await tempProject();
    const worktreesDir = await tempDir('agentcats-wt-');
    const start = () =>
      startDaemon({
        projectPath,
        adapter: createMockAdapter({ timeScale: 0 }),
        config: AgentcatsConfig.parse({ adapter: 'mock', worktreesDir }),
        version: '9.9.9',
      });
    const get = async (daemon: Awaited<ReturnType<typeof start>>, path: string) => {
      const res = await fetch(`${daemon.url}${path}`, {
        headers: { Authorization: `Bearer ${daemon.token}` },
      });
      return { status: res.status, body: await res.json() };
    };

    const first = await start();
    await first.close();
    const second = await start();
    try {
      const { sessions } = SessionsResponse.parse((await get(second, '/api/sessions')).body);
      expect(sessions.map((s) => [s.index, s.version])).toEqual([
        [0, '9.9.9'],
        [1, '9.9.9'],
      ]);
      const res = SessionEventsResponse.parse((await get(second, '/api/sessions/1/events')).body);
      expect(res.events[0]?.type).toBe('daemon.started');
      expect(res.events.every((e) => e.seq >= sessions[1]!.firstSeq)).toBe(true);
      expect(res).toMatchObject({ projectPath, homeDir: homedir() });
      expect((await get(second, '/api/sessions/7/events')).status).toBe(404);
    } finally {
      await second.close();
      for (const dir of [projectPath, worktreesDir]) {
        await rm(dir, { recursive: true, force: true, maxRetries: 10 });
      }
    }
  });
});
