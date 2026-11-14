import { type ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const isWindows = process.platform === 'win32';

/** Absolute path of the guardian script, valid from both `src/` and `dist/`. */
export const GUARDIAN_PATH = fileURLToPath(new URL('../bin/guardian.mjs', import.meta.url));

export interface GuardedSpawnOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Process whose death kills the agent. Defaults to the current process. */
  readonly ownerPid?: number;
}

/**
 * Spawn an agent process under the guardian (see `bin/guardian.mjs`), so the
 * agent dies within about a second of its owner dying, however the owner dies.
 *
 * The returned child is the guardian. Its stdin, stdout and stderr are pipes
 * connected straight to the agent. Kill it with {@link killProcessTree}, not
 * `child.kill()`, which on Windows would only stop the guardian.
 */
export function spawnGuarded(
  command: string,
  args: readonly string[],
  options: GuardedSpawnOptions = {},
): ChildProcessWithoutNullStreams {
  const ownerPid = options.ownerPid ?? process.pid;
  return spawn(process.execPath, [GUARDIAN_PATH, String(ownerPid), command, ...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    // POSIX: make the guardian a process group leader so a group kill reaches the agent.
    detached: !isWindows,
    windowsHide: true,
  });
}

/** Whether a process with this id exists. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Kill a process and all its descendants, then wait until the root is gone.
 * Does nothing if the process does not exist.
 *
 * @param timeoutMs How long to wait for the root process to disappear.
 * @throws Error if the process is still alive after `timeoutMs`.
 */
export async function killProcessTree(pid: number, timeoutMs = 5_000): Promise<void> {
  if (!isProcessAlive(pid)) return;
  if (isWindows) {
    // Exit code 128 means "not found", which is fine: it already exited.
    await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      timeout: timeoutMs,
      windowsHide: true,
    }).catch(() => undefined);
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  }
  const deadline = Date.now() + timeoutMs;
  while (isProcessAlive(pid)) {
    if (Date.now() > deadline) throw new Error(`Process ${pid} survived kill`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Start time of a running process in epoch milliseconds, or `null` if it does
 * not exist or cannot be inspected. Used to make sure a recorded PID still
 * belongs to the process we started before killing it, since PIDs get reused.
 * Resolution is one second on POSIX.
 */
export async function processStartTime(pid: number): Promise<number | null> {
  if (isWindows) {
    // A cold PowerShell can stall on a busy machine (seen on CI): time out and
    // try once more, warm, rather than hang the daemon's startup.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { stdout } = await execFileAsync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `(Get-Process -Id ${String(pid)} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
          ],
          { timeout: START_TIME_TIMEOUT_MS, windowsHide: true },
        );
        const ms = Date.parse(stdout.trim());
        return Number.isNaN(ms) ? null : ms;
      } catch (error) {
        // Only a timeout is worth a retry; an error means no such process.
        if (!(error as { killed?: boolean }).killed) return null;
      }
    }
    return null;
  }
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
      timeout: START_TIME_TIMEOUT_MS,
    });
    const ms = Date.parse(`${stdout.trim()} UTC`);
    return Number.isNaN(ms) ? null : ms;
  } catch {
    return null;
  }
}

const START_TIME_TIMEOUT_MS = 10_000;
