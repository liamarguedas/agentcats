import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';

import { type AgentcatsConfig, RUNTIME_DIR_NAME, TOKEN_FRAGMENT_KEY } from '@agentcats/protocol';
import type { Adapter } from '@agentcats/protocol/adapter';

import { CatRunner } from './cat-runner.js';
import { loadConfig } from './config.js';
import { EventLog } from './event-log.js';
import { createHttpServer } from './http-server.js';
import { type Logger, silentLogger } from './logger.js';
import { PidRegistry } from './pid-registry.js';

export interface DaemonOptions {
  /** Project the cat works in. Its `.agentcats/` holds config and runtime files. */
  readonly projectPath: string;
  readonly adapter: Adapter;
  /** Already loaded config. Loaded from the project when omitted. */
  readonly config?: AgentcatsConfig;
  /** Built UI directory, or `null` for none. Default `null`. */
  readonly uiDir?: string | null;
  /** Fixed token, for tests. Random when omitted. */
  readonly token?: string;
  readonly logger?: Logger;
  /** Name of the M0 cat. */
  readonly catName?: string;
}

export interface RunningDaemon {
  /** Base URL, `http://127.0.0.1:<port>`. */
  readonly url: string;
  readonly port: number;
  readonly token: string;
  /** URL to open in the browser, with the token in the fragment. */
  readonly uiUrl: string;
  /** Kill agent sessions, close connections and stop listening. */
  close(): Promise<void>;
}

/**
 * Start the daemon: reap agents left by a previous run, create the cat, and
 * listen on 127.0.0.1.
 *
 * @throws ConfigError if the project config is invalid.
 */
export async function startDaemon(options: DaemonOptions): Promise<RunningDaemon> {
  const projectPath = resolve(options.projectPath);
  const logger = options.logger ?? silentLogger;
  const config = options.config ?? (await loadConfig(projectPath));

  const pids = new PidRegistry(join(projectPath, RUNTIME_DIR_NAME, 'run', 'pids.json'));
  const reaped = await pids.reapOrphans();
  if (reaped.length > 0) {
    logger.warn(`Killed ${reaped.length} agent process(es) left by a previous run`);
  }

  const log = new EventLog();
  const runner = new CatRunner({
    log,
    adapter: options.adapter,
    config,
    projectPath,
    pids,
    logger,
    name: options.catName ?? 'Mochi',
  });

  const token = options.token ?? randomBytes(32).toString('base64url');
  const { server, closeSockets } = createHttpServer({
    log,
    runner,
    token,
    uiDir: options.uiDir ?? null,
    logger,
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(config.port, '127.0.0.1', () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  const url = `http://127.0.0.1:${port}`;

  let closing: Promise<void> | null = null;
  return {
    url,
    port,
    token,
    uiUrl: `${url}/#${TOKEN_FRAGMENT_KEY}=${token}`,
    close: () =>
      (closing ??= (async () => {
        await runner.close();
        closeSockets();
        await new Promise<void>((done) =>
          server.close(() => {
            done();
          }),
        );
      })()),
  };
}
