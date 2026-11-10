// M0 acceptance, end to end with the real Claude Code CLI. Spends tokens, so it
// only runs with AGENTCATS_LIVE_CLAUDE=1. Uses `haiku` to keep cost low.
//
//   AGENTCATS_LIVE_CLAUDE=1 pnpm test:e2e -- live-claude
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { expect, test } from '@playwright/test';

const LIVE = process.env['AGENTCATS_LIVE_CLAUDE'] === '1';
const SHOTS = 'test-results/screenshots';

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

test.describe('live Claude', () => {
  test.skip(!LIVE, 'set AGENTCATS_LIVE_CLAUDE=1 to run against the real Claude Code CLI');
  test.describe.configure({ timeout: 300_000 });

  let repo = '';
  let cli: ChildProcess | null = null;

  test.afterAll(async () => {
    cli?.kill();
    await new Promise((r) => setTimeout(r, 1500));
    if (repo) await rm(repo, { recursive: true, force: true, maxRetries: 10 });
  });

  test('typing a task makes the cat animate while a real file changes', async ({ page }) => {
    repo = await mkdtemp(join(tmpdir(), 'agentcats-scratch-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    await writeFile(join(repo, 'README.md'), '# scratch repo\n');
    await mkdir(join(repo, '.agentcats'));
    await writeFile(
      join(repo, '.agentcats', 'agentcats.config.json'),
      JSON.stringify({ adapter: 'claude', defaultModel: 'haiku', permissionMode: 'accept_edits' }),
    );

    cli = spawn(
      process.execPath,
      [
        '--conditions=@agentcats/source',
        '--import',
        'tsx',
        '../cli/src/bin.ts',
        '--project',
        repo,
        '--no-open',
      ],
      { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true },
    );
    const lines = createInterface({ input: cli.stdout! });
    const boardUrl = await new Promise<string>((resolve) => {
      lines.on('line', (line) => {
        console.log(`[cli] ${line}`);
        if (line.startsWith('Board: ')) resolve(line.slice('Board: '.length));
      });
    });

    await page.goto(boardUrl);
    await expect(page.getByTestId('connection')).toHaveText('Live');
    await expect(page.getByTestId('cat-status')).toHaveText('Idle');

    const seen = new Set<string>();
    const status = page.getByTestId('cat-status');
    const input = page.getByLabel('Task for the cat');
    await input.fill('add a hello function to a scratch repo');
    await input.press('Enter');

    let shotTaken = false;
    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline) {
      const text = (await status.textContent()) ?? '';
      seen.add(text);
      if (text === 'Working' && !shotTaken) {
        await page.screenshot({ path: `${SHOTS}/live-working.png`, animations: 'disabled' });
        shotTaken = true;
      }
      if (text === 'Done' || text === 'Error') break;
      // Answer like a user would. Deny, so nothing but file edits runs in the temp dir.
      const approval = page.getByRole('alertdialog', { name: 'Approval request' });
      if (await approval.isVisible()) {
        if (!seen.has('approval screenshot')) {
          await page.screenshot({ path: `${SHOTS}/live-approval.png`, animations: 'disabled' });
          seen.add('approval screenshot');
        }
        await approval.getByRole('button', { name: 'Deny' }).click();
        await expect(approval).toBeHidden();
      }
      await page.waitForTimeout(100);
    }
    await page.screenshot({ path: `${SHOTS}/live-done.png`, animations: 'disabled' });
    seen.delete('approval screenshot');
    console.log('statuses seen:', [...seen].join(' → '));

    expect(seen).toContain('Thinking');
    expect(seen).toContain('Working');
    await expect(status).toHaveText('Done');

    const files = (await readdir(repo)).filter(
      (f) => !['.git', '.agentcats', 'README.md'].includes(f),
    );
    expect(files.length).toBeGreaterThan(0);
    const contents = await Promise.all(
      files.map((f) => readFile(join(repo, f), 'utf8').catch(() => '')),
    );
    expect(contents.join('\n').toLowerCase()).toContain('hello');
    console.log('files created:', files);

    // Hard-kill the CLI (no cleanup runs) and make sure the agent dies with it.
    const pidsFile = JSON.parse(
      await readFile(join(repo, '.agentcats', 'run', 'pids.json'), 'utf8'),
    ) as { processes: { pid: number }[] };
    const agentPids = pidsFile.processes.map((p) => p.pid);
    expect(agentPids.length).toBe(1);
    cli.kill('SIGKILL');
    await expect.poll(() => agentPids.filter(isAlive).length, { timeout: 10_000 }).toBe(0);
  });
});
