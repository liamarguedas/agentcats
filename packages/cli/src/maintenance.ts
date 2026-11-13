import {
  cleanupProject,
  ConfigError,
  DaemonRunningError,
  GitError,
  inspectProject,
  loadConfig,
  verifyProjectRepo,
} from '@agentcats/daemon';
import { AgentcatsConfig } from '@agentcats/protocol';

import { nodeVersionProblem } from '../bin/check-node.mjs';
import type { CliIo } from './main.js';

/** Creates an adapter by id, as the run command does (passed in to avoid an import cycle). */
type AdapterFactory = (
  id: string,
  config: AgentcatsConfig,
  io: CliIo,
) => Promise<{ preflight?: () => Promise<{ ready: boolean; detail: string }> } | null>;

const OK = '✓';
const WARN = '!';
const FAIL = '✗';

/**
 * `agentcats doctor`: check everything a run needs, change nothing (except
 * git's own `worktree prune`), and say how to fix what is wrong.
 *
 * @returns Exit code: 1 if something would stop a run, else 0.
 */
export async function doctor(
  projectPath: string,
  io: CliIo,
  createAdapter: AdapterFactory,
): Promise<number> {
  const marks: string[] = [];
  const line = (mark: string, text: string) => {
    marks.push(mark);
    io.out(`${mark} ${text}`);
  };

  const nodeProblem = nodeVersionProblem(process.version);
  line(nodeProblem ? FAIL : OK, nodeProblem ?? `Node.js ${process.version}`);

  const repoOk = await verifyProjectRepo(projectPath).then(
    () => true,
    (error: unknown) => {
      line(FAIL, error instanceof GitError ? error.message : String(error));
      return false;
    },
  );
  if (repoOk) line(OK, `Git repository at ${projectPath}`);

  let config: AgentcatsConfig;
  try {
    config = await loadConfig(projectPath);
    line(OK, 'Config is valid');
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    line(FAIL, error.message);
    config = AgentcatsConfig.parse({});
  }

  for (const id of ['claude', 'codex'] as const) {
    const needed = [config.adapter, config.orchestrator.adapter, config.workers.adapter].includes(
      id,
    );
    const adapter = await createAdapter(id, config, { ...io, err: () => undefined });
    const readiness = (await adapter?.preflight?.()) ?? { ready: false, detail: `No ${id}` };
    if (readiness.ready) line(OK, readiness.detail);
    else line(needed ? FAIL : WARN, `${readiness.detail}${needed ? '' : ' (optional)'}`);
  }

  if (!repoOk) return 1; // nothing below works without a repository
  const report = await inspectProject(projectPath, config);
  line(
    OK,
    report.daemon
      ? `agentcats is running for this project (pid ${String(report.daemon.pid)}${report.daemon.url ? `, ${report.daemon.url}` : ''})`
      : 'agentcats is not running for this project',
  );
  if (report.orphans.length > 0) {
    line(
      WARN,
      `${String(report.orphans.length)} agent process(es) left by a run that died (pid ${report.orphans.join(', ')}). \`agentcats cleanup\` stops them.`,
    );
  }
  const removable = report.worktrees.filter((w) => w.removable && !w.dirty);
  const dirty = report.worktrees.filter((w) => w.dirty);
  const inUse = report.worktrees.filter((w) => !w.removable && !w.dirty);
  line(
    removable.length > 0 ? WARN : OK,
    `Worktrees in ${report.worktreesRoot}: ${String(inUse.length)} in use, ${String(removable.length)} left over${removable.length > 0 ? ' (`agentcats cleanup` removes them)' : ''}`,
  );
  for (const tree of dirty) {
    line(WARN, `Uncommitted changes in ${tree.path} (${tree.owner}); cleanup keeps it.`);
  }
  return marks.includes(FAIL) ? 1 : 0;
}

/**
 * `agentcats cleanup`: stop agent processes left by a run that died and
 * remove leftover worktrees. Refuses while agentcats runs for the project.
 *
 * @returns Exit code.
 */
export async function cleanup(projectPath: string, io: CliIo): Promise<number> {
  try {
    await verifyProjectRepo(projectPath);
    const config = await loadConfig(projectPath);
    const result = await cleanupProject(projectPath, config);
    io.out(
      result.killed.length > 0
        ? `Stopped ${String(result.killed.length)} leftover agent process(es): ${result.killed.join(', ')}`
        : 'No leftover agent processes.',
    );
    io.out(
      `Removed ${String(result.removed.length)} worktree(s); branches are kept, so failed tasks can still be re-run.`,
    );
    for (const path of result.removed) io.out(`  - ${path}`);
    for (const kept of result.kept) io.out(`Kept ${kept.path}: ${kept.reason}`);
    return 0;
  } catch (error) {
    if (
      error instanceof ConfigError ||
      error instanceof GitError ||
      error instanceof DaemonRunningError
    ) {
      io.err(error.message);
      return 1;
    }
    throw error;
  }
}
