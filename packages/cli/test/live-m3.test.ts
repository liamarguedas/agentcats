// M3 acceptance run against the real Claude Code CLI, on the user's own login.
// Spends plan usage (or tokens), so it only runs with AGENTCATS_LIVE_CLAUDE=1.
//
//   AGENTCATS_LIVE_CLAUDE=1 pnpm exec vitest run packages/cli/test/live-m3.test.ts
//
// AGENTCATS_LIVE_SAMPLE picks the bundled sample (default add-function),
// AGENTCATS_LIVE_TIER the tier (default balanced), AGENTCATS_LIVE_OUT where the
// report goes (default: printed only).
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isProcessAlive } from '@agentcats/kit';
import { createClaudeAdapter } from '@agentcats/adapter-claude';
import { startDaemon } from '@agentcats/daemon';
import { AgentcatsConfig, type BoardState, type Interview, Snapshot } from '@agentcats/protocol';
import { describe, expect, it } from 'vitest';

const LIVE = process.env['AGENTCATS_LIVE_CLAUDE'] === '1';
const SAMPLE = process.env['AGENTCATS_LIVE_SAMPLE'] ?? 'add-function';
const TIER = (process.env['AGENTCATS_LIVE_TIER'] ?? 'balanced') as 'fast' | 'balanced' | 'best';
const OUT = process.env['AGENTCATS_LIVE_OUT'];

describe.runIf(LIVE)('M3 live', () => {
  it(
    'interviews two real candidates on a bundled sample, scores them, and hires one',
    async () => {
      const projectPath = await mkdtemp(join(tmpdir(), 'agentcats-live-hire-'));
      const worktreesDir = await mkdtemp(join(tmpdir(), 'agentcats-live-hire-wt-'));
      const git = (...args: string[]) =>
        execFileSync('git', args, { cwd: projectPath, stdio: 'pipe' });
      git('init', '-q', '-b', 'main');
      await writeFile(join(projectPath, 'README.md'), '# hire test\n');
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
        config: AgentcatsConfig.parse({ adapter: 'claude', worktreesDir }),
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
      const lines: string[] = [`# Live interview: ${SAMPLE}, tier ${TIER}`, ''];
      const started = Date.now();
      try {
        const { interview } = (await api('POST', '/api/interviews', {
          role: { description: 'Writes small, careful changes with tests', tier: TIER },
          sampleId: SAMPLE,
          candidates: 2,
        })) as { interview: Interview };
        lines.push(`Estimate shown before start: $${interview.estimateUsd.toFixed(2)}`);
        expect(interview.status).toBe('proposed');

        // Approvals during the interview: allow, and log them.
        let deciding: Interview | undefined;
        const deadline = Date.now() + 30 * 60_000;
        await api('POST', `/api/interviews/${interview.id}/start`);
        while (!deciding) {
          if (Date.now() > deadline) throw new Error('interview did not finish');
          const b = await board();
          for (const approval of Object.values(b.pendingApprovals)) {
            lines.push(
              `approval: ${b.cats[approval.catId]?.name ?? '?'} ${approval.toolName} ${approval.inputSummary}`,
            );
            await api('POST', `/api/approvals/${approval.id}`, { decision: 'allow' }).catch(
              () => null,
            );
          }
          const current = b.interviews[interview.id];
          if (current?.status === 'deciding') deciding = current;
          await new Promise((r) => setTimeout(r, 1_000));
        }

        const b = await board();
        lines.push(
          '',
          '| Candidate | Tests | Diff | Cost | Time | Lint | Score |',
          '|---|---|---|---|---|---|---|',
        );
        for (const c of deciding.candidates) {
          const r = c.result!;
          lines.push(
            `| ${b.cats[c.catId]?.name ?? c.catId} | ${r.passed ? 'pass' : 'fail'} | +${String(r.diff.insertions)} -${String(r.diff.deletions)} | $${(r.costUsd ?? 0).toFixed(3)} | ${String(Math.round(r.durationMs / 1000))} s | ${String(r.lintClean)} | ${c.score?.total ?? 'not hireable'} |`,
          );
          if (r.failure) lines.push(`    failure: ${r.failure}`);
        }
        const best = deciding.candidates
          .filter((c) => c.score?.total != null)
          .sort((a, c) => (c.score?.total ?? 0) - (a.score?.total ?? 0))[0];
        expect(best, 'at least one candidate passed').toBeDefined();

        await api('POST', `/api/interviews/${interview.id}/pick`, { catId: best!.catId });
        const after = await board();
        const winner = after.cats[best!.catId]!;
        expect(winner.role).toBe('worker');
        expect(Object.values(after.cats).some((c) => c.role === 'candidate')).toBe(false);
        const leftovers = await readdir(join(worktreesDir, 'interviews')).catch(() => []);
        expect(leftovers).toEqual([]);
        lines.push(
          '',
          `Hired ${winner.name}. Candidates left on the board: 0. Interview folders left: ${String(leftovers.length)}.`,
          `Total ${String(Math.round((Date.now() - started) / 1000))} s.`,
        );
        const recorded = JSON.parse(
          await readFile(join(projectPath, '.agentcats', 'run', 'pids.json'), 'utf8'),
        ) as { processes: { pid: number }[] };
        const alive = recorded.processes.filter((p) => isProcessAlive(p.pid));
        lines.push(`Agent processes still running: ${String(alive.length)}.`);
        expect(alive).toEqual([]);
      } finally {
        const text = lines.join('\n');
        console.log(text);
        if (OUT) await writeFile(OUT, `${text}\n`);
        await daemon.close();
      }
    },
    40 * 60_000,
  );
});
