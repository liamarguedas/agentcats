import { readFile } from 'node:fs/promises';

import { isProcessAlive, killProcessTree, processStartTime } from '@agentcats/kit';
import { z } from 'zod';

import { writeFileAtomic } from './fs-util.js';

const PidRecord = z.object({
  pid: z.int().positive(),
  /** When we recorded it, epoch ms. Checked against the OS start time before killing. */
  startedAt: z.int().nonnegative(),
  catId: z.string(),
});
type PidRecord = z.infer<typeof PidRecord>;

const PidFile = z.object({ version: z.literal(1), processes: z.array(PidRecord) });

/**
 * A recorded PID is only treated as ours if the OS says the process started
 * within this window of when we recorded it. Protects unrelated processes
 * that reused the PID after a reboot or a long time.
 */
const START_TIME_TOLERANCE_MS = 10_000;

/**
 * Agent PIDs on disk (`.agentcats/run/pids.json`), so a daemon that died
 * without cleanup can kill its leftovers on the next start. The guardian
 * already kills agents when the daemon dies; this is the second line of
 * defense, for example if the guardian itself was killed.
 */
export class PidRegistry {
  #records: PidRecord[] = [];
  #writing: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  async add(pid: number, catId: string): Promise<void> {
    this.#records.push({ pid, startedAt: Date.now(), catId });
    await this.#save();
  }

  async remove(pid: number): Promise<void> {
    this.#records = this.#records.filter((r) => r.pid !== pid);
    await this.#save();
  }

  /**
   * Kill every process left in the file by a previous daemon, after checking
   * it is still the process we started. Then start a fresh file.
   *
   * @returns PIDs that were killed.
   */
  async reapOrphans(): Promise<number[]> {
    const killed = await this.orphans();
    for (const pid of killed) await killProcessTree(pid);
    this.#records = [];
    await this.#save();
    return killed;
  }

  /**
   * PIDs in the file that are still running and still the processes we
   * started. Changes nothing; only meaningful while no daemon runs.
   */
  async orphans(): Promise<number[]> {
    // In parallel: on Windows each check starts a PowerShell.
    const checks = await Promise.all(
      (await this.#load()).map(async (record) => {
        if (!isProcessAlive(record.pid)) return null;
        const started = await processStartTime(record.pid);
        // A start time far from ours means the PID was reused by something else.
        if (started === null || Math.abs(started - record.startedAt) > START_TIME_TOLERANCE_MS) {
          return null;
        }
        return record.pid;
      }),
    );
    return checks.filter((pid): pid is number => pid !== null);
  }

  async #load(): Promise<PidRecord[]> {
    try {
      const parsed = PidFile.safeParse(JSON.parse(await readFile(this.file, 'utf8')));
      return parsed.success ? parsed.data.processes : [];
    } catch {
      return [];
    }
  }

  /** Resolves once every write started so far is done, failed or not. */
  async settled(): Promise<void> {
    await this.#writing.catch(() => undefined);
  }

  /**
   * Writes are serialized and atomic (write to temp, then rename). A failed
   * write is reported to its caller but never blocks the writes after it.
   */
  #save(): Promise<void> {
    const content = JSON.stringify({ version: 1, processes: this.#records }, null, 2);
    const write = this.#writing
      .catch(() => undefined)
      .then(() => writeFileAtomic(this.file, content));
    this.#writing = write;
    return write;
  }
}
