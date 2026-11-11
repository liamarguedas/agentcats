import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { PackageManager, ProjectCommands } from '@agentcats/protocol';

const LOCKFILES: readonly [string, PackageManager][] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
];

/**
 * The project's `package.json` scripts and package manager, for the level
 * gates. The `packageManager` field wins, then the lockfile, then npm. No
 * `package.json` means no scripts and no package manager.
 */
export async function readProjectCommands(dir: string): Promise<ProjectCommands> {
  let json: { scripts?: unknown; packageManager?: unknown };
  try {
    json = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as typeof json;
  } catch {
    return { packageManager: null, scripts: {} };
  }
  const scripts =
    typeof json.scripts === 'object' && json.scripts !== null
      ? Object.fromEntries(
          Object.entries(json.scripts).filter(
            (e): e is [string, string] => typeof e[1] === 'string',
          ),
        )
      : {};
  const declared =
    typeof json.packageManager === 'string'
      ? /^(npm|pnpm|yarn|bun)@/.exec(json.packageManager)
      : null;
  if (declared?.[1]) return { packageManager: declared[1] as PackageManager, scripts };
  for (const [file, manager] of LOCKFILES) {
    if (
      await stat(join(dir, file)).then(
        () => true,
        () => false,
      )
    ) {
      return { packageManager: manager, scripts };
    }
  }
  return { packageManager: 'npm', scripts };
}
