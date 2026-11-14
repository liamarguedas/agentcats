import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, type Page, test } from '@playwright/test';

import { E2E_STATE_FILE, E2E_TOKEN } from '../playwright.config.js';

const SHOTS = 'test-results/screenshots';
const shot = (page: Page, name: string, fullPage = false) =>
  page.screenshot({ path: `${SHOTS}/${name}.png`, animations: 'disabled', fullPage });

async function openBoard(page: Page) {
  await page.goto(`/#token=${E2E_TOKEN}`);
  await expect(page.getByTestId('connection')).toHaveText('Live');
}

async function chat(page: Page, text: string) {
  const input = page.getByLabel('Task for the cat');
  await expect(input).toBeEnabled({ timeout: 15_000 });
  await input.fill(text);
  await input.press('Enter');
}

const lead = (page: Page) => page.getByTestId('cat-Tux');

/** A cat's learnings.md in the mock daemon's project, as it is on disk now. */
function learningsOnDisk(catName: string): string {
  const { projectPath } = JSON.parse(readFileSync(E2E_STATE_FILE, 'utf8')) as {
    projectPath: string;
  };
  try {
    return readFileSync(join(projectPath, '.agentcats', 'cats', catName, 'learnings.md'), 'utf8');
  } catch {
    return '';
  }
}
const tasks = (page: Page) => page.getByRole('region', { name: 'Tasks' });

test.describe.configure({ mode: 'serial' });

test('connects with the token from the link and shows the lead cat', async ({ page }) => {
  await openBoard(page);
  expect(new URL(page.url()).hash).toBe('');
  await expect(lead(page)).toBeVisible();
  await expect(lead(page).getByTestId('cat-status')).toHaveText('Idle');
  await expect(page.getByText('No workers yet.')).toBeVisible();
  await shot(page, 'empty');
});

test('the lead splits a request between two workers who work in parallel', async ({ page }) => {
  await openBoard(page);
  // A worker is busy for well under a second at this time scale, shorter than
  // the assertion's polling, so record every status Mochi's card shows.
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { mochiStatuses: string[] }).mochiStatuses = seen;
    new MutationObserver(() => {
      const text = document.querySelector(
        '[data-testid="cat-Mochi"] [data-testid="cat-status"]',
      )?.textContent;
      if (text && seen.at(-1) !== text) seen.push(text);
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  await chat(page, 'Add a login endpoint and write tests for it');
  await expect(page.getByRole('region', { name: 'Chat' })).toContainText('Add a login endpoint');

  const workers = page.getByRole('group', { name: 'Cats' }).locator('.cat-card--worker');
  await expect(workers).toHaveCount(2, { timeout: 15_000 });
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { mochiStatuses: string[] }).mochiStatuses),
    )
    .toEqual(expect.arrayContaining([expect.stringMatching(/Thinking|Working/)]));
  await shot(page, 'team-working');

  await expect(tasks(page).locator('.task-card--review')).toHaveCount(2, { timeout: 20_000 });
  await expect(tasks(page)).toContainText('agentcats/');
  await expect(page.getByRole('region', { name: 'Chat' })).toContainText('ready for review', {
    timeout: 15_000,
  });
  await shot(page, 'team-review');
});

test('a result is reviewed in the drawer and accepted', async ({ page }) => {
  await openBoard(page);
  await tasks(page).locator('.task-card--review').first().click();
  const drawer = page.getByRole('dialog');
  await expect(drawer).toContainText('Worker summary');
  await expect(drawer).toContainText('Tests');
  await expect(drawer).toContainText('History');
  await shot(page, 'task-drawer');

  await drawer.getByRole('button', { name: 'Accept' }).click();
  await expect(drawer.locator('.chip').first()).toHaveText('Done');
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
});

test('a rejection can say why', async ({ page }) => {
  await openBoard(page);
  await tasks(page).locator('.task-card--review').first().click();
  const drawer = page.getByRole('dialog');
  await drawer.getByRole('button', { name: 'Reject…' }).click();
  await drawer
    .getByLabel('What was wrong? (optional)')
    .fill('The tests do not cover a wrong password');
  await shot(page, 'reject-note');
  await drawer.getByRole('button', { name: 'Reject', exact: true }).click();
  await expect(drawer.locator('.chip').first()).toHaveText('Rejected');
  await expect(drawer).toContainText('Rejected by you: The tests do not cover a wrong password');
  await page.keyboard.press('Escape');
});

test('an accepted result earns XP; its learning can be kept, edited and deleted', async ({
  page,
}) => {
  await openBoard(page);
  await chat(
    page,
    'Document the API\n/single\nlearn: The API docs live in docs/api.md; update them with every route change',
  );
  const card = tasks(page).locator('.task-card', { hasText: 'Document the API' });
  await expect(card.locator('.chip')).toHaveText('Review', { timeout: 20_000 });
  await card.click();
  await page.getByRole('dialog').getByRole('button', { name: 'Accept' }).click();
  await page.keyboard.press('Escape');

  await expect(page.getByRole('region', { name: 'Event log' })).toContainText(
    'XP, result accepted',
  );
  const toast = page.locator('.toast--info', { hasText: 'suggests 1 new learning' });
  await expect(toast).toBeVisible({ timeout: 15_000 });
  await shot(page, 'xp-and-suggestion');

  await toast.getByRole('button').first().click();
  const drawer = page.getByRole('dialog');
  const name = ((await drawer.locator('.drawer__title').textContent()) ?? '').split(' · ')[0]!;
  await expect(drawer).toContainText('Level 1');
  const proposal = drawer.getByTestId('proposal');
  await expect(proposal).toContainText('docs/api.md');
  await shot(page, 'learning-proposal');
  expect(learningsOnDisk(name)).not.toContain('docs/api.md');

  await proposal.getByRole('button', { name: 'Keep' }).click();
  const list = drawer.getByTestId('learnings');
  await expect(list).toContainText('The API docs live in docs/api.md');
  await expect(list).toContainText('Document the API');
  expect(learningsOnDisk(name)).toContain('- The API docs live in docs/api.md');

  await list.getByRole('button', { name: /^The API docs live/ }).click();
  const input = drawer.getByLabel('Learning text');
  await input.fill('API docs are in docs/api.md and change with every route');
  await input.press('Enter');
  await expect(list).toContainText('API docs are in docs/api.md and change with every route');
  expect(learningsOnDisk(name)).toContain(
    '- API docs are in docs/api.md and change with every route',
  );
  await shot(page, 'learnings');

  await list.getByRole('button', { name: /Delete learning/ }).click();
  await expect(drawer).toContainText('Nothing yet');
  expect(learningsOnDisk(name)).not.toContain('docs/api.md');
  await page.keyboard.press('Escape');
});

test('a worker asks before reaching the network; Deny blocks it', async ({ page }) => {
  await openBoard(page);
  await chat(page, 'Read the API docs\n/single\n/network');
  const bubble = page.getByRole('alertdialog', { name: /Approval request from/ });
  await expect(bubble).toBeVisible({ timeout: 15_000 });
  await expect(bubble).toContainText('WebFetch');
  await shot(page, 'approval');
  await bubble.getByRole('button', { name: 'Deny' }).click();
  await expect(bubble).toBeHidden();
  await expect(tasks(page).getByText('Read the API docs')).toBeVisible();
});

test('a focused cat answers its approval from the keyboard, and shows its details on hover', async ({
  page,
}) => {
  await openBoard(page);
  await chat(page, 'Fetch the changelog\n/single\n/network');
  const bubble = page.getByRole('alertdialog', { name: /Approval request from/ });
  await expect(bubble).toBeVisible({ timeout: 15_000 });
  const name =
    (await bubble.getAttribute('aria-label'))?.replace('Approval request from ', '') ?? '';
  const photo = page.getByRole('button', { name: `${name}: open details` });
  await photo.focus();
  // Focus shows the details card, with the keys that work on this cat.
  const card = page.getByTestId(`cat-${name}`);
  await expect(card.getByText('A allow · D deny')).toBeVisible();
  await expect(card.getByTestId('cat-status')).toHaveText('Needs your approval');
  await page.keyboard.press('a');
  await expect(bubble).toBeHidden();

  await lead(page).getByRole('button', { name: 'Tux: open details' }).hover();
  await expect(lead(page).getByTestId('cat-status')).toBeVisible();
  await shot(page, 'hover-card');
  await page.mouse.move(0, 0);
});

test("the lead's approval bubble fits in the office, however long the request", async ({
  page,
}) => {
  await openBoard(page);
  await chat(page, 'Look at the history\n/lead-asks');
  const bubble = page.getByRole('alertdialog', { name: 'Approval request from Tux' });
  await expect(bubble).toBeVisible({ timeout: 15_000 });
  // The office scrolls sideways, so anything above its top edge is cut off.
  await expect(async () => {
    const box = (await bubble.boundingBox())!;
    const office = (await page.getByRole('region', { name: 'Office' }).boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(office.y);
  }).toPass({ timeout: 5_000 });
  await expect(bubble.getByRole('button', { name: 'Allow' })).toBeInViewport();
  await shot(page, 'lead-approval');
  await bubble.getByRole('button', { name: 'Allow' }).click();
  await expect(bubble).toBeHidden();
});

test("a cat's card opens where it fits, also for cats in the bottom row", async ({ page }) => {
  await openBoard(page);
  await chat(page, 'Sort the imports\n/single');
  const card = tasks(page).locator('.task-card', { hasText: 'Sort the imports' });
  await expect(card.locator('.chip')).toHaveText('Review', { timeout: 20_000 });
  const name = ((await card.locator('.task-card__cat').textContent()) ?? '').trim();
  // Done: it waits in the row at the bottom of the whiteboard.
  const cat = page.locator(`.office__cat:has([data-testid="cat-${name}"])`);
  await expect(cat).toHaveAttribute('data-area', 'whiteboard');
  await page.getByRole('button', { name: `${name}: open details` }).hover();
  const meta = page.getByTestId(`cat-${name}`).locator('.cat-card__meta');
  await expect(meta).toBeVisible();
  // The office scrolls sideways, so anything below its bottom edge is cut off.
  await expect(async () => {
    const box = (await meta.boundingBox())!;
    const office = (await page.getByRole('region', { name: 'Office' }).boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(office.y + office.height);
    expect(box.y).toBeGreaterThanOrEqual(office.y);
  }).toPass({ timeout: 5_000 });
  await shot(page, 'card-bottom-row');
  await page.mouse.move(0, 0);
});

test('a crashing worker is retried once, then failed, and can be re-run', async ({ page }) => {
  await openBoard(page);
  await chat(page, 'Build the thing\n/single\n/crash');
  const card = tasks(page).locator('.task-card', { hasText: 'Build the thing' });
  await expect(card.locator('.chip')).toHaveText('Failed', { timeout: 20_000 });
  await expect(card).toContainText('attempt 2');
  // A meme caption on the worker who failed, from the default template file.
  await expect(page.locator('.cat-card .meme-caption')).toBeVisible();
  await shot(page, 'failed');

  await card.click();
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Re-run' })).toBeVisible();
  await page.keyboard.press('Escape');
});

test('cat properties can be edited', async ({ page }) => {
  await openBoard(page);
  await page.getByRole('button', { name: 'Mochi: open details' }).click();
  const drawer = page.getByRole('dialog');
  await expect(drawer).toContainText('Worker: edits in its own worktree');
  await drawer.getByLabel('Budget ($)').fill('5');
  await drawer.getByRole('button', { name: 'Save' }).click();
  await expect(drawer.getByRole('status')).toHaveText('Saved');
  await shot(page, 'properties');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('cat-Mochi')).toContainText('/ $5.00');
});

test('a cat can be renamed, and its learnings move with it', async ({ page }) => {
  await openBoard(page);
  const before = learningsOnDisk('Mochi');
  expect(before).toContain("# Mochi's learnings");
  await page.getByRole('button', { name: 'Mochi: open details' }).click();
  const drawer = page.getByRole('dialog');
  const name = drawer.getByLabel('Name');
  const save = drawer.getByRole('button', { name: 'Save' });

  // A name that cannot be a folder is caught before it is sent.
  await name.fill('../Mochi');
  await expect(drawer.getByText(/Use letters, digits/)).toBeVisible();
  await expect(save).toBeDisabled();
  await shot(page, 'rename-invalid');
  // One the daemon refuses shows its reason, and no "Saved".
  await name.fill('tux');
  await save.click();
  await expect(
    page.locator('.toast', { hasText: 'Another cat is already called Tux' }),
  ).toBeVisible();
  await expect(drawer.getByRole('status')).toHaveCount(0);

  await name.fill('Grumpy Cat');
  await save.click();
  await expect(drawer.getByRole('status')).toHaveText('Saved');
  await expect(drawer.getByRole('heading', { name: 'Grumpy Cat · worker' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('cat-Grumpy Cat')).toBeVisible();
  expect(learningsOnDisk('Mochi')).toBe('');
  expect(learningsOnDisk('Grumpy Cat')).toContain("# Grumpy Cat's learnings");

  // Back to Mochi, for the tests that follow.
  await page.getByRole('button', { name: 'Grumpy Cat: open details' }).click();
  await drawer.getByLabel('Name').fill('Mochi');
  await drawer.getByRole('button', { name: 'Save' }).click();
  await expect(drawer.getByRole('status')).toHaveText('Saved');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('cat-Mochi')).toBeVisible();
});

test('hiring runs an interview after the estimate is confirmed, and only a passing candidate can win', async ({
  page,
}) => {
  await openBoard(page);
  await page.getByRole('button', { name: 'Hire a cat' }).click();
  const dialog = page.getByRole('dialog', { name: 'Hire a cat' });
  await dialog.getByLabel('What is the new cat for?').fill('Writes small, careful changes');
  await dialog.getByLabel('Interview task').selectOption({ label: 'Answer the question (yours)' });
  await dialog.getByLabel('Candidates').selectOption('3');
  await dialog.getByRole('button', { name: 'Get an estimate' }).click();
  await expect(dialog.getByTestId('estimate')).toHaveText('Estimated cost: about $0.75');
  // Nothing runs before the confirmation.
  await expect(page.getByRole('region', { name: /^Interview:/ })).toContainText(
    'Waiting for you to start it',
  );
  await shot(page, 'hire-estimate');
  await dialog.getByRole('button', { name: /Start interview/ }).click();
  // Starting hires three candidates on the daemon before it answers; on a busy
  // CI runner that round trip once took over the default 5 s.
  await expect(dialog).toBeHidden({ timeout: 15_000 });

  const panel = page.getByRole('region', { name: /^Interview:/ });
  await expect(panel).toContainText('Scored: pick one to hire', { timeout: 30_000 });
  const scores = panel.getByTestId('scores');
  await expect(scores.locator('tr', { hasText: '✗ fail' })).toContainText('not hireable');
  await expect(scores.getByRole('button', { name: /^Hire / })).toHaveCount(2);
  await panel.screenshot({ path: `${SHOTS}/interview-scored.png`, animations: 'disabled' });

  const hire = scores.getByRole('button', { name: /^Hire / }).first();
  const winner = ((await hire.textContent()) ?? '').replace('Hire ', '');
  // A candidate is stopped with its interview, so its card has no Pause or Stop.
  const controls = /^(Pause|Stop)$/;
  // Pointing at the floor would show only the hovered cat's card.
  await page.mouse.move(0, 0);
  await page.getByRole('button', { name: 'Tux: open details' }).focus();
  await expect(lead(page).getByRole('button', { name: controls })).toHaveCount(2);
  await page.getByRole('button', { name: `${winner}: open details` }).focus();
  const candidate = page.getByTestId(`cat-${winner}`);
  await expect(candidate.getByTestId('cat-status')).toBeVisible();
  await expect(candidate).toContainText('Candidate');
  await expect(candidate.getByRole('button', { name: controls })).toHaveCount(0);
  await hire.click();
  await expect(page.locator('.toast--info', { hasText: `${winner} is hired!` })).toBeVisible();
  await expect(page.getByRole('region', { name: /^Interview:/ })).toHaveCount(0);
  await expect(page.getByTestId(`cat-${winner}`)).toContainText('Worker');
  await shot(page, 'hired');
});

test('a cat can be retired and brought back with its XP', async ({ page }) => {
  await openBoard(page);
  await page.getByRole('button', { name: 'Miso: open details' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Retire…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Retire Miso?' });
  await expect(dialog).toContainText('you can bring it back later');
  await dialog.getByLabel('Reason').fill('Taking a nap');
  await shot(page, 'retire-dialog');
  await dialog.getByRole('button', { name: 'Retire Miso' }).click();
  await expect(page.getByTestId('cat-Miso')).toHaveCount(0);

  const retired = page.getByRole('region', { name: 'Retired cats' });
  await retired.locator('summary').click();
  await expect(retired).toContainText('Miso');
  await expect(retired).toContainText('Taking a nap');
  await expect(retired.getByRole('img', { name: 'Miso, retired' })).toBeVisible();
  await retired.screenshot({ path: `${SHOTS}/retired-list.png`, animations: 'disabled' });
  await retired.getByRole('button', { name: 'Bring back' }).click();
  await expect(page.getByTestId('cat-Miso')).toContainText(/\d+ XP/);
  await expect(retired).toHaveCount(0);
});

test('a cat moved to an agent without cost reporting shows cost unknown, its time budget and a sandbox warning', async ({
  page,
}) => {
  await openBoard(page);
  const card = page.getByTestId('cat-Mochi');
  await expect(card.getByTestId('adapter-badge')).toHaveText('Mock');
  await page.getByRole('button', { name: 'Mochi: open details' }).click();
  const drawer = page.getByRole('dialog');
  await drawer
    .getByRole('combobox', { name: 'Agent' })
    .selectOption({ label: 'Mock (mock-nocost)' });
  await expect(drawer.getByLabel('Time limit (min)')).toHaveValue('60');
  await drawer.getByRole('button', { name: 'Save' }).click();
  await expect(drawer.getByRole('status')).toHaveText('Saved');
  await page.keyboard.press('Escape');

  await expect(card.getByTestId('adapter-badge')).toHaveText('Mock (mock-nocost) ⚠');
  await expect(card.getByTestId('adapter-badge')).toHaveAttribute('title', /own sandbox/);
  await expect(card).toContainText(/cost unknown · .* \/ 60 min/);
  await card.screenshot({ path: `${SHOTS}/cost-unknown.png`, animations: 'disabled' });
});

test('the cost meter shows spend, budgets, cost over time and the most expensive tasks', async ({
  page,
}) => {
  await openBoard(page);
  await page.getByRole('button', { name: /Team spend/ }).click();
  const meter = page.getByRole('dialog', { name: 'Spend' });
  await expect(meter.getByText('Team budget left')).toBeVisible();
  // Mochi now runs on an agent without cost reporting: counted by working time, not as $0.
  await expect(meter.getByText('Cost unknown', { exact: true })).toBeVisible();
  await expect(meter.getByRole('row', { name: /Mochi/ })).toContainText('Cost unknown');
  const chart = meter.getByRole('img', { name: 'Cost per cat over time' });
  await expect(chart).toBeVisible();
  const box = (await chart.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2);
  await expect(meter.locator('.spend-chart__tooltip')).toContainText('Tux');
  await expect(meter.getByRole('list', { name: 'Legend' })).toContainText('Tux');
  await expect(meter.locator('.cost-meter__tasks li').first()).toBeVisible();
  await meter.screenshot({ path: `${SHOTS}/cost-meter.png`, animations: 'disabled' });
  await page.keyboard.press('Escape');
  await expect(meter).toBeHidden();
});

test('the theme switch pins light or dark over the system setting, and remembers it', async ({
  page,
}) => {
  await openBoard(page);
  const html = page.locator('html');
  const button = page.getByRole('button', { name: /Switch theme/ });
  await expect(html).not.toHaveAttribute('data-theme');
  await button.click();
  await expect(html).toHaveAttribute('data-theme', 'light');
  await button.click();
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(27, 25, 22)');
  await shot(page, 'dark');
  await page.reload();
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: /Switch theme/ }).click();
  await expect(html).not.toHaveAttribute('data-theme');
});

test('the board resyncs after a reload', async ({ page }) => {
  await openBoard(page);
  await page.reload();
  await expect(page.getByTestId('connection')).toHaveText('Live');
  await expect(tasks(page)).toContainText('Build the thing');
  await expect(page.getByRole('region', { name: 'Chat' })).toContainText('Add a login endpoint');
});

test('a past session replays read-only, exports without long texts, and imports back', async ({
  page,
}) => {
  await openBoard(page);
  await page.getByRole('button', { name: 'Replay', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Replay a session' });
  await picker.getByRole('button', { name: /This run/ }).click();

  const bar = page.getByRole('region', { name: 'Replay' });
  await expect(bar).toBeVisible();
  await expect(page.getByTestId('connection')).toHaveText('Replay');
  await expect(page.getByRole('button', { name: 'Hire a cat' })).toBeHidden();
  // The run so far, scrubbed to its end: the workers from earlier tests are back.
  await bar.getByLabel('Position').focus();
  await page.keyboard.press('End');
  await expect(page.getByTestId('cat-Mochi')).toBeVisible();
  await expect(bar).toContainText(/event (\d+) of \1(?!\d)/);
  await shot(page, 'replay');
  await page.keyboard.press('Home');
  await bar.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(bar.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await bar.getByRole('button', { name: 'Pause', exact: true }).click();

  await bar.getByRole('button', { name: 'Export…' }).click();
  await expect(bar.getByLabel('Include file contents and long outputs')).not.toBeChecked();
  const [file] = await Promise.all([
    page.waitForEvent('download'),
    bar.getByRole('button', { name: 'Download' }).click(),
  ]);
  expect(file.suggestedFilename()).toMatch(/^agentcats-session-[\d-]+\.json$/);
  const path = await file.path();
  const exported = JSON.parse(readFileSync(path, 'utf8')) as {
    format: string;
    includesContents: boolean;
    events: { type: string; payload: { text?: string } }[];
  };
  expect(exported).toMatchObject({ format: 'agentcats-session', includesContents: false });
  const { projectPath } = JSON.parse(readFileSync(E2E_STATE_FILE, 'utf8')) as {
    projectPath: string;
  };
  // JSON escapes backslashes, so a Windows path appears with them doubled.
  expect(JSON.stringify(exported)).not.toContain(JSON.stringify(projectPath).slice(1, -1));

  await bar.getByRole('button', { name: 'Exit replay' }).click();
  await expect(page.getByTestId('connection')).toHaveText('Live');

  await page.getByRole('button', { name: 'Replay', exact: true }).click();
  await page.locator('input[type=file]').setInputFiles(path);
  await expect(bar).toContainText('(long texts cut)');
  await expect(bar.getByRole('button', { name: 'Export…' })).toBeHidden();
  await bar.getByRole('button', { name: 'Exit replay' }).click();
});

test('without a token it explains how to open the board', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Open the board from the link printed by')).toBeVisible();
});

test('a wrong token is reported', async ({ page }) => {
  await page.goto('/#token=wrong-token-wrong-token-wrong-token-xxxxxxx');
  await expect(page.getByTestId('connection')).toHaveText('Token rejected');
});

test('settings change the defaults for new cats, and can move existing ones', async ({ page }) => {
  const { projectPath } = JSON.parse(readFileSync(E2E_STATE_FILE, 'utf8')) as {
    projectPath: string;
  };
  const projectFile = join(projectPath, '.agentcats', 'agentcats.config.json');
  await openBoard(page);
  // A worker on the board, also when this test runs alone.
  await chat(page, 'Tidy the changelog\n/single');
  const card = tasks(page).locator('.task-card', { hasText: 'Tidy the changelog' });
  await expect(card.locator('.chip')).toHaveText('Review', { timeout: 20_000 });
  await page.getByRole('button', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog.getByLabel('Default agent')).toHaveValue('mock');

  // A new worker agent: the dialog offers to move the workers on another one.
  await dialog
    .getByRole('combobox', { name: 'Workers', exact: true })
    .selectOption({ label: 'Mock (mock-nocost)' });
  const moves = dialog.getByRole('group', { name: 'Cats on another agent' });
  await expect(moves).toContainText(/Move \w+ from Mock to Mock \(mock-nocost\)/);
  await expect(moves).not.toContainText('Tux');
  await dialog.getByLabel('Workers at once').fill('5');
  await shot(page, 'settings');
  const listed = (await moves.locator('label').allTextContents()).map(
    (text) => /Move (\w+)/.exec(text)?.[1] ?? '',
  );
  // Keep every cat where it is: only new workers use the new agent.
  for (const box of await moves.getByRole('checkbox').all()) await box.uncheck();
  await dialog.getByRole('button', { name: 'Save for this project' }).click();
  await expect(dialog.getByRole('status')).toHaveText('Saved for this project.');
  const saved = JSON.parse(readFileSync(projectFile, 'utf8')) as Record<string, unknown>;
  expect(saved).toMatchObject({ workers: { adapter: 'mock-nocost', max: 5 } });
  for (const name of listed) {
    await expect(page.getByTestId(`cat-${name}`).getByTestId('adapter-badge')).toHaveText('Mock');
  }

  // Back to how it was, for the tests that follow.
  await dialog
    .getByRole('combobox', { name: 'Workers', exact: true })
    .selectOption({ label: 'Default (Mock)' });
  await dialog.getByLabel('Workers at once').fill('3');
  await dialog.getByRole('button', { name: 'Save for this project' }).click();
  await expect(dialog.getByRole('status')).toHaveText('Saved for this project.');
  const restored = JSON.parse(readFileSync(projectFile, 'utf8')) as Record<string, unknown>;
  expect(restored).not.toHaveProperty('workers.adapter');
  expect(restored).not.toHaveProperty('workers.max');
  await page.keyboard.press('Escape');
});

test('stays usable on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 900 });
  await openBoard(page);
  await expect(lead(page)).toBeInViewport();
  await shot(page, 'narrow', true);
});
