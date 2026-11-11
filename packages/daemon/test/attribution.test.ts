import { rm } from 'node:fs/promises';

import { createMockAdapter } from '@agentcats/adapter-mock';
import { AgentcatsConfig, type AgentcatsConfigInput } from '@agentcats/protocol';
import type { Adapter, SpawnOptions } from '@agentcats/protocol/adapter';
import { describe, expect, it, vi } from 'vitest';

import { startDaemon } from '../src/index.js';
import { tempDir, tempProject } from './harness.js';

/** A mock adapter that records the options of every session it starts. */
function recordingAdapter(): { adapter: Adapter; spawns: SpawnOptions[] } {
  const inner = createMockAdapter({ timeScale: 0, realFiles: true });
  const spawns: SpawnOptions[] = [];
  return {
    spawns,
    adapter: {
      ...inner,
      spawn: (options) => {
        spawns.push(options);
        return inner.spawn(options);
      },
    },
  };
}

async function runOnce(config: AgentcatsConfigInput): Promise<SpawnOptions[]> {
  const projectPath = await tempProject();
  const worktreesDir = await tempDir('agentcats-wt-');
  const { adapter, spawns } = recordingAdapter();
  const daemon = await startDaemon({
    projectPath,
    adapter,
    config: AgentcatsConfig.parse({ adapter: 'mock', worktreesDir, ...config }),
  });
  const res = await fetch(`${daemon.url}/api/chat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${daemon.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Add a login endpoint\n/single' }),
  });
  expect(res.status).toBe(202);
  await vi.waitFor(
    () => {
      expect(spawns.length).toBe(2); // the lead, then one worker (after its worktree)
    },
    { timeout: 15_000 },
  );
  await daemon.close();
  await rm(projectPath, { recursive: true, force: true, maxRetries: 5 });
  await rm(worktreesDir, { recursive: true, force: true, maxRetries: 5 });
  return spawns;
}

describe('commit attribution', () => {
  it('asks every cat to leave out its own attribution by default', async () => {
    const spawns = await runOnce({});
    expect(spawns.map((s) => s.attribution)).toEqual([false, false]);
    expect(spawns.map((s) => s.policy?.access)).toEqual(['read_only', 'workspace']);
  });

  it('lets agents add attribution when the config says so', async () => {
    const spawns = await runOnce({ attribution: true });
    expect(spawns.map((s) => s.attribution)).toEqual([true, true]);
  });
});
