import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Codes Windows returns for a rename-over while another process has the target open. */
const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * Replace a file atomically: write a temp file beside it, then rename it
 * over the target. Readers see the old or the new content, never half.
 */
export async function writeFileAtomic(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await writeFile(temp, content);
  await renameWithRetry(temp, file);
}

/**
 * `rename`, retried while the target is held open by someone else: a reader,
 * an editor, or an antivirus scan of the freshly written file, which on
 * Windows can last seconds. Same approach as npm's graceful-fs, with a
 * shorter budget.
 */
export async function renameWithRetry(from: string, to: string, budgetMs = 10_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (!TRANSIENT.has(code) || Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, 10 * attempt)));
    }
  }
}
