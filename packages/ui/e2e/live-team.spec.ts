// M1 acceptance, end to end with the real Claude Code CLI: the orchestrator
// splits a request between workers in parallel worktrees, and the result is
// reviewable branches. Spends real tokens, so it only runs with
// AGENTCATS_LIVE_CLAUDE=1. Writes what it saw to test-results/live-team.json
// for the handoff notes.
//
//   AGENTCATS_LIVE_CLAUDE=1 pnpm test:e2e -- live-team
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { expect, test } from '@playwright/test';

const LIVE = process.env['AGENTCATS_LIVE_CLAUDE'] === '1';
/** Model for every cat. `sonnet` is the product default for workers; `haiku` makes a cheap smoke run. */
const MODEL = process.env['AGENTCATS_LIVE_MODEL'] ?? 'sonnet';
/** `mock` dry-runs this test's own logic without spending tokens. */
const ADAPTER = process.env['AGENTCATS_LIVE_ADAPTER'] === 'mock' ? 'mock' : 'claude';
/**
 * Two pieces of work the user wants split. M1's sentence, "Add a login
 * endpoint and write tests for it", left the split to the lead, and haiku
 * twice kept it in one task (the endpoint and its tests share files), a fair
 * call that failed the parallelism check. This tests what agentcats owns:
 * the lead follows the split and the workers run at once. Both features are
 * fully specified: given a bare "POST /login", the lead rightly held it back
 * to ask what a login should check.
 */
const WORK =
  'Add two separate features, each as its own task with its own tests. ' +
  '1) POST /login: takes JSON { "username", "password" }; returns 200 { "ok": true } for ' +
  'username "admin" with password "secret" (hardcoded, this is a sample app), and 401 ' +
  '{ "error": "invalid credentials" } otherwise. ' +
  '2) GET /version: returns { "version": "1.0.0" }; add "version": "1.0.0" to package.json and read it from there.';
const REQUEST = ADAPTER === 'mock' ? `${WORK}\n/approval` : WORK;
const SHOTS = 'test-results/screenshots';
const NETWORK =
  /\b(curl|wget|npm (i|install|add)|pnpm (add|install)|npx|pip|git (fetch|pull|clone|push))\b|WebFetch|WebSearch/i;

interface Snapshot {
  board: {
    tasks: Record<
      string,
      {
        id: string;
        title: string;
        status: string;
        branch: string | null;
        result: unknown;
        attempt: number;
        statusReason: string | null;
      }
    >;
    cats: Record<string, { id: string; name: string; role: string }>;
    usage: Record<string, { costUsd: number | null; inputTokens: number; outputTokens: number }>;
  };
  events: { type: string; catId?: string; payload: Record<string, unknown> }[];
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();

async function sampleRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'agentcats-sample-'));
  await mkdir(join(repo, 'src'));
  await mkdir(join(repo, 'test'));
  await writeFile(
    join(repo, 'package.json'),
    JSON.stringify(
      { name: 'sample-api', private: true, type: 'module', scripts: { test: 'node --test' } },
      null,
      2,
    ),
  );
  await writeFile(
    join(repo, 'src', 'app.js'),
    [
      "import { createServer } from 'node:http';",
      '',
      '/** Route a request. Returns { status, body }. */',
      'export function handle(method, url) {',
      "  if (method === 'GET' && url === '/health') return { status: 200, body: { ok: true } };",
      "  return { status: 404, body: { error: 'not found' } };",
      '}',
      '',
      'export function server() {',
      '  return createServer((req, res) => {',
      '    const { status, body } = handle(req.method, req.url);',
      "    res.writeHead(status, { 'Content-Type': 'application/json' });",
      '    res.end(JSON.stringify(body));',
      '  });',
      '}',
      '',
    ].join('\n'),
  );
  await writeFile(
    join(repo, 'test', 'health.test.js'),
    [
      "import { test } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { handle } from '../src/app.js';",
      '',
      "test('GET /health is ok', () => {",
      "  assert.deepEqual(handle('GET', '/health'), { status: 200, body: { ok: true } });",
      '});',
      '',
    ].join('\n'),
  );
  await writeFile(
    join(repo, 'README.md'),
    '# sample-api\n\nA tiny HTTP API. Run tests with `npm test`.\n',
  );
  await writeFile(join(repo, '.gitignore'), 'node_modules/\n.agentcats/\n');
  await mkdir(join(repo, '.agentcats'));
  await writeFile(
    join(repo, '.agentcats', 'agentcats.config.json'),
    JSON.stringify({
      adapter: ADAPTER,
      orchestrator: { model: MODEL },
      workers: { model: MODEL, allowedCommands: ['npm test', 'node --test'] },
      worktreesDir: join(repo, '..', `${repo.split(/[\\/]/).pop() ?? 'sample'}-worktrees`),
    }),
  );
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'core.autocrlf', 'false');
  git(repo, 'add', '.');
  git(
    repo,
    '-c',
    'user.name=sample',
    '-c',
    'user.email=sample@example.com',
    'commit',
    '-q',
    '-m',
    'sample api',
  );
  return repo;
}

test.describe('live Claude team', () => {
  test.skip(!LIVE, 'set AGENTCATS_LIVE_CLAUDE=1 to run against the real Claude Code CLI');
  test.describe.configure({ timeout: 25 * 60_000 });

  let repo = '';
  let cli: ChildProcess | null = null;
  test.afterAll(async () => {
    cli?.kill();
    await new Promise((r) => setTimeout(r, 2_000));
    if (repo) {
      await rm(`${repo}-worktrees`, { recursive: true, force: true, maxRetries: 10 });
      await rm(repo, { recursive: true, force: true, maxRetries: 10 });
    }
  });

  test('two requested features give two parallel workers and reviewable branches', async ({
    page,
  }) => {
    repo = await sampleRepo();
    cli = spawn(
      process.execPath,
      [
        '--conditions=@agentcats/source',
        '--import',
        'tsx',
        '../cli/src/bin.ts',
        '--project',
        repo,
        '--no-open',
      ],
      { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true },
    );
    const boardUrl = await new Promise<string>((resolve) => {
      createInterface({ input: cli!.stdout! }).on('line', (line) => {
        console.log(`[cli] ${line}`);
        if (line.startsWith('Board: ')) resolve(line.slice('Board: '.length));
      });
    });
    const { origin, hash } = new URL(boardUrl);
    const token = new URLSearchParams(hash.slice(1)).get('token')!;
    const snapshot = async () =>
      (await (
        await fetch(`${origin}/api/snapshot`, { headers: { Authorization: `Bearer ${token}` } })
      ).json()) as Snapshot;

    await page.goto(boardUrl);
    await expect(page.getByTestId('connection')).toHaveText('Live');
    const input = page.getByLabel('Task for the cat');
    await input.fill(REQUEST);
    await input.press('Enter');

    const approvals: { tool: string; decision: string }[] = [];
    const deadline = Date.now() + 20 * 60_000;
    let shotWorking = false;
    let settledAt = 0;
    let lastLog = 0;
    for (;;) {
      if (Date.now() > deadline) throw new Error('the team did not finish in 20 minutes');
      const bubble = page.getByRole('alertdialog').first();
      if (await bubble.isVisible().catch(() => false)) {
        const text = (await bubble.textContent()) ?? '';
        const decision = NETWORK.test(text) ? 'Deny' : 'Allow';
        approvals.push({ tool: text.replace(/\s+/g, ' ').trim().slice(0, 200), decision });
        console.log(`[test] ${decision}: ${text.replace(/\s+/g, ' ').slice(0, 120)}`);
        await bubble
          .getByRole('button', { name: decision })
          .click({ timeout: 5_000 })
          .catch((error: unknown) => {
            console.log(`[test] click failed: ${String(error).slice(0, 200)}`);
          });
        await page.waitForTimeout(500);
        continue;
      }
      const state = await snapshot();
      if (Date.now() - lastLog > 30_000) {
        lastLog = Date.now();
        const summary = Object.values(state.board.tasks)
          .map((t) => t.status)
          .join(', ');
        console.log(`[test] tasks: ${summary || 'none'}`);
      }
      const tasks = Object.values(state.board.tasks);
      const busy = tasks.some((t) => ['queued', 'running', 'blocked'].includes(t.status));
      if (!shotWorking && tasks.filter((t) => t.status === 'running').length >= 2) {
        await page.screenshot({ path: `${SHOTS}/live-team-working.png`, animations: 'disabled' });
        shotWorking = true;
      }
      // Done once tasks exist, none is active, and the lead has had time to report.
      if (tasks.length > 0 && !busy) {
        settledAt ||= Date.now();
        const lead = Object.values(state.board.cats).find((c) => c.role === 'orchestrator');
        const leadIdle =
          !lead ||
          !['thinking', 'working'].includes(
            (state.board.cats[lead.id] as { status?: string }).status ?? '',
          );
        if (leadIdle && Date.now() - settledAt > 15_000) {
          console.log('[test] settled');
          break;
        }
      } else {
        settledAt = 0;
      }
      await page.waitForTimeout(1_000);
    }
    await page.screenshot({ path: `${SHOTS}/live-team-done.png`, animations: 'disabled' });

    const state = await snapshot();
    const tasks = Object.values(state.board.tasks);
    let running = 0;
    let peak = 0;
    for (const e of state.events) {
      if (e.type !== 'task.updated' || e.payload['status'] === undefined) continue;
      if (e.payload['status'] === 'running') running += 1;
      if (['review', 'failed', 'cancelled', 'queued'].includes(e.payload['status'] as string))
        running -= 1;
      peak = Math.max(peak, running);
    }
    const lead = Object.values(state.board.cats).find((c) => c.role === 'orchestrator')!;
    const leadText = state.events
      .filter(
        (e) => e.type === 'message.agent' && e.catId === lead.id && e.payload['channel'] === 'text',
      )
      .map((e) => e.payload['text'] as string)
      .join('');
    const branches = tasks.map((t) => ({
      title: t.title,
      status: t.status,
      attempt: t.attempt,
      branch: t.branch,
      commits: t.branch ? Number(git(repo, 'rev-list', '--count', `main..${t.branch}`)) : 0,
      reason: t.statusReason,
      result: t.result,
    }));
    const cost = Object.values(state.board.usage).reduce((sum, u) => sum + (u.costUsd ?? 0), 0);
    const report = { tasks: branches, peakParallel: peak, approvals, leadText, costUsd: cost };
    await writeFile('test-results/live-team.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));

    expect(tasks.length).toBeGreaterThanOrEqual(2);
    expect(peak).toBeGreaterThanOrEqual(2);
    for (const t of branches) {
      expect(t.status).toBe('review');
      // The CLI's mock acts work out and never changes the repo.
      if (ADAPTER !== 'mock') expect(t.commits).toBeGreaterThan(0);
    }
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(git(repo, 'branch', '--show-current')).toBe('main');
  });
});
