// Smoke test of an installed `agentcats` package, the way a stranger meets
// it: `npx agentcats --demo` in a folder with nothing else, no agent CLI and
// no workspace. Passes when the board is served and the scripted cats get a
// task to review.
//
//   node packages/cli/scripts/smoke.mjs <folder where agentcats is installed>
import { spawn, spawnSync } from 'node:child_process';

const dir = process.argv[2];
if (!dir) {
  console.error('Usage: node smoke.mjs <install folder>');
  process.exit(2);
}

// One fixed command string: npx is a script on Windows and needs a shell there.
const child = spawn('npx --no-install agentcats --demo --no-open', {
  cwd: dir,
  shell: true,
  // Its own process group on POSIX, so the whole group can be stopped.
  detached: process.platform !== 'win32',
  stdio: ['ignore', 'pipe', 'pipe'],
});
/** Stop the shell and agentcats under it (on Windows, killing the shell alone leaves them). */
const stop = () => {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    process.kill(-child.pid, 'SIGINT');
  }
};
let output = '';
child.stdout.on('data', (chunk) => (output += chunk));
child.stderr.on('data', (chunk) => (output += chunk));

const fail = (message) => {
  console.error(`Smoke test failed: ${message}\n--- output ---\n${output}`);
  stop();
  process.exit(1);
};
const deadline = Date.now() + 120_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let board = null;
while (!board) {
  if (Date.now() > deadline) fail('no board URL printed');
  if (child.exitCode !== null) fail(`exited with ${String(child.exitCode)}`);
  board = /Board: (http:\/\/127\.0\.0\.1:\d+)\/#token=(\S+)/.exec(output);
  await sleep(250);
}
const [, base, token] = board;

const page = await fetch(`${base}/`);
const html = await page.text();
if (!page.ok || !html.includes('<div id="root">')) fail(`UI not served (${String(page.status)})`);

for (;;) {
  if (Date.now() > deadline) fail('no task reached review');
  const res = await fetch(`${base}/api/snapshot`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const { board: state } = await res.json();
  if (Object.values(state.tasks).some((t) => t.status === 'review')) break;
  await sleep(1_000);
}

console.log(`Smoke test passed: board at ${base}, scripted cats delivered a task for review.`);
stop();
process.exit(0);
