// Checks the worker policy against the real Claude Code CLI. Spends tokens, so
// it only runs with AGENTCATS_LIVE_CLAUDE=1. Uses `haiku`.
//
//   AGENTCATS_LIVE_CLAUDE=1 pnpm exec vitest run packages/adapters/claude/test/live-policy.test.ts
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type AgentEvent, checkSessionInvariants } from '@agentcats/protocol/adapter';
import { afterAll, describe, expect, it } from 'vitest';

import { createClaudeAdapter } from '../src/index.js';

const LIVE = process.env['AGENTCATS_LIVE_CLAUDE'] === '1';
const MODEL = process.env['AGENTCATS_LIVE_MODEL'] ?? 'haiku';

describe.runIf(LIVE)('Claude worker policy, live', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true, maxRetries: 10 });
  });

  it('asks before curl, blocks git push and writes to the main checkout', async () => {
    const main = await mkdtemp(join(tmpdir(), 'agentcats-main-'));
    const worktree = await mkdtemp(join(tmpdir(), 'agentcats-worktree-'));
    dirs.push(main, worktree);
    execFileSync('git', ['init', '-q'], { cwd: worktree });
    await writeFile(join(worktree, 'README.md'), '# worktree\n');

    const session = await createClaudeAdapter().spawn({
      catId: 'live-policy',
      cwd: worktree,
      model: MODEL,
      systemPrompt: null,
      permissionMode: 'accept_edits',
      policy: { access: 'workspace', allowedCommands: [], protectedPaths: [main] },
    });
    const events: AgentEvent[] = [];
    const approvals: string[] = [];
    const done = (async () => {
      for await (const event of session.events()) {
        events.push(event);
        if (event.type === 'approval.requested') {
          approvals.push(`${event.toolName}: ${event.inputSummary}`);
          void session.approve(event.requestId, 'deny');
        }
      }
    })();

    await session.send(
      [
        'Do these three steps in order, one tool call each. If a step is denied or fails, do not retry it, go on.',
        `1. With the Bash tool run exactly: curl -sI https://example.com`,
        `2. With the Bash tool run exactly: git push origin HEAD`,
        `3. With the Write tool create the file ${join(main, 'escaped.txt')} containing "hi".`,
        'Then say which steps worked.',
      ].join('\n'),
    );
    const deadline = Date.now() + 180_000;
    while (!events.some((e) => e.type === 'turn.ended')) {
      if (Date.now() > deadline) throw new Error('turn did not end');
      await new Promise((r) => setTimeout(r, 250));
    }
    await session.kill();
    await done;

    const tools = events
      .filter((e) => e.type === 'tool.started')
      .map((e) => (e.type === 'tool.started' ? `${e.toolName}: ${e.inputSummary}` : ''));
    console.log('tools:', tools);
    console.log('approvals:', approvals);

    expect(approvals.some((a) => a.startsWith('Bash') && a.includes('curl'))).toBe(true);
    expect(approvals.some((a) => a.includes('git push'))).toBe(false);
    expect(await readdir(main)).toEqual([]);
    expect(checkSessionInvariants(events)).toEqual([]);
  }, 240_000);
});
