import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { delimiter, dirname, extname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const isWindows = process.platform === 'win32';

/**
 * Claude Code versions this adapter has been run against end to end. Other
 * versions still run, with a warning on the board.
 */
export const TESTED_CLAUDE_VERSIONS: readonly string[] = ['2.1.302'];

async function isFile(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isFile() ?? false;
}

/**
 * npm installs `claude.cmd` on Windows, which cannot be spawned without a
 * shell. Follow the shim to the file it runs.
 */
async function followCmdShim(cmdPath: string): Promise<string | null> {
  const text = await readFile(cmdPath, 'utf8').catch(() => '');
  const target = /"%~?dp0%?\\([^"]+\.(?:exe|js|cjs|mjs))"/i.exec(text)?.[1];
  if (!target) return null;
  const full = join(dirname(cmdPath), target);
  return (await isFile(full)) ? full : null;
}

/**
 * Find the `claude` executable: the configured path, or `claude` on PATH.
 *
 * @returns Absolute path, or `null` if it cannot be found.
 */
export async function resolveClaudeExecutable(
  configured: string | null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  if (configured) {
    const full = resolve(configured);
    if (!(await isFile(full))) return null;
    return isWindows && extname(full).toLowerCase() === '.cmd' ? followCmdShim(full) : full;
  }
  const dirs = (env['PATH'] ?? env['Path'] ?? '').split(delimiter).filter(Boolean);
  const names = isWindows ? ['claude.exe', 'claude.cmd'] : ['claude'];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (!(await isFile(candidate))) continue;
      if (name.endsWith('.cmd')) {
        const target = await followCmdShim(candidate);
        if (target) return target;
        continue;
      }
      return candidate;
    }
  }
  return null;
}

/**
 * Version reported by `claude --version`, e.g. `2.1.302`, or `null` if the
 * output does not contain one.
 */
export async function claudeVersion(executable: string): Promise<string | null> {
  const isScript = /\.(?:c|m)?js$/i.test(executable);
  const { stdout } = await execFileAsync(
    isScript ? process.execPath : executable,
    isScript ? [executable, '--version'] : ['--version'],
    { timeout: 15_000, windowsHide: true },
  );
  return /\d+\.\d+\.\d+/.exec(stdout)?.[0] ?? null;
}

export interface ClaudeAuth {
  readonly loggedIn: boolean;
  /** How, e.g. `claude.ai` (a plan) or `api_key`. */
  readonly authMethod: string;
}

/**
 * `claude auth status`, which prints JSON and exits 1 when logged out. Free:
 * it starts no session.
 *
 * @returns `null` if the output is not that JSON (an older CLI without the
 *   command), so the caller cannot tell.
 */
export async function claudeAuthStatus(executable: string): Promise<ClaudeAuth | null> {
  const isScript = /\.(?:c|m)?js$/i.test(executable);
  const stdout = await execFileAsync(
    isScript ? process.execPath : executable,
    isScript ? [executable, 'auth', 'status'] : ['auth', 'status'],
    { timeout: 15_000, windowsHide: true },
  ).then(
    (r) => r.stdout,
    (error: unknown) => (error as { stdout?: string }).stdout ?? '',
  );
  try {
    const json = JSON.parse(stdout) as Partial<ClaudeAuth>;
    if (typeof json.loggedIn !== 'boolean') return null;
    return {
      loggedIn: json.loggedIn,
      authMethod: typeof json.authMethod === 'string' ? json.authMethod : 'unknown',
    };
  } catch {
    return null;
  }
}
