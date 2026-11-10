import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { isProcessAlive, killProcessTree, processStartTime } from '@agentcats/kit';
import { z } from 'zod';

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
    const leftovers = await this.#load();
    const killed: number[] = [];
    for (const record of leftovers) {
      if (!isProcessAlive(record.pid)) continue;
      const started = await processStartTime(record.pid);
      if (started === null || Math.abs(started - record.startedAt) > START_TIME_TOLERANCE_MS) {
        continue; // PID was reused by something else.
      }
      await killProcessTree(record.pid);
      killed.push(record.pid);
    }
    this.#records = [];
    await this.#save();
    return killed;
  }

  async #load(): Promise<PidRecord[]> {
    try {
      const parsed = PidFile.safeParse(JSON.parse(await readFile(this.file, 'utf8')));
      return parsed.success ? parsed.data.processes : [];
    } catch {
      return [];
    }
  }

  /** Writes are serialized and atomic (write to temp, then rename). */
  #save(): Promise<void> {
    const content = JSON.stringify({ version: 1, processes: this.#records }, null, 2);
    this.#writing = this.#writing.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const temp = `${this.file}.tmp`;
      await writeFile(temp, content);
      await rename(temp, this.file);
    });
    return this.#writing;
  }
}
