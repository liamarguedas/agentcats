import { execFile } from 'node:child_process';
import { cp, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import type { InterviewSample, Task } from '@agentcats/protocol';

const execFileAsync = promisify(execFile);

/** Bundled samples and the fixture repo, shipped with the daemon package. */
export const BUNDLED_DIR = fileURLToPath(new URL('../interviews/', import.meta.url));

/** A sample with everything needed to run and check it. */
export interface SampleSpec extends InterviewSample {
  /** What candidates are asked to do. */
  readonly task: string;
  /** Decides pass or fail; `null` means there is no check and the interview cannot run. */
  readonly check: string | null;
  readonly lint: string | null;
  readonly typecheck: string | null;
  /** Files copied over the repo before candidates start; `null` for none. */
  readonly setupDir: string | null;
  /** Files copied over each candidate's work before the checks; `null` for none. */
  readonly hiddenDir: string | null;
}

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * Parse a sample file: a `---` header of `key: value` lines (title, repo,
 * check, lint, typecheck), then the task text.
 *
 * @throws Error naming what is missing or wrong.
 */
export function parseSample(id: string, text: string, dir: string, source: 'bundled' | 'project') {
  const match = FRONT_MATTER.exec(text);
  if (!match) throw new Error(`${id}.md has no --- header`);
  const fields = new Map<string, string>();
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    const at = line.indexOf(':');
    if (at > 0) fields.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  const repo = fields.get('repo') ?? 'fixture';
  if (repo !== 'fixture' && repo !== 'project') {
    throw new Error(`${id}.md: repo must be "fixture" or "project", not "${repo}"`);
  }
  const task = (match[2] ?? '').trim();
  if (!task) throw new Error(`${id}.md has no task text`);
  const optional = (key: string) => fields.get(key) || null;
  return {
    id,
    title: (fields.get('title') || id).slice(0, 200),
    repo,
    source,
    task,
    check: optional('check'),
    lint: optional('lint'),
    typecheck: optional('typecheck'),
    setupDir: join(dir, id, 'setup'),
    hiddenDir: join(dir, id, 'hidden'),
  } satisfies SampleSpec;
}

async function loadDir(dir: string, source: 'bundled' | 'project'): Promise<SampleSpec[]> {
  const files = await readdir(dir).catch(() => [] as string[]);
  const samples: SampleSpec[] = [];
  for (const file of files.filter((f) => f.endsWith('.md') && f !== 'README.md').sort()) {
    const id = file.slice(0, -3);
    samples.push(parseSample(id, await readFile(join(dir, file), 'utf8'), dir, source));
  }
  return samples;
}

/**
 * Every sample an interview can use: the bundled ones, the project's own in
 * `.agentcats/interviews/`, and re-runs of the five most recent accepted
 * tasks, checked with `projectCheck`.
 */
export async function listSamples(
  projectInterviewsDir: string,
  recentTasks: readonly Task[],
  projectCheck: string | null,
): Promise<SampleSpec[]> {
  const reruns = recentTasks
    .filter((t) => t.status === 'done')
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 5)
    .map((t): SampleSpec => ({
      id: `task:${t.id}`,
      title: `Re-run: ${t.title}`.slice(0, 200),
      repo: 'project',
      source: 'task',
      task: [t.title, t.description].filter(Boolean).join('\n\n'),
      check: projectCheck,
      lint: null,
      typecheck: null,
      setupDir: null,
      hiddenDir: null,
    }));
  return [
    ...(await loadDir(BUNDLED_DIR, 'bundled')),
    ...(await loadDir(projectInterviewsDir, 'project')),
    ...reruns,
  ];
}

/** Copy a sample's extra files (setup or hidden) over a directory, if it has any. */
export async function overlay(from: string | null, to: string): Promise<void> {
  if (
    !from ||
    !(await stat(from).then(
      (s) => s.isDirectory(),
      () => false,
    ))
  )
    return;
  await cp(from, to, { recursive: true, force: true });
}

/**
 * A fresh git repository at `dir` with the fixture and the sample's setup
 * files, one commit. Returns that commit, the base for measuring the diff.
 */
export async function prepareFixtureRepo(sample: SampleSpec, dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  await cp(join(BUNDLED_DIR, 'fixture'), dir, { recursive: true });
  await overlay(sample.setupDir, dir);
  const git = (...args: string[]) =>
    execFileAsync('git', args, { cwd: dir, windowsHide: true }).then((r) => r.stdout.trim());
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.name', 'agentcats interview');
  await git('config', 'user.email', 'interview@agentcats.local');
  await git('config', 'core.autocrlf', 'false');
  await git('add', '-A');
  await git('commit', '-q', '-m', `interview: ${sample.title}`);
  return git('rev-parse', 'HEAD');
}

/** Everything changed since `base`, committed or not, as a diff stat. */
export async function workDiff(
  dir: string,
  base: string,
): Promise<{ files: number; insertions: number; deletions: number }> {
  const git = (...args: string[]) =>
    execFileAsync('git', args, { cwd: dir, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }).then(
      (r) => r.stdout,
    );
  await git('add', '-A');
  const numstat = await git('diff', '--cached', '--numstat', base);
  let files = 0;
  let insertions = 0;
  let deletions = 0;
  for (const line of numstat.split('\n').filter(Boolean)) {
    const [added, removed] = line.split('\t');
    files++;
    insertions += Number(added) || 0; // binary files show "-"
    deletions += Number(removed) || 0;
  }
  return { files, insertions, deletions };
}
