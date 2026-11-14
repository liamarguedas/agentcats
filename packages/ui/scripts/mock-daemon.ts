// A daemon with the mock adapter, for UI development and the browser tests.
// No agent CLI, no API key, no tokens spent. The project is a throwaway git
// repo; mock workers really commit to their branches in throwaway worktrees.
//
// Env: AGENTCATS_PORT (default 4545), AGENTCATS_TOKEN (default random),
// AGENTCATS_TIME_SCALE (default 1), AGENTCATS_UI_DIR (default: serve no UI;
// set it to packages/ui/dist to serve the built UI), AGENTCATS_STATE_FILE
// (default none: where to note the temp folders, see below), AGENTCATS_MAX_WORKERS
// (default 3).
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { createMockAdapter } from '@agentcats/adapter-mock';
import { consoleLogger, startDaemon } from '@agentcats/daemon';
import { AgentcatsConfig } from '@agentcats/protocol';

const env = process.env;

// On Windows the browser test runner stops this process without a signal, so
// the cleanup below never runs. The state file names the temp folders: the
// next run deletes the previous run's, and the browser tests read files there.
const stateFile = env['AGENTCATS_STATE_FILE'];
if (stateFile) {
  let previous: { projectPath?: string; worktreesDir?: string } = {};
  try {
    previous = JSON.parse(await readFile(stateFile, 'utf8')) as typeof previous;
  } catch {
    // First run, or an unreadable file: nothing to clean up.
  }
  for (const dir of [previous.projectPath, previous.worktreesDir]) {
    if (dir?.includes('agentcats-mock-'))
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

const projectPath = await mkdtemp(join(tmpdir(), 'agentcats-mock-'));
const worktreesDir = await mkdtemp(join(tmpdir(), 'agentcats-mock-wt-'));
const git = (...args: string[]) => execFileSync('git', args, { cwd: projectPath, stdio: 'pipe' });
git('init', '-q', '-b', 'main');
await writeFile(join(projectPath, 'README.md'), '# mock project\n');
await writeFile(join(projectPath, '.gitignore'), '.agentcats/\n');
// A quick interview sample the mock candidates can pass: answer.txt must say 42.
const interviews = join(projectPath, '.agentcats', 'interviews');
await mkdir(join(interviews, 'answer', 'hidden'), { recursive: true });
await writeFile(
  join(interviews, 'answer.md'),
  '---\ntitle: Answer the question\nrepo: fixture\ncheck: node check.cjs\nlint: node scripts/lint.js\n---\n\nWrite the answer to answer.txt and commit it.\n',
);
await writeFile(
  join(interviews, 'answer', 'hidden', 'check.cjs'),
  "process.exit(require('node:fs').readFileSync('answer.txt', 'utf8').trim() === '42' ? 0 : 1);\n",
);
let candidates = 0;

function sandboxedMock() {
  const adapter = createMockAdapter({
    id: 'mock-nocost',
    reportsCost: false,
    timeScale: Number(env['AGENTCATS_TIME_SCALE'] ?? 1),
    realFiles: true,
  });
  return {
    ...adapter,
    capabilities: { ...adapter.capabilities, policyEnforcement: 'sandbox' as const },
  };
}
git('add', '.');
git(
  '-c',
  'user.name=agentcats',
  '-c',
  'user.email=mock@agentcats.local',
  'commit',
  '-q',
  '-m',
  'init',
);

if (stateFile) {
  await mkdir(dirname(stateFile), { recursive: true });
  await writeFile(stateFile, JSON.stringify({ projectPath, worktreesDir }));
}

const daemon = await startDaemon({
  projectPath,
  adapter: createMockAdapter({
    timeScale: Number(env['AGENTCATS_TIME_SCALE'] ?? 1),
    realFiles: true,
    // Interview candidates (their models are the tier names) take turns at
    // passing, passing with a big diff, and failing the "answer" sample.
    scenarioFor: (options) =>
      options.model?.startsWith('mock-')
        ? ['interview-pass', 'interview-verbose', 'interview-fail'][candidates++ % 3]
        : undefined,
  }),
  // A second agent that, like Codex, reports no cost and enforces its own
  // sandbox, so the board's time budget and sandbox warning can be seen.
  adapters: [sandboxedMock()],
  config: AgentcatsConfig.parse({
    adapter: 'mock',
    // An explicit worker model, so only interview candidates use the tier names.
    workers: {
      model: 'mock-worker',
      ...(env['AGENTCATS_MAX_WORKERS'] && { max: Number(env['AGENTCATS_MAX_WORKERS']) }),
    },
    port: Number(env['AGENTCATS_PORT'] ?? 4545),
    worktreesDir,
  }),
  uiDir: env['AGENTCATS_UI_DIR'] ?? null,
  ...(env['AGENTCATS_TOKEN'] && { token: env['AGENTCATS_TOKEN'] }),
  logger: consoleLogger,
});

const fragment = daemon.uiUrl.slice(daemon.uiUrl.indexOf('#'));
console.log(`Mock daemon on ${daemon.url} for ${projectPath}`);
console.log(`Vite dev UI: http://localhost:5173/${fragment}`);
if (env['AGENTCATS_UI_DIR']) console.log(`Built UI:    ${daemon.uiUrl}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void daemon
      .close()
      .then(() => rm(projectPath, { recursive: true, force: true, maxRetries: 5 }))
      .then(() => rm(worktreesDir, { recursive: true, force: true, maxRetries: 5 }))
      .then(() => process.exit(0));
  });
}
