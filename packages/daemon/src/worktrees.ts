import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class GitError extends Error {
  override readonly name = 'GitError';
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', [...args], {
      cwd,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new GitError(`git ${args.join(' ')} failed${stderr ? `: ${stderr}` : ''}`);
  }
}

/** Lower-case, dash-separated, safe in a branch name. */
export function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'cat'
  );
}

/**
 * Check a project is a git repository with at least one commit.
 *
 * @throws GitError with a message for the user otherwise.
 */
export async function verifyProjectRepo(projectPath: string): Promise<void> {
  await new WorktreeManager(projectPath, '').verifyRepo();
}

/** Default worktree root, outside the repo: `~/.agentcats/worktrees/<project>-<hash>`. */
export function defaultWorktreesRoot(projectPath: string): string {
  const hash = createHash('sha256').update(resolve(projectPath)).digest('hex').slice(0, 8);
  return join(homedir(), '.agentcats', 'worktrees', `${slug(basename(projectPath))}-${hash}`);
}

export interface Worktree {
  readonly path: string;
  readonly branch: string;
  /** Commit the branch started from, for diff stats. */
  readonly baseCommit: string;
}

export interface DiffStat {
  readonly files: number;
  readonly insertions: number;
  readonly deletions: number;
}

/** Parse `git diff --shortstat` output. Empty output is no change. */
export function parseShortStat(text: string): DiffStat {
  const num = (pattern: RegExp) => Number(pattern.exec(text)?.[1] ?? 0);
  return {
    files: num(/(\d+) files? changed/),
    insertions: num(/(\d+) insertions?\(\+\)/),
    deletions: num(/(\d+) deletions?\(-\)/),
  };
}

/**
 * Git worktrees for worker tasks. Each task gets its own branch
 * `agentcats/<cat>/<task>` checked out in its own directory outside the repo,
 * so workers never touch the main checkout or each other.
 */
export class WorktreeManager {
  constructor(
    readonly repoPath: string,
    readonly root: string,
  ) {}

  /**
   * Check the project is a git repository with at least one commit.
   *
   * @throws GitError with a message for the user otherwise.
   */
  async verifyRepo(): Promise<void> {
    await git(this.repoPath, ['rev-parse', '--show-toplevel']).catch(() => {
      throw new GitError(`${this.repoPath} is not a git repository. Workers need git worktrees.`);
    });
    await git(this.repoPath, ['rev-parse', '--verify', 'HEAD']).catch(() => {
      throw new GitError(
        `${this.repoPath} has no commits yet. Make a first commit so workers can branch from it.`,
      );
    });
    await git(this.repoPath, ['worktree', 'prune']);
  }

  /** Branch name for a task. */
  branchFor(catName: string, taskId: string): string {
    return `agentcats/${slug(catName)}/${taskId.slice(0, 8)}`;
  }

  /**
   * Create (or reuse, on re-run) the worktree for a task, branching from the
   * main checkout's current HEAD.
   */
  async ensure(taskId: string, branch: string): Promise<Worktree> {
    const path = join(this.root, taskId);
    const exists = (await stat(path).catch(() => null))?.isDirectory() ?? false;
    if (exists) {
      const baseCommit = await this.#mergeBase(branch);
      return { path, branch, baseCommit };
    }
    await mkdir(this.root, { recursive: true });
    const branchExists = await git(this.repoPath, [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/${branch}`,
    ])
      .then(() => true)
      .catch(() => false);
    if (branchExists) {
      await git(this.repoPath, ['worktree', 'add', path, branch]);
    } else {
      await git(this.repoPath, ['worktree', 'add', '-b', branch, path, 'HEAD']);
    }
    return { path, branch, baseCommit: await this.#mergeBase(branch) };
  }

  /** Whether the worktree has uncommitted changes, including untracked files. */
  async isDirty(path: string): Promise<boolean> {
    return (await git(path, ['status', '--porcelain'])).length > 0;
  }

  /** What the branch changed since it left `baseCommit`. */
  async diffStat(branch: string, baseCommit: string): Promise<DiffStat> {
    return parseShortStat(
      await git(this.repoPath, ['diff', '--shortstat', `${baseCommit}...${branch}`]),
    );
  }

  /** Number of commits on the branch since `baseCommit`. */
  async commitCount(branch: string, baseCommit: string): Promise<number> {
    return Number(await git(this.repoPath, ['rev-list', '--count', `${baseCommit}..${branch}`]));
  }

  /**
   * Remove a worktree, keeping its branch. Refuses when there is uncommitted
   * work, so nothing is lost silently.
   *
   * @returns `false` if the worktree was kept because it is dirty.
   */
  async remove(path: string): Promise<boolean> {
    if (!(await stat(path).catch(() => null))) return true;
    if (await this.isDirty(path)) return false;
    await git(this.repoPath, ['worktree', 'remove', path]);
    return true;
  }

  /**
   * Remove a throwaway worktree even with uncommitted work, and delete its
   * branch unless `keepBranch`. For interview candidates only: their work
   * is not the user's.
   */
  async discard(path: string, branch: string, keepBranch = false): Promise<void> {
    if (await stat(path).catch(() => null)) {
      await git(this.repoPath, ['worktree', 'remove', '--force', path]);
    }
    await git(this.repoPath, ['worktree', 'prune']);
    if (!keepBranch) await git(this.repoPath, ['branch', '-D', branch]).catch(() => undefined);
  }

  async #mergeBase(branch: string): Promise<string> {
    return git(this.repoPath, ['merge-base', 'HEAD', branch]);
  }
}
