import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isProcessAlive, killProcessTree } from '@agentcats/kit';
import {
  AgentEvent,
  checkSessionInvariants,
  type Session,
  type SpawnOptions,
} from '@agentcats/protocol/adapter';
import { describe, expect, it, vi } from 'vitest';

import { createMockAdapter, type MockAdapterOptions } from './mock-adapter.js';

// Never the repo itself: a mock with realFiles commits into its cwd.
const spawnOptions: SpawnOptions = {
  catId: 'cat-1',
  cwd: tmpdir(),
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
      'execute',
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

  it('writes and commits in its cwd only with realFiles', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'agentcats-mockrepo-'));
    try {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: repo }).toString().trim();
      git('init', '-q');
      await writeFile(join(repo, 'README.md'), '# repo\n');
      git('add', '.');
      git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');

      for (const realFiles of [false, true]) {
        const session = await createMockAdapter({ timeScale: 0, realFiles }).spawn({
          ...spawnOptions,
          cwd: repo,
        });
        const events: AgentEvent[] = [];
        const done = (async () => {
          for await (const e of session.events()) events.push(e);
        })();
        await session.send(`add a hello function ${String(realFiles)}`);
        await vi.waitFor(() => {
          expect(events.some((e) => e.type === 'turn.ended')).toBe(true);
        });
        await session.kill();
        await done;
      }
      expect(git('rev-list', '--count', 'HEAD')).toBe('2');
      expect(git('log', '-1', '--format=%s')).toBe('mock: add a hello function true');
    } finally {
      await rm(repo, { recursive: true, force: true, maxRetries: 5 });
    }
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

describe('mock policy', () => {
  const main = join(tmpdir(), 'agentcats-main-checkout');

  /** Play the routine scenario under a policy, allowing every approval; return what asked. */
  async function approvalsUnder(allowedCommands: string[], readablePaths: string[]) {
    const session = await createMockAdapter({ timeScale: 0, scenario: 'routine' }).spawn({
      ...spawnOptions,
      cwd: join(tmpdir(), 'agentcats-worktree'), // beside the main checkout, not around it
      policy: { access: 'workspace', allowedCommands, protectedPaths: [main], readablePaths },
    });
    const asked: string[] = [];
    const events: AgentEvent[] = [];
    const done = (async () => {
      for await (const event of session.events()) {
        events.push(event);
        if (event.type === 'approval.requested') {
          asked.push(event.inputSummary);
          void session.approve(event.requestId, 'allow');
        }
        if (event.type === 'turn.ended') void session.kill();
      }
    })();
    await session.send('do the routine');
    await done;
    expectValidStream(events);
    return asked;
  }

  it('asks for everything outside the policy, and always for network and installs', async () => {
    const asked = await approvalsUnder([], []);
    expect(asked).toEqual([
      join(main, 'package.json'),
      'pnpm test',
      'pnpm lint',
      'pnpm exec tsc --noEmit',
      'vitest run src',
      'curl -sI https://example.com',
      'pnpm add left-pad',
    ]);
  });

  it('runs allowed commands and readable paths without asking', async () => {
    const asked = await approvalsUnder(
      ['pnpm test', 'pnpm lint', 'pnpm exec tsc', 'vitest', 'pnpm add', 'curl'],
      [main],
    );
    expect(asked).toEqual(['curl -sI https://example.com', 'pnpm add left-pad']);
  });
});

describe('mock complete', () => {
  const ask = (systemPrompt: string, prompt: string) =>
    createMockAdapter().complete({ cwd: tmpdir(), model: null, systemPrompt, prompt });

  it("proposes the worker's Learned line in a debrief", async () => {
    const answer = await ask('# Debrief\n...', '## Summary\n- Learned: use the makeUser fixture');
    expect(answer.text).toBe('- use the makeUser fixture');
    expect(answer.usage.costUsd).toBeGreaterThan(0);
    expect((await ask('# Debrief', '- Learned: nothing new')).text).toBe('NONE');
  });

  it('returns the learnings unchanged in a consolidation', async () => {
    const answer = await ask('# Consolidation', '<learnings>\n- a (task 1)\n- b\n</learnings>');
    expect(answer.text).toBe('- a (task 1)\n- b');
  });

  it('uses a scripted answer when given one', async () => {
    const adapter = createMockAdapter({ complete: () => '- scripted' });
    const answer = await adapter.complete({
      cwd: tmpdir(),
      model: 'haiku',
      systemPrompt: '# Debrief',
      prompt: 'x',
    });
    expect(answer.text).toBe('- scripted');
  });
});
