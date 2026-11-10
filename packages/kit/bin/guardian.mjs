#!/usr/bin/env node
// Runs one agent process and makes sure it cannot outlive its owner.
//
// Usage: node guardian.mjs <ownerPid> <command> [args...]
//
// The agent inherits this process's stdio, so the owner talks to the agent
// directly. Every 500 ms the guardian checks that the owner is still alive; if
// the owner died (even by SIGKILL, which runs no cleanup), the guardian kills
// the agent's whole process tree and exits. On POSIX the guardian is started
// as a process group leader and the agent stays in its group, so one group
// kill covers everything. On Windows `taskkill /T` walks the tree.
//
// Plain JavaScript on purpose: it must run with bare `node`, without a build.

import { execFile, spawn } from 'node:child_process';

const [ownerArg, command, ...args] = process.argv.slice(2);
const ownerPid = Number(ownerArg);
if (!Number.isInteger(ownerPid) || ownerPid <= 0 || !command) {
  process.stderr.write('usage: guardian.mjs <ownerPid> <command> [args...]\n');
  process.exit(64);
}

const isWindows = process.platform === 'win32';
const child = spawn(command, args, { stdio: 'inherit', windowsHide: true });

function ownerAlive() {
  // On POSIX an orphaned guardian is re-parented, so ppid changes at once.
  if (!isWindows && process.ppid !== ownerPid) return false;
  try {
    process.kill(ownerPid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

let stopping = false;
function killTreeAndExit(code) {
  if (stopping) return;
  stopping = true;
  if (isWindows) {
    if (child.pid === undefined) process.exit(code);
    execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => process.exit(code));
  } else {
    try {
      process.kill(-process.pid, 'SIGKILL'); // the group includes this guardian
    } catch {
      process.exit(code);
    }
  }
}

const watch = setInterval(() => {
  if (!ownerAlive()) killTreeAndExit(1);
}, 500);

child.on('error', (error) => {
  process.stderr.write(`guardian: failed to start ${command}: ${error.message}\n`);
  clearInterval(watch);
  process.exit(127);
});

child.on('exit', (code, signal) => {
  clearInterval(watch);
  if (!stopping) process.exit(code ?? (signal ? 128 : 0));
});

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => killTreeAndExit(143));
}
