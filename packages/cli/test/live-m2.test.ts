// M2 acceptance runs against the real Claude Code CLI, on the user's own login.
// Spends plan usage (or tokens), so it only runs with AGENTCATS_LIVE_CLAUDE=1.
//
//   AGENTCATS_LIVE_CLAUDE=1 pnpm exec vitest run packages/cli/test/live-m2.test.ts -t levels
//   AGENTCATS_LIVE_CLAUDE=1 pnpm exec vitest run packages/cli/test/live-m2.test.ts -t learning
//
// AGENTCATS_LIVE_MODEL picks the worker model (default sonnet), AGENTCATS_LIVE_TASKS
// how many tasks the learning run does (default 10), AGENTCATS_LIVE_OUT where the
// report goes (default: printed only).
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { createClaudeAdapter } from '@agentcats/adapter-claude';
import { type RunningDaemon, startDaemon } from '@agentcats/daemon';
import {
  AgentcatsConfig,
  type AgentcatsConfigInput,
  type BoardState,
  Snapshot,
  type Task,
} from '@agentcats/protocol';
import { describe, expect, it } from 'vitest';

const LIVE = process.env['AGENTCATS_LIVE_CLAUDE'] === '1';
const MODEL = process.env['AGENTCATS_LIVE_MODEL'] ?? 'sonnet';
const TASKS = Number(process.env['AGENTCATS_LIVE_TASKS'] ?? 10);
const OUT = process.env['AGENTCATS_LIVE_OUT'];

const FILES: Record<string, string> = {
  'package.json': `${JSON.stringify(
    {
      name: 'notes-api',
      private: true,
      type: 'module',
      scripts: { test: 'node --test test/', lint: 'node scripts/lint.js' },
    },
    null,
    2,
  )}\n`,
  'package-lock.json': `${JSON.stringify({ name: 'notes-api', lockfileVersion: 3, requires: true, packages: { '': { name: 'notes-api' } } }, null, 2)}\n`,
  'README.md':
    '# notes-api\n\nA tiny notes HTTP API with no dependencies. `npm test`, `npm run lint`.\n',
  'docs/API.md':
    '# API\n\n- `GET /notes`: all notes.\n- `POST /notes`: create a note from `{ title, body }`.\n- `GET /notes/:id`: one note.\n- `DELETE /notes/:id`: delete a note.\n',
  'src/store.js': `let nextId = 1;
const notes = new Map();

export function createNote({ title, body = '' }) {
  const note = { id: String(nextId++), title, body };
  notes.set(note.id, note);
  return note;
}

export const listNotes = () => [...notes.values()];
export const getNote = (id) => notes.get(id) ?? null;
export const deleteNote = (id) => notes.delete(id);
export function resetStore() {
  notes.clear();
  nextId = 1;
}
`,
  'src/http.js': `/** An error with an HTTP status. Route handlers throw these; app.js turns them into JSON. */
export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
`,
  'src/routes.js': `import { httpError } from './http.js';
import { createNote, deleteNote, getNote, listNotes } from './store.js';

/** Every route. app.js matches them in order; \`:name\` segments become params. */
export const ROUTES = [
  { method: 'GET', path: '/notes', handler: () => listNotes() },
  { method: 'POST', path: '/notes', handler: ({ body }) => createNote(body ?? {}) },
  {
    method: 'GET',
    path: '/notes/:id',
    handler: ({ params }) => getNote(params.id) ?? Promise.reject(httpError(404, 'note not found')),
  },
  {
    method: 'DELETE',
    path: '/notes/:id',
    handler: ({ params }) => {
      if (!deleteNote(params.id)) throw httpError(404, 'note not found');
      return { deleted: params.id };
    },
  },
];
`,
  'src/app.js': `import { ROUTES } from './routes.js';

function match(pattern, path) {
  const a = pattern.split('/');
  const b = path.split('/');
  if (a.length !== b.length) return null;
  const params = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(':')) params[a[i].slice(1)] = decodeURIComponent(b[i]);
    else if (a[i] !== b[i]) return null;
  }
  return params;
}

/** Handle one request without a server: { method, url, body } in, { status, body } out. */
export async function handle({ method, url, body }) {
  const { pathname, searchParams } = new URL(url, 'http://local');
  for (const route of ROUTES) {
    const params = route.method === method ? match(route.path, pathname) : null;
    if (!params) continue;
    try {
      return { status: 200, body: await route.handler({ params, query: searchParams, body }) };
    } catch (error) {
      return { status: error.status ?? 500, body: { error: error.message } };
    }
  }
  return { status: 404, body: { error: 'not found' } };
}
`,
  'test/helpers.js': `import { handle } from '../src/app.js';
import { createNote, resetStore } from '../src/store.js';

/** Fresh store for each test. Call it in beforeEach. */
export const reset = () => resetStore();

/** A note in the store, with defaults. Tests create notes through this, never through POST. */
export const makeNote = (overrides = {}) =>
  createNote({ title: 'A note', body: 'Some text', ...overrides });

/** Call the app in-process. */
export const request = (method, url, body) => handle({ method, url, body });
`,
  'test/notes.test.js': `import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { makeNote, request, reset } from './helpers.js';

beforeEach(reset);

test('lists notes', async () => {
  makeNote({ title: 'one' });
  const res = await request('GET', '/notes');
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
});

test('404 for a missing note', async () => {
  const res = await request('GET', '/notes/nope');
  assert.equal(res.status, 404);
});
`,
  'scripts/lint.js': `// Project rules the tests do not check.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const problems = [];
for (const file of readdirSync('src')) {
  const text = readFileSync(join('src', file), 'utf8');
  if (/console\\.log/.test(text)) problems.push(\`src/\${file}: no console.log in src/\`);
  if (file === 'routes.js' && /new Error\\(/.test(text)) {
    problems.push('src/routes.js: throw httpError(status, message), never a plain Error');
  }
}
const routes = readFileSync('src/routes.js', 'utf8').match(/path: '([^']+)'/g) ?? [];
const docs = readFileSync('docs/API.md', 'utf8');
for (const path of routes.map((r) => r.slice(7, -1))) {
  if (!docs.includes(path)) problems.push(\`docs/API.md does not document \${path}\`);
}
if (problems.length) {
  console.error(problems.join('\\n'));
  process.exit(1);
}
console.log('lint ok');
`,
};

const LEARNING_TASKS = [
  'Add GET /notes/:id/word-count, returning { id, words } with the number of words in the body.',
  'Add PATCH /notes/:id to update the title and/or body of a note.',
  'On POST /notes, require a title of 1 to 100 characters; answer 400 with an error otherwise.',
  'Add pagination to GET /notes with ?limit= (default 20, max 100) and ?offset= (default 0).',
  'Notes get an optional tags array of strings; GET /notes?tag=x returns only notes with that tag.',
  'Add GET /stats returning the number of notes and the number of distinct tags.',
  'Add GET /notes/search?q= that returns notes whose title or body contains q, case-insensitive.',
  'Notes get createdAt and updatedAt ISO timestamps, set on create and on every update.',
  'Add DELETE /notes that deletes every note, but only with ?confirm=yes; otherwise answer 400.',
  'Answer 405 with an error for a known path with the wrong method, instead of 404.',
];

async function sampleProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agentcats-live-notes-'));
  for (const [file, content] of Object.entries(FILES)) {
    await mkdir(dirname(join(dir, file)), { recursive: true });
    await writeFile(join(dir, file), content);
  }
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'agentcats live');
  git('config', 'user.email', 'live@agentcats.local');
  await writeFile(join(dir, '.gitignore'), 'node_modules/\n');
  git('add', '.');
  git('commit', '-q', '-m', 'notes-api');
  return dir;
}

interface Run {
  readonly daemon: RunningDaemon;
  readonly projectPath: string;
  /** Approvals the "user" answered, per task. */
  readonly asked: Map<string, string[]>;
  board(): Promise<BoardState>;
  api(method: string, path: string, body?: unknown): Promise<unknown>;
  close(): Promise<void>;
}

/** A daemon with the real Claude adapter whose user allows every approval and logs it. */
async function startRun(config: AgentcatsConfigInput): Promise<Run> {
  const projectPath = await sampleProject();
  const daemon = await startDaemon({
    projectPath,
    adapter: createClaudeAdapter(),
    config: AgentcatsConfig.parse({
      adapter: 'claude',
      workers: { max: 1, model: MODEL },
      ...config,
    }),
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
  const board = async () => Snapshot.parse(await api('GET', '/api/snapshot')).board;
  const asked = new Map<string, string[]>();
  const state = { running: true };
  const answering = (async () => {
    while (state.running) {
      for (const approval of Object.values((await board()).pendingApprovals)) {
        const key = approval.taskId ?? 'none';
        asked.set(key, [
          ...(asked.get(key) ?? []),
          `${approval.toolName}: ${approval.inputSummary}`,
        ]);
        await api('POST', `/api/approvals/${approval.id}`, { decision: 'allow' }).catch(() => null);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  })();
  return {
    daemon,
    projectPath,
    asked,
    board,
    api,
    close: async () => {
      state.running = false;
      await answering;
      await daemon.close();
    },
  };
}

async function until<T>(
  what: string,
  check: () => Promise<T | null>,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

/** Run one task to its end; returns it in review, failed or interrupted. */
async function runTask(run: Run, title: string, catId?: string): Promise<Task> {
  const { task } = (await run.api('POST', '/api/tasks', {
    title: title.slice(0, 200),
    description: title,
    ...(catId && { catId }),
  })) as { task: Task };
  return until(
    `task "${title}"`,
    async () => {
      const current = (await run.board()).tasks[task.id];
      return current && ['review', 'failed', 'interrupted'].includes(current.status)
        ? current
        : null;
    },
    15 * 60_000,
  );
}

/** Wait until the debrief (and any consolidation) for a task has settled. */
async function settled(run: Run, catId: string): Promise<void> {
  await new Promise((r) => setTimeout(r, 3_000));
  await until(
    'debrief',
    async () => {
      const board = await run.board();
      return Object.values(board.proposals).some((p) => p.catId === catId) ? true : null;
    },
    90_000,
  ).catch(() => null); // a debrief may propose nothing
}

function report(lines: string[]) {
  const text = lines.join('\n');
  console.log(text);
  return OUT ? writeFile(OUT, `${text}\n`) : Promise.resolve();
}

describe.runIf(LIVE)('M2 live', () => {
  it(
    'levels: a level 4 cat raises fewer approvals than a level 1 cat, and both ask for network',
    async () => {
      const sample = [
        'Add GET /notes/:id/word-count, returning { id, words } with the number of words in the body. Run the tests and the linter, check with curl -sI https://example.com that the network is reachable before you start, and commit.',
        'On POST /notes, require a title of 1 to 100 characters; answer 400 with an error otherwise. Run the tests and the linter, and commit.',
      ];
      const results: string[] = [];
      for (const level of [1, 4]) {
        // 150 XP for the warm-up makes the level 4 cat; 0 keeps the other at level 1.
        const run = await startRun({
          xp: { accepted: level === 4 ? 150 : 0, testsFirstTry: 0, underCost: 0 },
          memory: { debrief: false },
        });
        try {
          const warm = await runTask(
            run,
            'Add a one-line description of the project to the top of README.md, and commit.',
          );
          await run.api('POST', `/api/tasks/${warm.id}/review`, { decision: 'accept' });
          const catId = warm.assigneeCatId!;
          expect((await run.board()).cats[catId]?.level).toBe(level);
          for (const title of sample) {
            const task = await runTask(run, title, catId);
            const asked = run.asked.get(task.id) ?? [];
            results.push(
              `level ${String(level)} · ${task.status} · ${String(asked.length)} approvals · ${title.slice(0, 60)}`,
            );
            for (const a of asked) results.push(`    ${a}`);
          }
        } finally {
          await run.close();
        }
      }
      await report(['# Levels: approvals per task', '', ...results]);
      const count = (level: number) =>
        results
          .filter((r) => r.startsWith(`level ${String(level)} `))
          .reduce((n, r) => n + Number(/(\d+) approvals/.exec(r)?.[1] ?? 0), 0);
      expect(count(4)).toBeLessThan(count(1));
      const level4 = results.join('\n').split('level 4')[1] ?? '';
      expect(level4).toMatch(/curl/);
    },
    90 * 60_000,
  );

  it(
    'learning: ten real tasks build a learnings file',
    async () => {
      const run = await startRun({});
      const lines: string[] = [`# Learning run: ${String(TASKS)} tasks, model ${MODEL}`, ''];
      const started = Date.now();
      let catId = '';
      try {
        for (const [i, title] of LEARNING_TASKS.slice(0, TASKS).entries()) {
          const task = await runTask(run, title, catId || undefined);
          catId = task.assigneeCatId ?? catId;
          if (task.status !== 'review') {
            lines.push(`${String(i + 1)}. ${task.status}: ${title}`);
            continue;
          }
          const ok = task.result?.tests === 'passed';
          await run.api(
            'POST',
            `/api/tasks/${task.id}/review`,
            ok
              ? { decision: 'accept' }
              : {
                  decision: 'reject',
                  note: `Tests were reported as ${task.result?.tests ?? 'unknown'}; they must pass.`,
                },
          );
          // The user merges accepted work, so the next task builds on it.
          if (ok) {
            try {
              execFileSync('git', ['merge', '--no-edit', '-q', task.branch!], {
                cwd: run.projectPath,
                stdio: 'pipe',
              });
            } catch {
              execFileSync('git', ['merge', '--abort'], { cwd: run.projectPath, stdio: 'pipe' });
              lines.push(`    (merge conflict, not merged)`);
            }
          }
          await settled(run, catId);
          for (const proposal of Object.values((await run.board()).proposals).filter(
            (p) => p.catId === catId,
          )) {
            lines.push(
              `    ${proposal.kind} (${proposal.trigger}): ${proposal.lines.map((l) => l.text).join(' | ')}`,
            );
            await run
              .api('POST', `/api/proposals/${proposal.id}`, { decision: 'accept' })
              .catch((e: unknown) => {
                lines.push(`    could not accept: ${String(e)}`);
              });
          }
          const cat = (await run.board()).cats[catId]!;
          lines.push(
            `${String(i + 1)}. ${ok ? 'accepted' : 'rejected'} · level ${String(cat.level)} · ${String(cat.xp)} XP · ${String(cat.learnings.length)} learnings · ${String((run.asked.get(task.id) ?? []).length)} approvals · $${(task.result?.costUsd ?? 0).toFixed(3)} · ${title}`,
          );
        }
        const board = await run.board();
        const cat = board.cats[catId]!;
        lines.push(
          '',
          `Total ${String(Math.round((Date.now() - started) / 60_000))} min, $${(board.usage[catId]?.costUsd ?? 0).toFixed(2)} (API-equivalent), level ${String(cat.level)}, ${String(cat.xp)} XP`,
          '',
          '## learnings.md',
          '',
          await readFile(
            join(run.projectPath, '.agentcats', 'cats', cat.name, 'learnings.md'),
            'utf8',
          ),
          `Project kept at ${run.projectPath}`,
        );
      } finally {
        await report(lines);
        await run.close();
      }
    },
    4 * 60 * 60_000,
  );
});
