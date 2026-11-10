import { isProcessAlive, killProcessTree } from '@agentcats/kit';
import {
  AgentEvent,
  checkSessionInvariants,
  type Session,
  type SpawnOptions,
} from '@agentcats/protocol/adapter';
import { describe, expect, it } from 'vitest';

import { createMockAdapter, type MockAdapterOptions } from './mock-adapter.js';

const spawnOptions: SpawnOptions = {
  catId: 'cat-1',
  cwd: process.cwd(),
  model: null,
  systemPrompt: null,
  permissionMode: 'accept_edits',
};

/** Spawn a fast mock session and collect its events in the background. */
async function start(options: MockAdapterOptions) {
  const session = await createMockAdapter({ timeScale: 0, ...options }).spawn(spawnOptions);
  const events: AgentEvent[] = [];
  const waiters: { match: (e: AgentEvent) => boolean; resolve: (e: AgentEvent) => void }[] = [];
  const done = (async () => {
    for await (const event of session.events()) {
      events.push(event);
      for (const w of waiters.filter((w) => w.match(event))) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(event);
      }
    }
  })();
  const next = <T extends AgentEvent['type']>(type: T) => {
    const seen = events.find((e) => e.type === type);
    if (seen) return Promise.resolve(seen as Extract<AgentEvent, { type: T }>);
    return new Promise<Extract<AgentEvent, { type: T }>>((resolve) =>
      waiters.push({ match: (e) => e.type === type, resolve: resolve as (e: AgentEvent) => void }),
    );
  };
  return { session, events, done, next };
}

function expectValidStream(events: AgentEvent[]) {
  for (const event of events) expect(AgentEvent.parse(event)).toEqual(event);
  expect(checkSessionInvariants(events)).toEqual([]);
}

const types = (events: AgentEvent[]) => events.map((e) => e.type);

describe('mock adapter', () => {
  it('plays the happy path as a valid stream', async () => {
    const { session, events, done, next } = await start({ scenario: 'happy-path' });
    await session.send('add a hello function');
    expect(await next('turn.ended')).toEqual({ type: 'turn.ended', stopReason: 'end_turn' });
    await session.kill();
    await done;

    expectValidStream(events);
    expect(events.filter((e) => e.type === 'tool.started').map((e) => e.kind)).toEqual([
      'read',
      'edit',
    ]);
    expect(events.at(-1)).toEqual({ type: 'session.ended', reason: 'killed', exitCode: null });
  });

  it.each(['allow', 'deny'] as const)('waits for an approval and honors %s', async (decision) => {
    const { session, events, done, next } = await start({ scenario: 'approval' });
    await session.send('go');
    const request = await next('approval.requested');
    expect(request).toMatchObject({ toolName: 'Bash', kind: 'execute', inputSummary: 'npm test' });

    await session.approve(request.requestId, decision);
    await next('turn.ended');
    await session.kill();
    await done;

    expectValidStream(events);
    const ranTests = events.some((e) => e.type === 'tool.started' && e.toolName === 'Bash');
    expect(ranTests).toBe(decision === 'allow');
  });

  it('rejects an unknown approval id', async () => {
    const { session } = await start({});
    await expect(session.approve('nope', 'allow')).rejects.toMatchObject({ code: 'not_found' });
    await session.kill();
  });

  it('ends the turn with an error in the error scenario', async () => {
    const { session, events, done, next } = await start({ scenario: 'error' });
    await session.send('build');
    expect(await next('turn.ended')).toMatchObject({ stopReason: 'error' });
    await session.kill();
    await done;

    expectValidStream(events);
    expect(events).toContainEqual(expect.objectContaining({ type: 'error', fatal: false }));
  });

  it('ends the session as crashed in the crash scenario', async () => {
    const { session, events, done } = await start({ scenario: 'crash' });
    await session.send('go');
    await done;

    expectValidStream(events);
    expect(types(events).slice(-4)).toEqual([
      'error',
      'tool.finished',
      'turn.ended',
      'session.ended',
    ]);
    expect(events.at(-1)).toMatchObject({ reason: 'crashed' });
    await expect(session.send('again')).rejects.toMatchObject({ code: 'closed' });
  });

  it('rejects send while a turn is running', async () => {
    const { session, next } = await start({ scenario: 'hang' });
    await session.send('go');
    await next('tool.started');
    await expect(session.send('more')).rejects.toMatchObject({ code: 'busy' });
    await session.kill();
  });

  it('interrupts a hanging turn and stays usable', async () => {
    const { session, events, next } = await start({ scenario: 'hang' });
    await session.send('go');
    await next('tool.started');
    await session.interrupt();

    expect(types(events).slice(-2)).toEqual(['tool.finished', 'turn.ended']);
    expect(events.at(-1)).toEqual({ type: 'turn.ended', stopReason: 'cancelled' });
    await expect(session.send('again')).resolves.toBeUndefined();
    await session.kill();
  });

  it('kills mid-turn with a cancelled turn before session.ended', async () => {
    const { session, events, done, next } = await start({ scenario: 'hang' });
    await session.send('go');
    await next('tool.started');
    await session.kill();
    await session.kill(); // idempotent
    await done;

    expectValidStream(events);
    expect(types(events).slice(-2)).toEqual(['turn.ended', 'session.ended']);
  });

  it('plays the scenario a /<name> prompt asks for, then falls back to the default', async () => {
    const { session, events, next } = await start({ scenario: 'happy-path' });
    await session.send('/error please');
    await next('turn.ended');
    expect(events.find((e) => e.type === 'turn.ended')).toMatchObject({ stopReason: 'error' });

    await session.send('/no-such-scenario');
    await expect.poll(() => events.filter((e) => e.type === 'turn.ended').length).toBe(2);
    expect(events.filter((e) => e.type === 'turn.ended').at(-1)).toMatchObject({
      stopReason: 'end_turn',
    });
    await session.kill();
  });

  it('allows events() only once', async () => {
    const { session } = await start({});
    expect(() => session.events()).toThrow(/once/);
    await session.kill();
  });

  it('fails to spawn an unknown scenario', async () => {
    await expect(createMockAdapter({ scenario: 'nope' }).spawn(spawnOptions)).rejects.toMatchObject(
      { code: 'spawn_failed' },
    );
  });

  describe('with a stand-in process', () => {
    it('exposes the pid and kills the process tree on kill', async () => {
      const { session, done } = await start({ spawnProcess: true });
      const pid = session.pid;
      expect(pid).not.toBeNull();
      expect(isProcessAlive(pid!)).toBe(true);

      await session.kill();
      await done;
      expect(isProcessAlive(pid!)).toBe(false);
    });

    it('reports a crash when the process dies on its own', async () => {
      const {
        session,
        events,
        done,
      }: { session: Session; events: AgentEvent[]; done: Promise<void> } = await start({
        spawnProcess: true,
        scenario: 'hang',
      });
      await session.send('go');
      await killProcessTree(session.pid!);
      await done;

      expectValidStream(events);
      expect(events.at(-1)).toMatchObject({ type: 'session.ended', reason: 'crashed' });
    });
  });
});
