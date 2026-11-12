import { killProcessTree, spawnGuarded } from '@agentcats/kit';

export interface CommandResult {
  readonly ok: boolean;
  readonly timedOut: boolean;
  /** The last lines of stdout and stderr together. */
  readonly tail: string;
}

const TAIL = 1_500;

/**
 * Run a shell command line in `cwd` under the guardian, so it cannot outlive
 * the daemon, and kill its whole tree after `timeoutMs`. Used for interview
 * checks, which run code the candidates wrote: never call it without the
 * user's go-ahead for that interview.
 */
export function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<CommandResult> {
  const [shell, args] =
    process.platform === 'win32'
      ? ['cmd.exe', ['/d', '/s', '/c', command]]
      : ['/bin/sh', ['-c', command]];
  return new Promise((resolve) => {
    let output = '';
    let timedOut = false;
    const child = spawnGuarded(shell, args, { cwd, env: { ...process.env, CI: '1' } });
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-TAIL * 4);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.stdin.end();
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) void killProcessTree(child.pid);
    }, timeoutMs);
    timer.unref();
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      resolve({ ok: ok && !timedOut, timedOut, tail: output.trim().slice(-TAIL) });
    };
    child.once('error', () => {
      finish(false);
    });
    child.once('exit', (code) => {
      finish(code === 0);
    });
  });
}
