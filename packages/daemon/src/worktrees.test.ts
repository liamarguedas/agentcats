import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  defaultWorktreesRoot,
  GitError,
  parseShortStat,
  slug,
  WorktreeManager,
} from './worktrees.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

const run = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();

async function repoWithCommit(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'agentcats-repo-'));
  dirs.push(repo);
  run(repo, 'init', '-q', '-b', 'main');
  run(repo, 'config', 'user.email', 'test@example.com');
  run(repo, 'config', 'user.name', 'Test');
  await writeFile(join(repo, 'README.md'), '# repo\n');
  run(repo, 'add', '.');
  run(repo, 'commit', '-q', '-m', 'init');
  return repo;
}

async function manager(repo: string): Promise<WorktreeManager> {
  const root = await mkdtemp(join(tmpdir(), 'agentcats-wt-'));
  dirs.push(root);
  return new WorktreeManager(repo, root);
}

describe('WorktreeManager', () => {
  it('creates a branch in its own directory, outside the repo', async () => {
    const repo = await repoWithCommit();
    const wt = await manager(repo);
    const branch = wt.branchFor('Mochi', 'a1b2c3d4-rest-of-id');
    expect(branch).toBe('agentcats/mochi/a1b2c3d4');

    const tree = await wt.ensure('task-1', branch);
    expect(tree.path.startsWith(wt.root)).toBe(true);
    expect(run(tree.path, 'branch', '--show-current')).toBe(branch);
    expect(run(repo, 'branch', '--show-current')).toBe('main');
  });

  it('reports the diff stat and commit count of committed work', async () => {
    const repo = await repoWithCommit();
    const wt = await manager(repo);
    const tree = await wt.ensure('task-1', 'agentcats/mochi/task1');
    await writeFile(join(tree.path, 'login.ts'), 'export const login = () => true;\n');
    await writeFile(join(tree.path, 'README.md'), '# repo\nmore\n');
    run(tree.path, 'add', '.');
    run(
      tree.path,
      '-c',
      'user.email=w@example.com',
      '-c',
      'user.name=Worker',
      'commit',
      '-q',
      '-m',
      'login',
    );

    expect(await wt.diffStat(tree.branch, tree.baseCommit)).toEqual({
      files: 2,
      insertions: 2,
      deletions: 0,
    });
    expect(await wt.commitCount(tree.branch, tree.baseCommit)).toBe(1);
  });

  it('keeps a dirty worktree and removes a clean one, keeping the branch', async () => {
    const repo = await repoWithCommit();
    const wt = await manager(repo);
    const tree = await wt.ensure('task-1', 'agentcats/mochi/task1');
    await writeFile(join(tree.path, 'wip.ts'), 'unsaved work\n');

    expect(await wt.isDirty(tree.path)).toBe(true);
    expect(await wt.remove(tree.path)).toBe(false);
    expect(await stat(tree.path)).toBeTruthy();

    await rm(join(tree.path, 'wip.ts'));
    expect(await wt.remove(tree.path)).toBe(true);
    await expect(stat(tree.path)).rejects.toThrow();
    expect(run(repo, 'branch', '--list', 'agentcats/mochi/task1')).toContain(
      'agentcats/mochi/task1',
    );
  });

  it('reuses an existing branch on re-run after the worktree was removed', async () => {
    const repo = await repoWithCommit();
    const wt = await manager(repo);
    const first = await wt.ensure('task-1', 'agentcats/mochi/task1');
    await wt.remove(first.path);
    const again = await wt.ensure('task-1', 'agentcats/mochi/task1');
    expect(run(again.path, 'branch', '--show-current')).toBe('agentcats/mochi/task1');
  });

  it('explains a folder that is not a git repo, and a repo with no commits', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'agentcats-plain-'));
    dirs.push(plain);
    await expect((await manager(plain)).verifyRepo()).rejects.toThrow(/not a git repository/);

    const empty = await mkdtemp(join(tmpdir(), 'agentcats-empty-'));
    dirs.push(empty);
    run(empty, 'init', '-q');
    await expect((await manager(empty)).verifyRepo()).rejects.toThrow(GitError);
    await expect((await manager(empty)).verifyRepo()).rejects.toThrow(/no commits yet/);
  });
});

describe('helpers', () => {
  it('parses git shortstat output', () => {
    expect(parseShortStat(' 3 files changed, 120 insertions(+), 4 deletions(-)')).toEqual({
      files: 3,
      insertions: 120,
      deletions: 4,
    });
    expect(parseShortStat(' 1 file changed, 1 deletion(-)')).toEqual({
      files: 1,
      insertions: 0,
      deletions: 1,
    });
    expect(parseShortStat('')).toEqual({ files: 0, insertions: 0, deletions: 0 });
  });

  it('makes branch-safe slugs', () => {
    expect(slug('Mochi the Cat!')).toBe('mochi-the-cat');
    expect(slug('***')).toBe('cat');
  });

  it('puts default worktrees under the home directory, never inside the project', () => {
    const root = defaultWorktreesRoot('/work/my-app');
    expect(root).toContain('.agentcats');
    expect(root).toMatch(/my-app-[0-9a-f]{8}$/);
    expect(root.startsWith('/work/my-app')).toBe(false);
  });
});
