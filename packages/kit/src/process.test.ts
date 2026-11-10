import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

import { describe, expect, it } from 'vitest';

import {
  GUARDIAN_PATH,
  isProcessAlive,
  killProcessTree,
  processStartTime,
  spawnGuarded,
} from './process.js';

/** A stand-in agent: prints its pid, then idles forever. */
const SLEEPER = ['-e', 'console.log(process.pid); setInterval(() => {}, 1e6)'];

function firstLine(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const lines = createInterface({ input: stream });
    lines.once('line', (line) => {
      lines.close();
      resolve(line);
    });
    stream.once('error', reject);
  });
}

async function waitUntilDead(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isProcessAlive(pid)) {
    if (Date.now() > deadline) throw new Error(`pid ${pid} still alive`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('spawnGuarded and killProcessTree', () => {
  it('kills the guardian and the agent together', async () => {
    const guardian = spawnGuarded(process.execPath, SLEEPER);
    const agentPid = Number(await firstLine(guardian.stdout));
    expect(isProcessAlive(agentPid)).toBe(true);

    await killProcessTree(guardian.pid!);

    expect(isProcessAlive(guardian.pid!)).toBe(false);
    await waitUntilDead(agentPid);
  });

  it('kills the agent when the owner is hard-killed', async () => {
    // The owner spawns the guardian itself, then prints the agent pid.
    const ownerScript = `
      const { spawn } = require('node:child_process');
      const g = spawn(process.execPath, [${JSON.stringify(GUARDIAN_PATH)}, String(process.pid),
        process.execPath, ...${JSON.stringify(SLEEPER)}], { stdio: ['ignore', 'pipe', 'inherit'],
        detached: process.platform !== 'win32', windowsHide: true });
      g.stdout.pipe(process.stdout);
      setInterval(() => {}, 1e6);`;
    const owner = spawn(process.execPath, ['-e', ownerScript], { windowsHide: true });
    const agentPid = Number(await firstLine(owner.stdout));
    expect(isProcessAlive(agentPid)).toBe(true);

    process.kill(owner.pid!, 'SIGKILL'); // no cleanup runs in the owner

    await waitUntilDead(agentPid);
  });

  it('is a no-op for a process that does not exist', async () => {
    const child = spawn(process.execPath, ['-e', '']);
    await new Promise((r) => child.once('exit', r));
    await expect(killProcessTree(child.pid!)).resolves.toBeUndefined();
  });
});

describe('processStartTime', () => {
  it('reports when the current process started', async () => {
    const started = Date.now() - process.uptime() * 1000;
    const reported = await processStartTime(process.pid);
    expect(reported).not.toBeNull();
    expect(Math.abs(reported! - started)).toBeLessThan(5_000);
  });

  it('returns null for a process that does not exist', async () => {
    const child = spawn(process.execPath, ['-e', '']);
    await new Promise((r) => child.once('exit', r));
    expect(await processStartTime(child.pid!)).toBeNull();
  });
});
