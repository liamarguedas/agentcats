import { stat } from 'node:fs/promises';

import { createMockAdapter } from '@agentcats/adapter-mock';
import { loadConfig, startDaemon } from '@agentcats/daemon';
import { Snapshot } from '@agentcats/protocol';
import { describe, expect, it, vi } from 'vitest';

import { createDemoProject, DemoScript } from '../src/demo.js';
import { type CliIo, main, parseCliArgs } from '../src/main.js';

describe('--demo', () => {
  it('plays a split, an accepted result, a network approval and a failure', async () => {
    const project = await createDemoProject();
    const daemon = await startDaemon({
      projectPath: project.projectPath,
      // The demo's own pacing is for people; the same scenarios run fast here.
      adapter: createMockAdapter({
        timeScale: 0,
        realFiles: true,
        scenarioForTurn: (prompt) =>
          /payment API docs/i.test(prompt)
            ? 'network'
            : /migrate the old database/i.test(prompt)
              ? 'crash'
              : undefined,
      }),
      config: await loadConfig(project.projectPath),
    });
    const script = new DemoScript(daemon.url, daemon.token, () => undefined, 0.01);
    try {
      script.start();
      await vi.waitFor(
        async () => {
          const res = await fetch(`${daemon.url}/api/snapshot`, {
            headers: { Authorization: `Bearer ${daemon.token}` },
          });
          const { board } = Snapshot.parse(await res.json());
          const tasks = Object.values(board.tasks);
          expect(tasks.filter((t) => t.status === 'done')).toHaveLength(1);
          expect(tasks.filter((t) => t.status === 'review')).toHaveLength(1);
          expect(tasks.find((t) => t.title === 'Migrate the old database')?.status).toBe('failed');
          expect(Object.values(board.pendingApprovals).map((a) => a.toolName)).toContain(
            'WebFetch',
          );
        },
        { timeout: 30_000, interval: 100 },
      );
    } finally {
      await script.stop();
      await daemon.close();
      await project.remove();
    }
    expect(await stat(project.projectPath).catch(() => null)).toBeNull();
  }, 60_000);

  it('runs from the CLI, needs no agent, and removes its project when stopped', async () => {
    const out: string[] = [];
    const io: CliIo = {
      out: (line) => out.push(line),
      err: () => undefined,
      open: vi.fn(),
      stopSignal: () => new Promise((r) => setTimeout(r, 500)),
    };
    // The demo only ever creates the mock adapter: no agent CLI is looked up.
    expect(await main(['--demo', '--no-open'], io)).toBe(0);
    expect(out.join(' ')).not.toMatch(/Claude Code|Codex/);
    const running = out.find((l) => l.startsWith('agentcats is running for '));
    expect(out.join('\n')).toMatch(/Board: http:\/\/127\.0\.0\.1:\d+\/#token=/);
    const projectPath = running?.replace('agentcats is running for ', '') ?? '';
    expect(await stat(projectPath).catch(() => null)).toBeNull();
  }, 60_000);

  it('rejects --demo with --project or --adapter', () => {
    expect(() => parseCliArgs(['--demo', '--adapter', 'claude'])).toThrow(/drop --project/);
  });
});
