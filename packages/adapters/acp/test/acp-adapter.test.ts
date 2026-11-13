import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AgentEvent, Session, SpawnOptions } from '@agentcats/protocol/adapter';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAcpAdapter } from '../src/index.js';

const FAKE_AGENT = fileURLToPath(new URL('./fake-agent.mjs', import.meta.url));

const adapter = createAcpAdapter({
  id: 'fake',
  displayName: 'Fake ACP agent',
  command: process.execPath,
  args: [FAKE_AGENT],
  capabilities: {
    mcp: true,
    approvals: true,
    resume: true,
    reportsCost: false,
    modelSelection: true,
    interrupt: true,
    permissionModes: ['ask', 'accept_edits', 'auto'],
    policyEnforcement: 'sandbox',
    complete: true,
  },
  modelTiers: { fast: 'fake-fast', balanced: 'fake-balanced', best: 'fake-best' },
  modeFor: (policy) => (policy?.access === 'read_only' ? 'read-only' : 'auto'),
  modelOption: 'model',
});

const dirs: string[] = [];
const sessions: Session[] = [];
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.kill();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true, maxRetries: 5 });
});

async function start(extra: Partial<SpawnOptions> = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'agentcats-acp-'));
  dirs.push(cwd);
  const session = await adapter.spawn({
    catId: 'cat-1',
    cwd,
    model: 'fake-balanced',
    systemPrompt: 'You are Mochi, a worker cat.',
    permissionMode: 'accept_edits',
    policy: { access: 'workspace', allowedCommands: [], protectedPaths: [] },
    ...extra,
  });
  sessions.push(session);
  const events: AgentEvent[] = [];
  void (async () => {
    for await (const e of session.events()) events.push(e);
  })();
  const answer = async (text: string) => {
    const from = events.length;
    await session.send(text);
    await vi.waitFor(
      () => {
        expect(events.slice(from).some((e) => e.type === 'turn.ended')).toBe(true);
      },
      { timeout: 10_000 },
    );
    return events
      .slice(from)
      .flatMap((e) => (e.type === 'message.chunk' && e.channel === 'text' ? [e.text] : []))
      .join('');
  };
  return { session, events, answer };
}

describe('ACP adapter', () => {
  it('sends the system prompt as standing instructions before the first message only', async () => {
    const { answer } = await start();
    const first = await answer('say hello');
    expect(first).toContain('Prompt blocks: 2.');
    expect(first).toContain('First block: <instructions>');
    expect(await answer('say hello again')).toContain('Prompt blocks: 1.');
  });

  it('sets the session mode for the policy and the model', async () => {
    const worker = await start();
    expect(await worker.answer('say hello')).toContain('Mode: auto. Model: fake-balanced.');
    const lead = await start({
      policy: { access: 'read_only', allowedCommands: [], protectedPaths: [] },
    });
    expect(await lead.answer('say hello')).toContain('Mode: read-only.');
  });

  it('passes MCP servers to the agent', async () => {
    const { answer } = await start({
      mcpServers: {
        agentcats: {
          type: 'http',
          url: 'http://127.0.0.1:9/mcp',
          headers: { Authorization: 'Bearer x' },
        },
      },
    });
    expect(await answer('list your mcp servers')).toContain('MCP: agentcats');
  });

  it('resumes a session by id, without sending the instructions again', async () => {
    const { events } = await start();
    const started = events.find((e) => e.type === 'session.started');
    const resumeId = started?.type === 'session.started' ? started.resumeId : null;
    expect(resumeId).toMatch(/^fake-/);
    const resumed = await start({ resumeId: resumeId ?? '' });
    expect(await resumed.answer('say hello')).toContain('Prompt blocks: 1.');
  });

  it('reports no cost unless the agent sends one', async () => {
    const { events, answer } = await start();
    await answer('say hello');
    const usage = events.filter((e) => e.type === 'usage').at(-1);
    expect(usage?.type === 'usage' && usage.usage).toMatchObject({
      costUsd: null,
      costSource: 'unknown',
    });
    await answer('report your cost');
    const reported = events.filter((e) => e.type === 'usage').at(-1);
    expect(reported?.type === 'usage' && reported.usage).toMatchObject({
      costUsd: 0.01,
      costSource: 'reported',
    });
  });

  it('interrupts a turn with session/cancel and keeps the session', async () => {
    const { session, events, answer } = await start();
    await session.send('hang until cancelled');
    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'message.chunk' && e.channel === 'thought')).toBe(true);
    });
    await session.interrupt();
    expect(events.filter((e) => e.type === 'turn.ended').at(-1)).toMatchObject({
      stopReason: 'cancelled',
    });
    expect(await answer('say hello')).toContain('Hello from the fake agent.');
  });

  it('reports a crash mid-turn as a fatal error and a crashed session', async () => {
    const { session, events } = await start();
    await session.send('crash now');
    await vi.waitFor(() => {
      expect(events.at(-1)).toMatchObject({ type: 'session.ended', reason: 'crashed' });
    });
    expect(events.some((e) => e.type === 'error' && e.fatal)).toBe(true);
    expect(events.filter((e) => e.type === 'turn.ended').at(-1)).toMatchObject({
      stopReason: 'error',
    });
  });

  it('answers one-shot prompts through a short read-only session', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'agentcats-acp-'));
    dirs.push(cwd);
    const answer = await adapter.complete({
      cwd,
      model: null,
      systemPrompt: '# Debrief',
      prompt: 'say hello',
    });
    expect(answer.text).toContain('Hello from the fake agent.');
    expect(answer.text).toContain('Mode: read-only.');
    expect(answer.usage.costSource).toBe('unknown');
  });
});
