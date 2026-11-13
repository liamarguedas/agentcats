// M4 acceptance runs with real Claude and real Codex. Needs both gates:
// AGENTCATS_LIVE_CLAUDE=1 (Claude, on the user's login) and AGENTCATS_LIVE_CODEX=1
// (Codex through codex-acp, on the user's Codex login; billed per token on an
// API-key login).
//
//   AGENTCATS_LIVE_CLAUDE=1 AGENTCATS_LIVE_CODEX=1 pnpm exec vitest run packages/cli/test/live-m4.test.ts
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClaudeAdapter } from '@agentcats/adapter-claude';
import { createCodexAdapter } from '@agentcats/adapter-codex';
import { startDaemon } from '@agentcats/daemon';
import {
  AgentcatsConfig,
  type AgentcatsConfigInput,
  type BoardState,
  type Interview,
  Snapshot,
} from '@agentcats/protocol';
import { describe, expect, it } from 'vitest';

const LIVE =
  process.env['AGENTCATS_LIVE_CLAUDE'] === '1' && process.env['AGENTCATS_LIVE_CODEX'] === '1';
const OUT = process.env['AGENTCATS_LIVE_OUT'];

async function run(config: AgentcatsConfigInput) {
  const projectPath = await mkdtemp(join(tmpdir(), 'agentcats-live-m4-'));
  const worktreesDir = await mkdtemp(join(tmpdir(), 'agentcats-live-m4-wt-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: projectPath, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  await writeFile(
    join(projectPath, 'package.json'),
    JSON.stringify({ name: 'm4', type: 'module', scripts: { test: 'node --test' } }),
  );
  await writeFile(join(projectPath, 'math.js'), 'export const add = (a, b) => a + b;\n');
  git('add', '.');
  git(
    '-c',
    'user.name=live',
    '-c',
    'user.email=live@agentcats.local',
    'commit',
    '-q',
    '-m',
    'init',
  );
  const daemon = await startDaemon({
    projectPath,
    adapter: createClaudeAdapter(),
    adapters: [createCodexAdapter()],
    config: AgentcatsConfig.parse({ adapter: 'claude', worktreesDir, ...config }),
  });
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${daemon.url}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${daemon.token}`,
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path}: ${String(res.status)} ${text}`);
    return text ? (JSON.parse(text) as unknown) : null;
  };
  const board = async (): Promise<BoardState> =>
    Snapshot.parse(await api('GET', '/api/snapshot')).board;
  /** Wait for a condition, allowing every approval and logging it. */
  const until = async <T>(
    check: (b: BoardState) => T | null | undefined | false,
    log: string[],
  ) => {
    const deadline = Date.now() + 20 * 60_000;
    for (;;) {
      const b = await board();
      for (const a of Object.values(b.pendingApprovals)) {
        log.push(
          `approval: ${b.cats[a.catId]?.name ?? '?'} (${b.cats[a.catId]?.adapter ?? '?'}) ${a.toolName} ${a.inputSummary}`,
        );
        await api('POST', `/api/approvals/${a.id}`, { decision: 'allow' }).catch(() => null);
      }
      const value = check(b);
      if (value) return value;
      if (Date.now() > deadline) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 1_000));
    }
  };
  return { daemon, api, board, until };
}

async function report(lines: string[]) {
  const text = lines.join('\n');
  console.log(text);
  if (OUT) await writeFile(OUT, `${text}\n`, { flag: 'a' });
}

describe.runIf(LIVE)('M4 live', () => {
  it(
    'a Claude lead and a Codex worker produce a reviewable branch',
    async () => {
      // The cheapest Codex model, to stay inside a small API budget.
      const r = await run({ workers: { adapter: 'codex', max: 1, model: 'gpt-5.4-mini' } });
      const log = ['# Claude lead, Codex worker', ''];
      try {
        await r.api('POST', '/api/chat', {
          text: 'Add a subtract(a, b) function to math.js next to add, with a node:test test in math.test.js. One task is enough.',
        });
        const task = await r.until(
          (b) => Object.values(b.tasks).find((t) => ['review', 'failed'].includes(t.status)),
          log,
        );
        const b = await r.board();
        const worker = b.cats[task.assigneeCatId!]!;
        log.push(
          `task: ${task.status} on ${task.branch ?? '-'} · ${String(task.result?.diffStat.files ?? 0)} files +${String(task.result?.diffStat.insertions ?? 0)}`,
          `worker: ${worker.name} on ${worker.adapter} (${worker.model ?? 'default'}) · cost ${String(b.usage[worker.id]?.costUsd)} · ${String(Math.round((b.usage[worker.id]?.activeMs ?? 0) / 1000))} s working`,
        );
        expect(worker.adapter).toBe('codex');
        expect(task.status).toBe('review');
        expect(task.result?.diffStat.files).toBeGreaterThan(0);
      } finally {
        await report(log);
        await r.daemon.close();
      }
    },
    30 * 60_000,
  );

  it(
    'an interview compares a Claude and a Codex candidate on the same sample',
    async () => {
      const r = await run({});
      const log = ['', '# Claude vs Codex interview (add-function)', ''];
      try {
        const { interview } = (await r.api('POST', '/api/interviews', {
          // The fast tier: haiku for Claude, gpt-5.4-mini for Codex.
          role: { description: 'Writes small, careful changes with tests', tier: 'fast' },
          sampleId: 'add-function',
          adapters: ['claude', 'codex'],
        })) as { interview: Interview };
        log.push(
          `estimate: ${interview.estimateUsd === null ? 'cost unknown (Codex reports none)' : `$${interview.estimateUsd.toFixed(2)}`}`,
        );
        await r.api('POST', `/api/interviews/${interview.id}/start`);
        const decided = await r.until(
          (b) => b.interviews[interview.id]?.status === 'deciding' && b.interviews[interview.id],
          log,
        );
        const b = await r.board();
        for (const c of decided.candidates) {
          const res = c.result!;
          log.push(
            `${b.cats[c.catId]?.name ?? '?'} (${b.cats[c.catId]?.adapter ?? '?'}): ${res.passed ? 'pass' : 'fail'} · +${String(res.diff.insertions)} -${String(res.diff.deletions)} · ${res.costUsd === null ? 'cost unknown' : `$${res.costUsd.toFixed(3)}`} · ${String(Math.round(res.durationMs / 1000))} s · score ${String(c.score?.total ?? 'not hireable')} (diff ${String(c.score?.diff)}, cost ${String(c.score?.cost)}, time ${String(c.score?.time)}, quality ${String(c.score?.quality)})`,
          );
        }
        expect(decided.candidates.map((c) => b.cats[c.catId]?.adapter)).toEqual([
          'claude',
          'codex',
        ]);
        expect(decided.candidates.every((c) => c.score !== null)).toBe(true);
        await r.api('POST', `/api/interviews/${interview.id}/cancel`).catch(() => null);
      } finally {
        await report(log);
        await r.daemon.close();
      }
    },
    40 * 60_000,
  );
});
