import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';

import { type AgentcatsConfig, RUNTIME_DIR_NAME, TOKEN_FRAGMENT_KEY } from '@agentcats/protocol';
import type { Adapter } from '@agentcats/protocol/adapter';

import { CatManager } from './cat-manager.js';
import { Captioner, loadCaptions } from './captions.js';
import { ConfigError, loadConfig } from './config.js';
import { acquireDaemonLock, type DaemonLock } from './daemon-lock.js';
import { EventLog } from './event-log.js';
import { createHttpServer } from './http-server.js';
import { type Logger, silentLogger } from './logger.js';
import { MCP_PATH } from './mcp-server.js';
import { PidRegistry } from './pid-registry.js';
import { SettingsService } from './settings.js';
import { SqliteStore } from './store.js';
import { defaultWorktreesRoot, WorktreeManager } from './worktrees.js';

export interface DaemonOptions {
  /** Project the cats work on: a git repository with at least one commit. */
  readonly projectPath: string;
  /** The default adapter (`config.adapter`). */
  readonly adapter: Adapter;
  /** More adapters, for teams that mix agents. */
  readonly adapters?: readonly Adapter[];
  /** Already loaded config. Loaded from the project when omitted. */
  readonly config?: AgentcatsConfig;
  /** Built UI directory, or `null` for none. Default `null`. */
  readonly uiDir?: string | null;
  /** Fixed token, for tests. Random when omitted. */
  readonly token?: string;
  readonly logger?: Logger;
  /** agentcats version, recorded at the start of each session. Default `dev`. */
  readonly version?: string;
}

export interface RunningDaemon {
  /** Base URL, `http://127.0.0.1:<port>`. */
  readonly url: string;
  readonly port: number;
  readonly token: string;
  /** URL to open in the browser, with the token in the fragment. */
  readonly uiUrl: string;
  /** Kill agent sessions, close connections, stop listening, close the database. */
  close(): Promise<void>;
}

/**
 * Start the daemon: reap agents left by a previous run, restore the board
 * from `.agentcats/agentcats.db` (marking in-flight tasks `interrupted`), and
 * listen on 127.0.0.1.
 *
 * @throws ConfigError if the project config is invalid or the port is in use.
 * @throws GitError if the project is not a git repository with a commit.
 * @throws DaemonRunningError if another daemon runs for the project.
 */
export async function startDaemon(options: DaemonOptions): Promise<RunningDaemon> {
  const projectPath = resolve(options.projectPath);
  const logger = options.logger ?? silentLogger;
  const config = options.config ?? (await loadConfig(projectPath));
  const runtimeDir = join(projectPath, RUNTIME_DIR_NAME);

  const worktrees = new WorktreeManager(
    projectPath,
    config.worktreesDir ?? defaultWorktreesRoot(projectPath),
  );
  await worktrees.verifyRepo();
  const lock = await acquireDaemonLock(projectPath);
  try {
    return await startLocked(options, { projectPath, logger, config, runtimeDir, worktrees, lock });
  } catch (error) {
    await lock.release();
    throw error;
  }
}

async function startLocked(
  options: DaemonOptions,
  ctx: {
    projectPath: string;
    logger: Logger;
    config: AgentcatsConfig;
    runtimeDir: string;
    worktrees: WorktreeManager;
    lock: DaemonLock;
  },
): Promise<RunningDaemon> {
  const { projectPath, logger, config, runtimeDir, worktrees, lock } = ctx;
  const pids = new PidRegistry(join(runtimeDir, 'run', 'pids.json'));
  const reaped = await pids.reapOrphans();
  if (reaped.length > 0) {
    logger.warn(`Killed ${String(reaped.length)} agent process(es) left by a previous run`);
  }

  const store = new SqliteStore(join(runtimeDir, 'agentcats.db'));
  const log = new EventLog(store);
  log.append({ type: 'daemon.started', payload: { version: options.version ?? 'dev' } });
  // Always loaded: Settings can turn captions on while running.
  const { templates, problem } = await loadCaptions(projectPath);
  if (problem && config.captions.enabled) {
    log.append({
      type: 'notice',
      payload: { level: 'warning', code: 'captions_invalid', message: problem.slice(0, 500) },
    });
  }
  const captioner = new Captioner(log, templates, Math.random, () => config.captions.enabled);
  let mcpUrl = '';
  const manager = new CatManager({
    log,
    store,
    adapters: new Map([options.adapter, ...(options.adapters ?? [])].map((a) => [a.id, a])),
    defaultAdapter: options.adapter.id,
    config,
    projectPath,
    pids,
    logger,
    worktrees,
    mcpUrl: () => mcpUrl,
  });
  try {
    await manager.start();
  } catch (error) {
    captioner.stop();
    await manager.close();
    store.close();
    throw error;
  }

  const token = options.token ?? randomBytes(32).toString('base64url');
  const { server, closeSockets } = createHttpServer({
    log,
    manager,
    token,
    uiDir: options.uiDir ?? null,
    logger,
    projectPath,
    globalBudgetUsd: () => config.budget.globalUsd,
    settings: new SettingsService({ projectPath, config, manager, log }),
  });
  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(config.port, '127.0.0.1', () => {
        server.off('error', rejectListen);
        resolveListen();
      });
    });
  } catch (error) {
    captioner.stop();
    await manager.close();
    store.close();
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw new ConfigError(
        `Port ${String(config.port)} is in use. Pick another with --port, or set "port": 0 in the config for any free port.`,
      );
    }
    throw error;
  }
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  const url = `http://127.0.0.1:${String(port)}`;
  mcpUrl = `${url}${MCP_PATH}`;
  await lock.setUrl(url).catch((error: unknown) => {
    logger.warn(`Could not record the daemon URL: ${String(error)}`);
  });

  let closing: Promise<void> | null = null;
  return {
    url,
    port,
    token,
    uiUrl: `${url}/#${TOKEN_FRAGMENT_KEY}=${token}`,
    close: () =>
      (closing ??= (async () => {
        await manager.close();
        // Sessions that just ended may still be writing the PID file.
        await pids.settled();
        captioner.stop();
        closeSockets();
        await new Promise<void>((done) => {
          server.close(() => {
            done();
          });
        });
        store.close();
        await lock.release();
      })()),
  };
}
