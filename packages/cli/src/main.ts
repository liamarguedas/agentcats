import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import {
  claudeVersion,
  createClaudeAdapter,
  resolveClaudeExecutable,
  TESTED_CLAUDE_VERSIONS,
} from '@agentcats/adapter-claude';
import { createMockAdapter } from '@agentcats/adapter-mock';
import { ConfigError, consoleLogger, GitError, loadConfig, startDaemon } from '@agentcats/daemon';
import type { AgentcatsConfig } from '@agentcats/protocol';
import type { Adapter } from '@agentcats/protocol/adapter';

export const USAGE = `Usage: agentcats --project <path> [options]

Starts the agentcats daemon for a project and opens the board in your browser.

Options:
  -p, --project <path>         Project the cat works in (default: current directory)
      --adapter <claude|mock>  Override the adapter from agentcats.config.json
      --port <number>          Port on 127.0.0.1 (default: config, or a free port)
      --no-open                Print the board URL instead of opening a browser
  -h, --help                   Show this help
`;

export interface CliIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  /** Open a URL in the browser. */
  readonly open: (url: string) => void;
  /** Resolves when the user asks to stop (Ctrl+C). */
  readonly stopSignal: () => Promise<void>;
}

export interface ParsedArgs {
  readonly project: string;
  readonly adapter: AgentcatsConfig['adapter'] | null;
  readonly port: number | null;
  readonly open: boolean;
  readonly help: boolean;
}

export class UsageError extends Error {
  override readonly name = 'UsageError';
}

/**
 * Parse command-line arguments.
 *
 * @throws UsageError for unknown options or invalid values.
 */
export function parseCliArgs(argv: readonly string[], cwd = process.cwd()): ParsedArgs {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        project: { type: 'string', short: 'p' },
        adapter: { type: 'string' },
        port: { type: 'string' },
        open: { type: 'boolean', default: true },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowNegative: true,
      strict: true,
    }));
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const adapter = values.adapter ?? null;
  if (adapter !== null && adapter !== 'claude' && adapter !== 'mock') {
    throw new UsageError(`--adapter must be "claude" or "mock", got "${adapter}"`);
  }
  const port = values.port === undefined ? null : Number(values.port);
  if (port !== null && (!Number.isInteger(port) || port < 0 || port > 65_535)) {
    throw new UsageError(`--port must be an integer from 0 to 65535, got "${String(values.port)}"`);
  }
  return {
    project: resolve(cwd, values.project ?? '.'),
    adapter,
    port,
    open: values.open,
    help: values.help,
  };
}

/** Directory with the built UI, or `null` if it has not been built. */
export async function findUiDir(): Promise<string | null> {
  const uiPackage = createRequire(import.meta.url).resolve('@agentcats/ui/package.json');
  const dist = join(dirname(uiPackage), 'dist');
  return (await stat(join(dist, 'index.html')).catch(() => null)) ? dist : null;
}

async function createAdapter(config: AgentcatsConfig, io: CliIo): Promise<Adapter> {
  // On a real project the mock only animates; it never writes files or commits.
  if (config.adapter === 'mock') return createMockAdapter();
  const executable = await resolveClaudeExecutable(config.claude.executablePath);
  if (!executable) {
    throw new ConfigError(
      config.claude.executablePath
        ? `Claude Code not found at ${config.claude.executablePath}.`
        : 'Claude Code (`claude`) was not found on PATH. Install it, set claude.executablePath in .agentcats/agentcats.config.json, or run with --adapter mock.',
    );
  }
  const version = await claudeVersion(executable).catch(() => null);
  io.out(`Using Claude Code ${version ?? '(unknown version)'} at ${executable}`);
  if (version === null || !TESTED_CLAUDE_VERSIONS.includes(version)) {
    io.err(
      `Warning: this Claude Code version has not been tested with agentcats (tested: ${TESTED_CLAUDE_VERSIONS.join(', ')}).`,
    );
  }
  return createClaudeAdapter({ executablePath: executable });
}

/**
 * Run the CLI until the user stops it.
 *
 * @returns Process exit code.
 */
export async function main(argv: readonly string[], io: CliIo = defaultIo()): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseCliArgs(argv);
  } catch (error) {
    io.err(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    io.out(USAGE);
    return 0;
  }

  if (!(await stat(args.project).catch(() => null))?.isDirectory()) {
    io.err(`Project directory not found: ${args.project}`);
    return 1;
  }

  try {
    const loaded = await loadConfig(args.project);
    const config: AgentcatsConfig = {
      ...loaded,
      ...(args.adapter !== null && { adapter: args.adapter }),
      ...(args.port !== null && { port: args.port }),
    };
    const adapter = await createAdapter(config, io);
    const uiDir = await findUiDir();
    if (!uiDir) io.err('Warning: the UI is not built. Run `pnpm build` to get the board.');

    const daemon = await startDaemon({
      projectPath: args.project,
      adapter,
      config,
      uiDir,
      logger: consoleLogger,
    });
    io.out(`agentcats is running for ${args.project}`);
    io.out(`Board: ${daemon.uiUrl}`);
    io.out('Press Ctrl+C to stop.');
    if (args.open) io.open(daemon.uiUrl);

    await io.stopSignal();
    io.out('Stopping agentcats…');
    await daemon.close();
    return 0;
  } catch (error) {
    if (error instanceof ConfigError || error instanceof GitError) {
      io.err(error.message);
      return 1;
    }
    throw error;
  }
}

function defaultIo(): CliIo {
  return {
    out: (line) => {
      console.log(line);
    },
    err: (line) => {
      console.error(line);
    },
    open: openInBrowser,
    stopSignal: () =>
      new Promise((resolveStop) => {
        process.once('SIGINT', () => {
          resolveStop();
        });
        process.once('SIGTERM', () => {
          resolveStop();
        });
      }),
  };
}

/** Best effort; the URL is printed either way. */
function openInBrowser(url: string): void {
  const [command, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
  child.on('error', () => undefined);
  child.unref();
}
