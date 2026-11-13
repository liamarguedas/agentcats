import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { isProcessAlive, processStartTime } from '@agentcats/kit';
import { RUNTIME_DIR_NAME } from '@agentcats/protocol';
import { z } from 'zod';

import { writeFileAtomic } from './fs-util.js';

/** Thrown when another daemon already runs for the project. */
export class DaemonRunningError extends Error {
  override readonly name = 'DaemonRunningError';
}

const LockFile = z.object({
  pid: z.int().positive(),
  /** When the daemon process started, epoch ms. Checked against the OS so a reused PID is not mistaken for it. */
  startedAt: z.int().nonnegative(),
  /** Base URL once listening, `null` while starting. */
  url: z.string().nullable(),
});
export type DaemonLockInfo = z.infer<typeof LockFile>;

/** Same window as the PID registry: the OS start time must be this close to ours. */
const START_TIME_TOLERANCE_MS = 10_000;

export function lockPath(projectPath: string): string {
  return join(projectPath, RUNTIME_DIR_NAME, 'run', 'daemon.json');
}

/**
 * The daemon running for a project, or `null` if none is (no lock file, or a
 * stale one left by a daemon that died).
 */
export async function runningDaemon(projectPath: string): Promise<DaemonLockInfo | null> {
  return live(await read(lockPath(projectPath)));
}

/**
 * One daemon per project: a second one would kill the first one's agents as
 * orphans and write to the same database. Taken with an exclusive create, so
 * two daemons starting at once cannot both win. A stale lock is replaced.
 *
 * @throws DaemonRunningError if another live daemon holds the lock.
 */
export async function acquireDaemonLock(projectPath: string): Promise<DaemonLock> {
  const file = lockPath(projectPath);
  await mkdir(dirname(file), { recursive: true });
  // The process start, as the OS reports it, not now: startup can take seconds.
  const startedAt = Math.round(Date.now() - process.uptime() * 1000);
  const info: DaemonLockInfo = { pid: process.pid, startedAt, url: null };
  for (let attempt = 0; ; attempt++) {
    try {
      const handle = await open(file, 'wx');
      await handle.writeFile(JSON.stringify(info, null, 2));
      await handle.close();
      return new DaemonLock(file, info);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt > 0) throw error;
    }
    const holder = await live(await read(file));
    if (holder) {
      throw new DaemonRunningError(
        `agentcats is already running for this project (pid ${String(holder.pid)}${holder.url ? `, ${holder.url}` : ''}). Stop it first, or use its board.`,
      );
    }
    await rm(file, { force: true });
  }
}

export class DaemonLock {
  constructor(
    private readonly file: string,
    private info: DaemonLockInfo,
  ) {}

  /** Record the URL once the daemon listens, for `agentcats doctor` and the error above. */
  async setUrl(url: string): Promise<void> {
    this.info = { ...this.info, url };
    await writeFileAtomic(this.file, JSON.stringify(this.info, null, 2));
  }

  async release(): Promise<void> {
    await rm(this.file, { force: true });
  }
}

async function read(file: string): Promise<DaemonLockInfo | null> {
  try {
    const parsed = LockFile.safeParse(JSON.parse(await readFile(file, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function live(info: DaemonLockInfo | null): Promise<DaemonLockInfo | null> {
  if (!info || !isProcessAlive(info.pid)) return null;
  const started = await processStartTime(info.pid);
  if (started !== null && Math.abs(started - info.startedAt) > START_TIME_TOLERANCE_MS) return null;
  return info;
}
