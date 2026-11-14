import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { createMockAdapter } from '@agentcats/adapter-mock';
import { ConfigError, runningDaemon } from '@agentcats/daemon';
import { Snapshot, type Task } from '@agentcats/protocol';
import type { Adapter } from '@agentcats/protocol/adapter';

const execFileAsync = promisify(execFile);

export interface DemoProject {
  readonly projectPath: string;
  /** Remove the project and its worktrees. */
  readonly remove: () => Promise<void>;
}

const FILES: Readonly<Record<string, string>> = {
  'README.md': '# demo shop\n\nA tiny project for the agentcats demo.\n',
  'package.json': `${JSON.stringify({ name: 'demo-shop', type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`,
  'src/cart.js': 'export const total = (items) => items.reduce((sum, i) => sum + i.price, 0);\n',
  'test/cart.test.js':
    "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { total } from '../src/cart.js';\n\ntest('adds prices', () => assert.equal(total([{ price: 2 }, { price: 3 }]), 5));\n",
  '.gitignore': '.agentcats/\nnode_modules/\n',
};

/**
 * A throwaway git repository for `--demo`, with its worktrees next to it in
 * the temp directory, so the demo leaves nothing behind.
 *
 * @throws ConfigError if git is not installed: workers need git worktrees.
 */
export async function createDemoProject(): Promise<DemoProject> {
  await execFileAsync('git', ['--version'], { windowsHide: true }).catch(() => {
    throw new ConfigError(
      'The demo needs git (cats work on git branches). Install it from https://git-scm.com and run it again.',
    );
  });
  await sweepOldDemos();
  const projectPath = await mkdtemp(join(tmpdir(), DEMO_PREFIX));
  const worktreesDir = `${projectPath}-worktrees`;
  const git = (...args: string[]) =>
    execFileAsync('git', args, { cwd: projectPath, windowsHide: true });
  for (const [path, content] of Object.entries(FILES)) {
    await mkdir(join(projectPath, path, '..'), { recursive: true });
    await writeFile(join(projectPath, path), content);
  }
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.name', 'agentcats demo');
  await git('config', 'user.email', 'demo@agentcats.local');
  await git('config', 'core.autocrlf', 'false');
  await git('add', '.');
  await git('commit', '-q', '-m', 'A tiny shop');
  await mkdir(join(projectPath, '.agentcats'));
  await writeFile(
    join(projectPath, '.agentcats', 'agentcats.config.json'),
    `${JSON.stringify({ adapter: 'mock', worktreesDir }, null, 2)}\n`,
  );
  return {
    projectPath,
    remove: async () => {
      for (const dir of [projectPath, worktreesDir]) {
        await rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
      }
    },
  };
}

const DEMO_PREFIX = 'agentcats-demo-';

/**
 * Remove projects left by demos that were not stopped with Ctrl+C (a closed
 * terminal, a hard kill). One whose daemon still runs is another demo: kept.
 */
async function sweepOldDemos(): Promise<void> {
  const entries = await readdir(tmpdir()).catch(() => []);
  for (const name of entries) {
    if (!name.startsWith(DEMO_PREFIX) || name.endsWith('-worktrees')) continue;
    const projectPath = join(tmpdir(), name);
    if (await runningDaemon(projectPath)) continue;
    for (const dir of [projectPath, `${projectPath}-worktrees`]) {
      await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
    }
  }
}

/** Demo task titles that play something other than the happy path. */
const DEMO_SCENARIOS: readonly (readonly [RegExp, string])[] = [
  [/payment API docs/i, 'network'],
  [/migrate the old database/i, 'crash'],
];

/** The mock agent for the demo: realistic pacing, real files and commits in the worktrees. */
export function demoAdapter(): Adapter {
  return createMockAdapter({
    // Half speed: slow enough to follow each cat on a first look.
    timeScale: 2,
    realFiles: true,
    scenarioForTurn: (prompt) => DEMO_SCENARIOS.find(([pattern]) => pattern.test(prompt))?.[1],
  });
}

/**
 * Plays the demo against the running daemon, like a user would: a request
 * the lead splits between two workers, one result accepted, a task that
 * asks before reaching the network (the viewer answers it), and one that
 * fails. The viewer can join in at any time.
 */
export class DemoScript {
  readonly #abort = new AbortController();
  #done: Promise<void> = Promise.resolve();

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly log: (line: string) => void,
    private readonly pace = 1,
  ) {}

  start(): void {
    this.#done = this.#run().catch((error: unknown) => {
      if (!this.#abort.signal.aborted) this.log(`The demo script stopped: ${String(error)}`);
    });
  }

  async stop(): Promise<void> {
    this.#abort.abort();
    await this.#done;
  }

  async #run(): Promise<void> {
    await this.#wait(2_000);
    await this.#api('POST', '/api/chat', { text: 'Add a login endpoint and write tests for it.' });
    const [first] = await this.#until((tasks) => {
      const done = tasks.filter((t) => t.status === 'review');
      return done.length >= 2 ? done : null;
    });
    await this.#wait(3_000);
    if (first) {
      await this.#api('POST', `/api/tasks/${first.id}/review`, { decision: 'accept' });
    }
    await this.#wait(2_500);
    await this.#api('POST', '/api/tasks', {
      title: 'Read the payment API docs',
      description: 'Summarize the endpoints we need for checkout.',
    });
    await this.#wait(4_000);
    await this.#api('POST', '/api/tasks', {
      title: 'Migrate the old database',
      description: 'Move the orders table to the new schema.',
    });
  }

  async #until<T>(check: (tasks: Task[]) => T | null): Promise<T> {
    for (;;) {
      const snapshot = Snapshot.parse(await this.#api('GET', '/api/snapshot'));
      const value = check(Object.values(snapshot.board.tasks));
      if (value) return value;
      await this.#wait(1_000);
    }
  }

  #wait(ms: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const signal = this.#abort.signal;
      if (signal.aborted) {
        reject(new Error('stopped'));
        return;
      }
      const timer = setTimeout(resolve, ms * this.pace);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new Error('stopped'));
        },
        { once: true },
      );
    });
  }

  async #api(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`${this.url}${path}`, {
      method,
      signal: this.#abort.signal,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path}: ${String(res.status)} ${text}`);
    return text ? (JSON.parse(text) as unknown) : null;
  }
}
