import { readdir, rm, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

import {
  type AgentcatsConfig,
  applyEvent,
  type BoardState,
  emptyBoard,
  type InterviewStatus,
  RUNTIME_DIR_NAME,
  type TaskStatus,
} from '@agentcats/protocol';

import { type DaemonLockInfo, DaemonRunningError, runningDaemon } from './daemon-lock.js';
import { PidRegistry } from './pid-registry.js';
import { SqliteStore } from './store.js';
import { defaultWorktreesRoot, WorktreeManager } from './worktrees.js';

/** Tasks whose worktree is still in use: being worked on, or waiting for review. */
const OPEN_TASKS: readonly TaskStatus[] = ['queued', 'running', 'blocked', 'review'];
const OPEN_INTERVIEWS: readonly InterviewStatus[] = ['proposed', 'running', 'deciding'];

export interface LeftoverWorktree {
  readonly path: string;
  /** What it was for: `task <id> (failed)`, `interview <id>`, or `unknown`. */
  readonly owner: string;
  /** A task or interview that is over: `agentcats cleanup` removes it if clean. */
  readonly removable: boolean;
  /** Uncommitted changes: never removed, only reported. */
  readonly dirty: boolean;
}

export interface ProjectReport {
  readonly daemon: DaemonLockInfo | null;
  /** Agent processes left by a daemon that died. Empty while a daemon runs (they are its own). */
  readonly orphans: readonly number[];
  readonly worktreesRoot: string;
  readonly worktrees: readonly LeftoverWorktree[];
}

/**
 * What a project has lying around, for `agentcats doctor`. Changes nothing:
 * the database is only read, and only if it exists.
 */
export async function inspectProject(
  projectPath: string,
  config: AgentcatsConfig,
): Promise<ProjectReport> {
  const daemon = await runningDaemon(projectPath);
  const orphans = daemon ? [] : await pidRegistry(projectPath).orphans();
  const root = config.worktreesDir ?? defaultWorktreesRoot(projectPath);
  const board = await readBoard(projectPath);
  const worktrees = new WorktreeManager(projectPath, root);
  const found: LeftoverWorktree[] = [];
  for (const path of await candidateDirs(root)) {
    const { owner, removable } = classify(relative(root, path), board);
    const dirty = await worktrees.isDirty(path).catch(() => false);
    found.push({ path, owner, removable, dirty });
  }
  return { daemon, orphans, worktreesRoot: root, worktrees: found };
}

export interface CleanupResult {
  readonly killed: readonly number[];
  readonly removed: readonly string[];
  /** Worktrees left in place, with why. */
  readonly kept: readonly { readonly path: string; readonly reason: string }[];
}

/**
 * Kill agent processes left by a daemon that died, and remove the clean
 * worktrees of tasks and interviews that are over. Branches are kept, so a
 * failed task can still be re-run. Worktrees with uncommitted changes and
 * those of open tasks are kept.
 *
 * @throws DaemonRunningError while a daemon runs for the project: its agents
 *   and worktrees are in use.
 */
export async function cleanupProject(
  projectPath: string,
  config: AgentcatsConfig,
): Promise<CleanupResult> {
  const report = await inspectProject(projectPath, config);
  if (report.daemon) {
    throw new DaemonRunningError(
      `agentcats is running for this project (pid ${String(report.daemon.pid)}). Stop it before cleaning up.`,
    );
  }
  const killed = await pidRegistry(projectPath).reapOrphans();
  const worktrees = new WorktreeManager(projectPath, report.worktreesRoot);
  const removed: string[] = [];
  const kept: { path: string; reason: string }[] = [];
  for (const tree of report.worktrees) {
    if (!tree.removable) {
      kept.push({ path: tree.path, reason: `in use (${tree.owner})` });
    } else if (tree.dirty) {
      kept.push({ path: tree.path, reason: 'uncommitted changes' });
    } else if (await isGitWorktree(tree.path)) {
      if (await worktrees.remove(tree.path)) removed.push(tree.path);
      else kept.push({ path: tree.path, reason: 'uncommitted changes' });
    } else {
      // An interview's fixture repo: its own throwaway repository.
      await rm(tree.path, { recursive: true, force: true, maxRetries: 5 });
      removed.push(tree.path);
    }
  }
  await removeEmptyInterviewDirs(report.worktreesRoot);
  return { killed, removed, kept };
}

function pidRegistry(projectPath: string): PidRegistry {
  return new PidRegistry(join(projectPath, RUNTIME_DIR_NAME, 'run', 'pids.json'));
}

async function readBoard(projectPath: string): Promise<BoardState> {
  const file = join(projectPath, RUNTIME_DIR_NAME, 'agentcats.db');
  if (!(await stat(file).catch(() => null))) return emptyBoard();
  const store = new SqliteStore(file);
  try {
    return store.allEvents().reduce(applyEvent, emptyBoard());
  } finally {
    store.close();
  }
}

/** Task worktrees are `<root>/<taskId>` or `<root>/interview-…`; fixture repos `<root>/interviews/<id>/<cat>`. */
async function candidateDirs(root: string): Promise<string[]> {
  const dirs = async (dir: string) =>
    (await readdir(dir, { withFileTypes: true }).catch(() => []))
      .filter((d) => d.isDirectory())
      .map((d) => join(dir, d.name));
  const found: string[] = [];
  for (const dir of await dirs(root)) {
    if (relative(root, dir) !== 'interviews') {
      found.push(dir);
      continue;
    }
    for (const interview of await dirs(dir)) found.push(...(await dirs(interview)));
  }
  return found;
}

function classify(rel: string, board: BoardState): { owner: string; removable: boolean } {
  const parts = rel.split(sep);
  const interviewId =
    parts[0] === 'interviews' ? parts[1] : /^interview-([0-9a-f]{8})-/.exec(parts[0] ?? '')?.[1];
  if (interviewId !== undefined) {
    const interview = Object.values(board.interviews).find((i) => i.id.startsWith(interviewId));
    if (interview && OPEN_INTERVIEWS.includes(interview.status)) {
      return { owner: `interview ${interview.id} (${interview.status})`, removable: false };
    }
    return { owner: `interview ${interview?.id ?? interviewId}`, removable: true };
  }
  const task = board.tasks[parts[0] ?? ''];
  if (!task) return { owner: 'unknown', removable: false };
  return {
    owner: `task ${task.id} (${task.status})`,
    removable: !OPEN_TASKS.includes(task.status),
  };
}

async function isGitWorktree(path: string): Promise<boolean> {
  // A worktree has a `.git` file pointing at the main repository; a repository a `.git` directory.
  return (await stat(join(path, '.git')).catch(() => null))?.isFile() ?? false;
}

async function removeEmptyInterviewDirs(root: string): Promise<void> {
  const interviews = resolve(root, 'interviews');
  for (const entry of await readdir(interviews).catch(() => [])) {
    const dir = join(interviews, entry);
    if ((await readdir(dir).catch(() => ['x'])).length === 0) await rm(dir, { recursive: true });
  }
}
