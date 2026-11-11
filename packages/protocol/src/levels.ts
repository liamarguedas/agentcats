/**
 * Levels: the XP curve and everything a level changes. Every gating rule is
 * in this file so it can be audited in one place.
 *
 * A level changes two things, nothing more:
 *
 * 1. **Memory loaded:** how many learnings go into the worker's prompt
 *    ({@link selectLearnings}).
 * 2. **Autonomy:** which low-risk commands and reads run without an approval
 *    prompt ({@link autonomyFor}).
 *
 * Whatever the level, a command that reaches the network, installs packages
 * or destroys work always asks ({@link alwaysAskReason}), and `git push` is
 * always refused ({@link isPush}). Adapters check those before any allow rule.
 */

export interface LevelSpec {
  readonly level: number;
  /** XP needed to reach this level. */
  readonly minXp: number;
  /** Learnings loaded into the prompt; `null` loads the whole file. */
  readonly memoryTopK: number | null;
  /** The project's own `package.json` scripts run without asking. */
  readonly projectScripts: boolean;
  /** Local test, lint, format and typecheck tools run directly without asking. */
  readonly devTools: boolean;
  /** Reading the project's main checkout (outside the worktree) needs no approval. */
  readonly readMainCheckout: boolean;
}

export const LEVELS: readonly LevelSpec[] = [
  {
    level: 1,
    minXp: 0,
    memoryTopK: 5,
    projectScripts: false,
    devTools: false,
    readMainCheckout: false,
  },
  {
    level: 2,
    minXp: 30,
    memoryTopK: 10,
    projectScripts: false,
    devTools: false,
    readMainCheckout: false,
  },
  {
    level: 3,
    minXp: 80,
    memoryTopK: null,
    projectScripts: true,
    devTools: false,
    readMainCheckout: false,
  },
  {
    level: 4,
    minXp: 150,
    memoryTopK: null,
    projectScripts: true,
    devTools: true,
    readMainCheckout: true,
  },
];

export const MAX_LEVEL = LEVELS.length;

/** The level for an XP total. Levels follow XP both ways: losing XP can lose a level. */
export function levelForXp(xp: number): number {
  let level = 1;
  for (const spec of LEVELS) if (xp >= spec.minXp) level = spec.level;
  return level;
}

export function levelSpec(level: number): LevelSpec {
  const clamped = Math.min(Math.max(Math.trunc(level), 1), MAX_LEVEL);
  return LEVELS[clamped - 1] as LevelSpec;
}

/** Progress inside the current level, for the XP bar. `next` is `null` at the top. */
export function levelProgress(xp: number): {
  level: number;
  current: number;
  next: number | null;
} {
  const level = levelForXp(xp);
  const next = LEVELS[level]?.minXp ?? null;
  return { level, current: levelSpec(level).minXp, next };
}

// ---------------------------------------------------------------------------
// Commands that are never auto-approved
// ---------------------------------------------------------------------------

/** `git`, any global options (`-C dir`, `-c key=value`, `--no-pager`), then `push`. */
const PUSH = /\bgit(\s+-[Cc]\s+\S+|\s+--?[\w-]+(=\S+)?)*\s+push\b/i;

const NETWORK = new RegExp(
  [
    String.raw`\b(curl|wget|ssh|scp|sftp|rsync|nc|ncat|telnet|ftp)\b`,
    String.raw`\b(Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b`,
    String.raw`\bgit\s+(clone|fetch|pull|ls-remote|submodule\s+update)\b`,
  ].join('|'),
  'i',
);

const INSTALL = new RegExp(
  [
    String.raw`\b(npm|pnpm|yarn|bun)\s+(i|install|add|ci|update|upgrade|dlx|create)\b`,
    String.raw`\b(npx|pnpx|bunx)\b`,
    String.raw`\bnpm\s+exec\b`,
    String.raw`\bpip3?\s+(install|download)\b`,
    String.raw`\b(uv|poetry)\s+(add|sync|install|pip\s+install)\b`,
    String.raw`\b(cargo|go)\s+(install|get|add|fetch)\b`,
  ].join('|'),
  'i',
);

const DESTRUCTIVE = new RegExp(
  [
    // rm with a recursive or force flag, in any order: rm -rf, rm -fr, rm -r, rm -f
    String.raw`\brm\s+(-[A-Za-z]*[rRf][A-Za-z]*|--recursive|--force)\b`,
    String.raw`\brmdir\s+/s\b`,
    String.raw`\bdel\s+(/[sqf]\b|.*\s/[sqf]\b)`,
    String.raw`\b(Remove-Item|rm|ri)\b[^\n;&|]*-Recurse\b`,
    String.raw`\bgit\s+reset\s+[^\n;&|]*--hard\b`,
    String.raw`\bgit\s+clean\b`,
    String.raw`\bgit\s+checkout\s+(--\s|\.(\s|$))`,
    String.raw`\bgit\s+restore\b`,
    String.raw`\bgit\s+branch\s+[^\n;&|]*-D\b`,
    String.raw`\bgit\s+stash\s+(drop|clear)\b`,
    String.raw`\bgit\s+(filter-branch|filter-repo|update-ref\s+-d|reflog\s+expire)\b`,
    String.raw`\bfind\b[^\n;&|]*\s-delete\b`,
    String.raw`\b(mkfs|shred|diskpart|shutdown|reboot)\b`,
    String.raw`\bdd\s+if=`,
    String.raw`\bformat\s+[A-Za-z]:`,
  ].join('|'),
);

/** `git push` in any form. Always refused: the user merges and pushes. */
export function isPush(command: string): boolean {
  return PUSH.test(command);
}

/**
 * Why a command must ask for approval at every level, or `null`. Checked
 * before any allow rule, so an allowed prefix like `npm test` cannot carry
 * `&& curl ...` through.
 */
export function alwaysAskReason(command: string): 'network' | 'install' | 'destructive' | null {
  if (NETWORK.test(command)) return 'network';
  if (INSTALL.test(command)) return 'install';
  if (DESTRUCTIVE.test(command)) return 'destructive';
  return null;
}

/** `npm test`, `npm run x`, `pnpm x`, `pnpm run x`, `yarn x`, `yarn run x`, `bun run x`. */
const SCRIPT_CALL =
  /^(?:npm\s+(?:run(?:-script)?\s+([\w:.-]+)|(test|start)\b)|pnpm\s+(?:run\s+)?([\w:.-]+)|yarn\s+(?:run\s+)?([\w:.-]+)|bun\s+run\s+([\w:.-]+))/;

/** Names of the package.json scripts a command line runs, in order. */
export function scriptsInvoked(command: string): string[] {
  const names: string[] = [];
  for (const part of command.split(/&&|\|\||[;|\n]/)) {
    const match = SCRIPT_CALL.exec(part.trim());
    // Exactly one alternative's group matched; the others are undefined.
    const name = match?.slice(1).find(Boolean);
    if (name) names.push(name);
  }
  return names;
}

/**
 * Why a command must ask because of what the scripts it runs do, following
 * scripts that call other scripts. An allowed `pnpm test` still asks when the
 * worktree's `test` script fetches, installs, deletes or pushes, since the
 * worker can edit `package.json` in its worktree.
 */
export function scriptRisk(
  command: string,
  scripts: Readonly<Record<string, string>>,
  depth = 0,
): { script: string; reason: 'network' | 'install' | 'destructive' | 'push' } | null {
  if (depth > 5) return null;
  for (const name of scriptsInvoked(command)) {
    const body = Object.hasOwn(scripts, name) ? scripts[name] : undefined;
    if (body === undefined) continue;
    if (isPush(body)) return { script: name, reason: 'push' };
    const reason = alwaysAskReason(body);
    if (reason) return { script: name, reason };
    const nested = scriptRisk(body, scripts, depth + 1);
    if (nested) return { script: name, reason: nested.reason };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Autonomy
// ---------------------------------------------------------------------------

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

/** What the daemon knows about the project when it builds a worker's policy. */
export interface ProjectCommands {
  /** From the lockfile; `null` when there is no `package.json`. */
  readonly packageManager: PackageManager | null;
  /** `package.json` scripts, name to command line. */
  readonly scripts: Readonly<Record<string, string>>;
}

/** Scripts that npm runs around installs and publishing; never auto-approved. */
const LIFECYCLE_SCRIPTS = new Set([
  'preinstall',
  'install',
  'postinstall',
  'prepare',
  'prepublish',
  'prepublishOnly',
  'prepack',
  'postpack',
  'publish',
  'postpublish',
  'preuninstall',
  'uninstall',
  'postuninstall',
]);

/**
 * Local tools that read the code and report, or format it in place. Ones
 * that can download on their own (`npx`, `npm exec`, `go test`, `cargo test`)
 * are left out on purpose.
 */
export const DEV_TOOLS: readonly string[] = [
  'tsc',
  'vitest',
  'jest',
  'mocha',
  'eslint',
  'prettier',
  'biome',
  'node --test',
  'pytest',
  'python -m pytest',
  'ruff',
  'mypy',
];

const SCRIPT_RUNNERS: Record<PackageManager, (name: string) => string[]> = {
  npm: (name) => (name === 'test' ? ['npm test', 'npm run test'] : [`npm run ${name}`]),
  pnpm: (name) => [`pnpm ${name}`, `pnpm run ${name}`],
  yarn: (name) => [`yarn ${name}`, `yarn run ${name}`],
  bun: (name) => [`bun run ${name}`],
};

/** Ways to call a local tool through the package manager without downloading it. */
const LOCAL_TOOL_RUNNERS: Record<PackageManager, (tool: string) => string[]> = {
  npm: () => [],
  pnpm: (tool) => [`pnpm exec ${tool}`],
  yarn: (tool) => [`yarn ${tool}`],
  bun: () => [],
};

/**
 * Commands a cat at this level runs without asking, on top of the commands
 * every worker gets. Matched as a prefix by the adapter. Scripts whose own
 * body reaches the network, installs or deletes are left out, so they still
 * ask.
 */
export function autonomousCommands(level: number, project: ProjectCommands): string[] {
  const spec = levelSpec(level);
  const pm = project.packageManager;
  const commands: string[] = [];
  if (spec.projectScripts && pm) {
    for (const [name, body] of Object.entries(project.scripts)) {
      if (LIFECYCLE_SCRIPTS.has(name) || !/^[\w:.-]+$/.test(name)) continue;
      if (alwaysAskReason(body) !== null || isPush(body)) continue;
      commands.push(...SCRIPT_RUNNERS[pm](name));
    }
  }
  if (spec.devTools) {
    for (const tool of DEV_TOOLS) {
      commands.push(tool, ...(pm ? LOCAL_TOOL_RUNNERS[pm](tool) : []));
    }
  }
  return [...new Set(commands)];
}

/** Paths a cat at this level reads without asking, besides its own worktree. */
export function readablePathsFor(level: number, mainCheckout: string): string[] {
  return levelSpec(level).readMainCheckout ? [mainCheckout] : [];
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

const STOPWORDS = new Set(
  'the and for with not that this from into when are was you your its all any can has have but use uses using than then them they will should must only also after before about there their what which while each every other more most some such very just like make makes made does did done how why where who'.split(
    ' ',
  ),
);

/** Lowercase words of three or more letters, without common stopwords. */
export function keywords(text: string): Set<string> {
  const words = text.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? [];
  return new Set(words.filter((w) => !STOPWORDS.has(w)));
}

/**
 * The learnings to put in a worker's prompt for one task.
 *
 * Rule: when the level's limit (`memoryTopK`) is lower than the number of
 * learnings, keep the ones that share the most keywords with the task's
 * title and description; ties go to the newer line (lower in the file). The
 * result keeps file order. Otherwise every learning is loaded.
 */
export function selectLearnings<T extends { readonly text: string }>(
  learnings: readonly T[],
  taskText: string,
  level: number,
): T[] {
  const k = levelSpec(level).memoryTopK;
  if (k === null || learnings.length <= k) return [...learnings];
  const wanted = keywords(taskText);
  const ranked = learnings
    .map((learning, index) => {
      let score = 0;
      for (const word of keywords(learning.text)) if (wanted.has(word)) score++;
      return { index, score };
    })
    .sort((a, b) => b.score - a.score || b.index - a.index)
    .slice(0, k)
    .map((r) => r.index)
    .sort((a, b) => a - b);
  return ranked.map((index) => learnings[index] as T);
}
