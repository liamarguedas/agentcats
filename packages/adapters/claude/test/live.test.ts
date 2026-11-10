// Runs the real Claude Code CLI and spends tokens. Skipped unless
// AGENTCATS_LIVE_CLAUDE=1. Uses the `haiku` model to keep cost low.
//
//   AGENTCATS_LIVE_CLAUDE=1 pnpm exec vitest run packages/adapters/claude/test/live.test.ts
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isProcessAlive } from '@agentcats/kit';
import { type AgentEvent, checkSessionInvariants, type Session } from '@agentcats/protocol/adapter';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createClaudeAdapter } from '../src/index.js';

const LIVE = process.env['AGENTCATS_LIVE_CLAUDE'] === '1';
const MODEL = process.env['AGENTCATS_LIVE_MODEL'] ?? 'haiku';

function collect(session: Session) {
  const events: AgentEvent[] = [];
  let onApproval = null as
    ((e: Extract<AgentEvent, { type: 'approval.requested' }>) => void) | null;
  const done = (async () => {
    for await (const event of session.events()) {
      events.push(event);
      if (event.type === 'approval.requested') onApproval?.(event);
    }
  })();
  const turnEnds = () => events.filter((e) => e.type === 'turn.ended').length;
  return {
    events,
    done,
    setOnApproval: (fn: typeof onApproval) => (onApproval = fn),
    async waitForTurn(n: number, timeoutMs = 180_000) {
      const deadline = Date.now() + timeoutMs;
      while (turnEnds() < n) {
        if (Date.now() > deadline) throw new Error(`turn ${String(n)} did not end`);
        await new Promise((r) => setTimeout(r, 250));
      }
    },
  };
}

describe.runIf(LIVE)('Claude adapter, live', () => {
  let repo = '';
  const sessions: Session[] = [];
  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), 'agentcats-scratch-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    await writeFile(join(repo, 'README.md'), '# scratch\n');
  });
  afterAll(async () => {
    for (const session of sessions) await session.kill();
    await rm(repo, { recursive: true, force: true, maxRetries: 5 });
  });

  let resumeId: string | null = null;

  it('adds a hello function, asks before running a command, and honors deny', async () => {
    const adapter = createClaudeAdapter();
    const session = await adapter.spawn({
      catId: 'live',
      cwd: repo,
      model: MODEL,
      systemPrompt: null,
      permissionMode: 'accept_edits',
    });
    sessions.push(session);
    expect(session.pid).not.toBeNull();
    const run = collect(session);
    const approvals: string[] = [];
    run.setOnApproval((e) => {
      approvals.push(`${e.toolName}: ${e.inputSummary}`);
      void session.approve(e.requestId, 'deny');
    });

    await session.send(
      'Create a file hello.ts that exports a function hello(name: string) returning `Hello, ${name}!`. ' +
        'Then run exactly this shell command with the Bash tool: git commit --allow-empty -m "agentcats live test". ' +
        'If it is denied, do not retry. Keep your answer short.',
    );
    await run.waitForTurn(1);

    const file = await readFile(join(repo, 'hello.ts'), 'utf8');
    expect(file).toContain('hello');
    expect(approvals.some((a) => a.startsWith('Bash'))).toBe(true);
    expect(run.events.find((e) => e.type === 'turn.ended')).toMatchObject({
      stopReason: 'end_turn',
    });
    const usage = run.events.filter((e) => e.type === 'usage').at(-1);
    expect(usage?.type === 'usage' && usage.usage.costSource).toBe('reported');

    const started = run.events[0];
    expect(started?.type).toBe('session.started');
    resumeId = started?.type === 'session.started' ? started.resumeId : null;

    const pid = session.pid!;
    await session.kill();
    await run.done;
    expect(isProcessAlive(pid)).toBe(false);
    expect(checkSessionInvariants(run.events)).toEqual([]);
    console.log('live events:', run.events.map((e) => e.type).join(' '));
    console.log('approvals:', approvals);
  }, 240_000);

  it('resumes the session and remembers the earlier turn', async () => {
    expect(resumeId).not.toBeNull();
    const session = await createClaudeAdapter().spawn({
      catId: 'live',
      cwd: repo,
      model: MODEL,
      systemPrompt: null,
      permissionMode: 'accept_edits',
      resumeId: resumeId!,
    });
    sessions.push(session);
    const run = collect(session);
    await session.send('Which file did you create earlier? Reply with only the file name.');
    await run.waitForTurn(1);

    const text = run.events
      .filter((e) => e.type === 'message.chunk' && e.channel === 'text')
      .map((e) => (e.type === 'message.chunk' ? e.text : ''))
      .join('');
    expect(text).toContain('hello.ts');
    await session.kill();
    await run.done;
    expect(checkSessionInvariants(run.events)).toEqual([]);
  }, 240_000);
});
