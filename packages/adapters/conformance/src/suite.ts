import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isProcessAlive, killProcessTree } from '@agentcats/kit';
import {
  type Adapter,
  AgentEvent,
  type AgentPolicy,
  checkSessionInvariants,
  type Session,
} from '@agentcats/protocol/adapter';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * What the suite needs to drive one adapter: how to make it, and prompts
 * that make its agent do each thing. Live targets use real instructions
 * ("run curl ..."); scripted ones use their keywords.
 */
export interface ConformanceTarget {
  readonly name: string;
  readonly create: () => Adapter;
  readonly prompts: {
    /** A short turn that ends normally. */
    readonly reply: string;
    /** A turn that needs an approval before a tool runs. */
    readonly approval: string;
    /**
     * The permission mode the approval turn runs in. Default
     * `accept_edits`; an agent that asks only in a stricter mode (Codex asks
     * before edits in `ask`) sets it.
     */
    readonly approvalMode?: 'ask' | 'accept_edits' | 'auto';
    /**
     * A turn that keeps the agent busy for a while, to check `interrupt()`
     * (the board's Pause). Omitted skips that check; give one if
     * `capabilities.interrupt` is true.
     */
    readonly long?: string;
    /** A turn that creates `conformance.txt` in the working directory. */
    readonly write: string;
  };
  readonly model?: string | null;
  /** The policy for the session; defaults to a worker's. */
  readonly policy?: AgentPolicy;
  /** Per test; live agents need minutes. Default 30 s. */
  readonly timeoutMs?: number;
}

/** One session with its events collected, and waits on them. */
class Probe {
  readonly events: AgentEvent[] = [];
  readonly #done: Promise<void>;

  constructor(
    readonly session: Session,
    private readonly timeoutMs: number,
  ) {
    this.#done = (async () => {
      for await (const event of session.events()) this.events.push(event);
    })();
  }

  /** The next matching event after `from` (an index into `events`). */
  async waitFor(match: (e: AgentEvent) => boolean, from = 0): Promise<AgentEvent> {
    let found: AgentEvent | undefined;
    await vi.waitFor(
      () => {
        found = this.events.slice(from).find(match);
        expect(found, `waiting; saw ${this.events.map((e) => e.type).join(', ')}`).toBeDefined();
      },
      { timeout: this.timeoutMs, interval: 50 },
    );
    return found as AgentEvent;
  }

  /** Send and wait for that turn's end. */
  async turn(text: string): Promise<AgentEvent> {
    const from = this.events.length;
    await this.session.send(text);
    return this.waitFor((e) => e.type === 'turn.ended', from);
  }

  ended(): Promise<void> {
    return this.#done;
  }
}

const WORKER_POLICY = (cwd: string): AgentPolicy => ({
  access: 'workspace',
  allowedCommands: [],
  protectedPaths: [join(cwd, '..', 'not-the-worktree')],
});

/**
 * The adapter contract, checked against one adapter. Every adapter must pass
 * it before agentcats runs cats on it:
 *
 * - spawn, and a turn of valid normalized events;
 * - a follow-up message in the same session;
 * - an approval round trip, both allow and deny;
 * - kill leaves no process behind;
 * - usage with a cost, or an explicit unknown cost;
 * - the working directory is respected;
 * - a crash is reported, not a hang.
 */
export function describeConformance(target: ConformanceTarget): void {
  const timeoutMs = target.timeoutMs ?? 30_000;
  const dirs: string[] = [];
  const sessions: Session[] = [];
  let adapter: Adapter;

  describe(`conformance: ${target.name}`, { timeout: timeoutMs * 3 }, () => {
    afterEach(async () => {
      for (const session of sessions.splice(0)) await session.kill().catch(() => undefined);
      for (const dir of dirs.splice(0))
        await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    });

    async function start(
      permissionMode: 'ask' | 'accept_edits' | 'auto' = 'accept_edits',
    ): Promise<{ probe: Probe; cwd: string }> {
      adapter = target.create();
      const cwd = await mkdtemp(join(tmpdir(), 'agentcats-conformance-'));
      dirs.push(cwd);
      const session = await adapter.spawn({
        catId: 'conformance',
        cwd,
        model: target.model ?? null,
        systemPrompt:
          'You are being tested by the agentcats conformance suite. Keep answers short.',
        permissionMode,
        policy: target.policy ?? WORKER_POLICY(cwd),
      });
      sessions.push(session);
      return { probe: new Probe(session, timeoutMs), cwd };
    }

    it('answers preflight, if it has one, without throwing', async () => {
      const readiness = await target.create().preflight?.();
      if (!readiness) return;
      expect(typeof readiness.ready).toBe('boolean');
      expect(readiness.detail.trim()).not.toBe('');
      // A live target is about to run real turns, so it must be ready.
      expect(readiness).toMatchObject({ ready: true });
    });

    it('starts with session.started and plays a valid turn', async () => {
      const { probe } = await start();
      const ended = await probe.turn(target.prompts.reply);
      expect(ended).toMatchObject({ type: 'turn.ended', stopReason: 'end_turn' });
      expect(probe.events[0]?.type).toBe('session.started');
      expect(probe.events.some((e) => e.type === 'message.chunk' && e.channel === 'text')).toBe(
        true,
      );
      await probe.session.kill();
      await probe.ended();
      for (const event of probe.events) expect(AgentEvent.parse(event)).toEqual(event);
      expect(checkSessionInvariants(probe.events)).toEqual([]);
    });

    it('takes a follow-up message in the same session', async () => {
      const { probe } = await start();
      await probe.turn(target.prompts.reply);
      const second = await probe.turn(target.prompts.reply);
      expect(second).toMatchObject({ stopReason: 'end_turn' });
      expect(probe.events.filter((e) => e.type === 'turn.started')).toHaveLength(2);
    });

    for (const decision of ['allow', 'deny'] as const) {
      it(`round-trips an approval: ${decision}`, async () => {
        const { probe } = await start(target.prompts.approvalMode);
        if (!adapter.capabilities.approvals) return;
        const from = probe.events.length;
        await probe.session.send(target.prompts.approval);
        const request = await probe.waitFor((e) => e.type === 'approval.requested', from);
        if (request.type !== 'approval.requested') throw new Error('unreachable');
        await probe.session.approve(request.requestId, decision);
        const ended = await probe.waitFor((e) => e.type === 'turn.ended', from);
        expect(ended.type === 'turn.ended' && ended.stopReason).not.toBe('error');
        await expect(probe.session.approve(request.requestId, decision)).rejects.toMatchObject({
          code: 'not_found',
        });
      });
    }

    it('interrupts a running turn and stays usable', async () => {
      const long = target.prompts.long;
      const { probe } = await start();
      if (!long || !adapter.capabilities.interrupt) return;
      const from = probe.events.length;
      await probe.session.send(long);
      await probe.waitFor((e) => e.type === 'turn.started', from);
      await probe.session.interrupt();
      const ended = await probe.waitFor((e) => e.type === 'turn.ended', from);
      expect(ended).toMatchObject({ stopReason: 'cancelled' });
      // The session is still there for the next message.
      expect(await probe.turn(target.prompts.reply)).toMatchObject({ stopReason: 'end_turn' });
      await probe.session.kill();
      await probe.ended();
      expect(checkSessionInvariants(probe.events)).toEqual([]);
    });

    it('allows one events() iterator per session', async () => {
      const { probe } = await start();
      expect(() => probe.session.events()).toThrow();
    });

    it('leaves no process behind when killed', async () => {
      const { probe } = await start();
      const pid = probe.session.pid;
      await probe.turn(target.prompts.reply);
      await probe.session.kill();
      await probe.ended();
      expect(probe.events.at(-1)).toMatchObject({ type: 'session.ended', reason: 'killed' });
      if (pid !== null) {
        await vi.waitFor(
          () => {
            expect(isProcessAlive(pid)).toBe(false);
          },
          { timeout: 10_000 },
        );
      }
    });

    it('reports usage with a cost, or says the cost is unknown', async () => {
      const { probe } = await start();
      await probe.turn(target.prompts.reply);
      const usage = probe.events.filter((e) => e.type === 'usage');
      if (adapter.capabilities.reportsCost) {
        expect(usage.length).toBeGreaterThan(0);
        const last = usage.at(-1);
        expect(last?.usage.costUsd).toBeGreaterThanOrEqual(0);
      } else {
        for (const e of usage) {
          if (e.usage.costUsd === null) expect(e.usage.costSource).toBe('unknown');
        }
      }
    });

    it('works in its working directory', async () => {
      const { probe, cwd } = await start();
      const from = probe.events.length;
      await probe.session.send(target.prompts.write);
      // Approve whatever it asks for: this test is about where the file lands.
      const answered = new Set<string>();
      await vi.waitFor(
        async () => {
          for (const e of probe.events.slice(from)) {
            if (e.type === 'approval.requested' && !answered.has(e.requestId)) {
              answered.add(e.requestId);
              await probe.session.approve(e.requestId, 'allow').catch(() => undefined);
            }
          }
          expect(probe.events.slice(from).some((e) => e.type === 'turn.ended')).toBe(true);
        },
        { timeout: timeoutMs, interval: 100 },
      );
      expect(existsSync(join(cwd, 'conformance.txt'))).toBe(true);
    });

    it('reports a crash as the session ending, not a hang', async () => {
      const { probe } = await start();
      const pid = probe.session.pid;
      if (pid === null) return; // in-process adapters cannot crash this way
      await killProcessTree(pid);
      const ended = await probe.waitFor((e) => e.type === 'session.ended');
      expect(ended).toMatchObject({ reason: 'crashed' });
      await probe.ended();
    });
  });
}
