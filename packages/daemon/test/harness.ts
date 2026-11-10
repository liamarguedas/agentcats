import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMockAdapter, type MockAdapterOptions } from '@agentcats/adapter-mock';
import {
  AgentcatsConfig,
  type AgentcatsConfigInput,
  type AgentcatsEvent,
  WS_PATH,
  wsProtocols,
} from '@agentcats/protocol';
import WebSocket from 'ws';

import { type RunningDaemon, startDaemon } from '../src/index.js';

/** A fresh temp directory. */
export async function tempDir(prefix = 'agentcats-test-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/** A fresh temp git repository with one commit, as the daemon requires. */
export async function tempProject(): Promise<string> {
  const repo = await tempDir();
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'core.autocrlf', 'false');
  git('config', 'user.email', 'test@agentcats.local');
  git('config', 'user.name', 'agentcats test');
  await writeFile(join(repo, 'README.md'), '# test project\n');
  await writeFile(join(repo, '.gitignore'), '.agentcats/\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  return repo;
}

/** Run git in a directory and return its trimmed output. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
}

export interface TestDaemon {
  readonly daemon: RunningDaemon;
  readonly projectPath: string;
  readonly worktreesDir: string;
  /** Authenticated JSON request with the daemon's own Origin. */
  api(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }>;
  close(): Promise<void>;
}

/**
 * Start a daemon on a fresh temp repo with the mock adapter at full speed.
 * Mock workers write and commit for real, in worktrees under a temp dir.
 */
export async function startTestDaemon(
  mock: MockAdapterOptions = {},
  config: AgentcatsConfigInput = {},
  uiDir: string | null = null,
): Promise<TestDaemon> {
  const projectPath = await tempProject();
  const worktreesDir = await tempDir('agentcats-wt-');
  const daemon = await startDaemon({
    projectPath,
    adapter: createMockAdapter({ timeScale: 0, realFiles: true, ...mock }),
    config: AgentcatsConfig.parse({ adapter: 'mock', worktreesDir, ...config }),
    uiDir,
  });
  return {
    daemon,
    projectPath,
    worktreesDir,
    api: async (method, path, body) => {
      const res = await fetch(`${daemon.url}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${daemon.token}`,
          Origin: daemon.url,
          ...(body !== undefined && { 'Content-Type': 'application/json' }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      return { status: res.status, body: text ? (JSON.parse(text) as unknown) : null };
    },
    close: async () => {
      await daemon.close();
      await rm(projectPath, { recursive: true, force: true, maxRetries: 5 });
      await rm(worktreesDir, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}

/** Raw HTTP request where every header, including Host, is under test control. */
export function rawRequest(
  url: string,
  options: { method?: string; path: string; headers?: Record<string, string>; body?: string },
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}> {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname,
        port,
        path: options.path,
        method: options.method ?? 'GET',
        headers: options.headers,
        setHost: !options.headers?.['Host'],
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
        });
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

export interface EventStream {
  readonly socket: WebSocket;
  readonly events: AgentcatsEvent[];
  /** Resolve with the first event (seen or future) that matches. */
  waitFor<E extends AgentcatsEvent = AgentcatsEvent>(
    match: (event: AgentcatsEvent) => boolean,
    timeoutMs?: number,
  ): Promise<E>;
  close(): void;
}

/** Open the event WebSocket the way the UI does. */
export function connectEvents(
  daemon: RunningDaemon,
  options: { token?: string; origin?: string | null } = {},
): Promise<EventStream> {
  const token = options.token ?? daemon.token;
  const origin = options.origin === undefined ? daemon.url : options.origin;
  const socket = new WebSocket(`ws://127.0.0.1:${daemon.port}${WS_PATH}`, wsProtocols(token), {
    ...(origin !== null && { origin }),
  });
  const events: AgentcatsEvent[] = [];
  const waiters: { match: (e: AgentcatsEvent) => boolean; resolve: (e: AgentcatsEvent) => void }[] =
    [];
  socket.on('message', (data: Buffer) => {
    const event = JSON.parse(data.toString('utf8')) as AgentcatsEvent;
    events.push(event);
    for (const waiter of waiters.filter((w) => w.match(event))) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(event);
    }
  });
  const stream: EventStream = {
    socket,
    events,
    waitFor: <E extends AgentcatsEvent>(
      match: (event: AgentcatsEvent) => boolean,
      timeoutMs = 5_000,
    ) => {
      const seen = events.find(match);
      if (seen) return Promise.resolve(seen as E);
      return new Promise<E>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error(`Timed out waiting for event; saw ${events.map((e) => e.type).join(', ')}`),
          );
        }, timeoutMs);
        waiters.push({
          match,
          resolve: (e) => {
            clearTimeout(timer);
            resolve(e as E);
          },
        });
      });
    },
    close: () => {
      socket.close();
    },
  };
  return new Promise((resolve, reject) => {
    socket.once('open', () => {
      resolve(stream);
    });
    socket.once('unexpected-response', (_req, res) => {
      reject(new Error(`HTTP ${String(res.statusCode)}`));
    });
    socket.once('error', reject);
  });
}

/** Narrowing helper for `waitFor`. */
export const isType =
  <T extends AgentcatsEvent['type']>(
    type: T,
    extra: (e: Extract<AgentcatsEvent, { type: T }>) => boolean = () => true,
  ) =>
  (event: AgentcatsEvent): boolean =>
    event.type === type && extra(event as Extract<AgentcatsEvent, { type: T }>);
