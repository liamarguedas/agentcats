// `pnpm dev`: the mock daemon plus the Vite dev server, in one terminal.
// Stops both on Ctrl+C or when either exits.
import { spawn } from 'node:child_process';

const children = ['dev:daemon', 'dev'].map((script) =>
  spawn('pnpm', ['run', script], { stdio: 'inherit', shell: process.platform === 'win32' }),
);

let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  process.exitCode = code;
}

for (const child of children) child.on('exit', (code) => stop(code ?? 0));
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
