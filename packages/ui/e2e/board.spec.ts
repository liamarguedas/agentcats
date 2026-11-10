import { expect, type Page, test } from '@playwright/test';

import { E2E_TOKEN } from '../playwright.config.js';

const SHOTS = 'test-results/screenshots';

async function openBoard(page: Page) {
  await page.goto(`/#token=${E2E_TOKEN}`);
  await expect(page.getByTestId('connection')).toHaveText('Live');
}

async function prompt(page: Page, text: string) {
  const input = page.getByLabel('Task for the cat');
  await expect(input).toBeEnabled();
  await input.fill(text);
  await input.press('Enter');
}

const status = (page: Page) => page.getByTestId('cat-status');

test.describe.configure({ mode: 'serial' });

test('connects with the token from the link and removes it from the address bar', async ({
  page,
}) => {
  await openBoard(page);
  expect(new URL(page.url()).hash).toBe('');
  await expect(page.getByRole('heading', { name: 'Mochi' })).toBeVisible();
  await expect(status(page)).toHaveText('Idle');
  await page.screenshot({ path: `${SHOTS}/idle.png`, animations: 'disabled' });
});

test('the cat thinks, works and finishes a task', async ({ page }) => {
  await openBoard(page);
  await prompt(page, 'add a hello function');

  await expect(status(page)).toHaveText('Thinking');
  await expect(page.getByTestId('bubble')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/thinking.png`, animations: 'disabled' });
  await expect(status(page)).toHaveText('Working');
  await page.screenshot({ path: `${SHOTS}/working.png`, animations: 'disabled' });
  await expect(status(page)).toHaveText('Done', { timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/done.png`, animations: 'disabled' });

  await expect(page.getByRole('region', { name: 'Tasks' })).toContainText('add a hello function');
  await expect(page.getByRole('region', { name: 'Event log' })).toContainText('tool.called');
});

test('an approval request shows a bubble, and Allow resumes the cat', async ({ page }) => {
  await openBoard(page);
  await prompt(page, '/approval add hello and run the tests');

  const bubble = page.getByRole('alertdialog', { name: 'Approval request' });
  await expect(bubble).toBeVisible({ timeout: 15_000 });
  await expect(bubble).toContainText('Bash');
  await expect(bubble).toContainText('npm test');
  await expect(status(page)).toHaveText('Needs your approval');
  await page.screenshot({ path: `${SHOTS}/approval.png`, animations: 'disabled' });

  await bubble.getByRole('button', { name: 'Allow' }).click();
  await expect(bubble).toBeHidden();
  await expect(status(page)).toHaveText('Done', { timeout: 15_000 });
});

test('an error turn renders the error state', async ({ page }) => {
  await openBoard(page);
  await prompt(page, '/error build it');

  await expect(status(page)).toHaveText('Error', { timeout: 15_000 });
  await expect(page.getByRole('alert')).toContainText('Build failed');
  await page.screenshot({ path: `${SHOTS}/error.png`, animations: 'disabled' });
});

test('the board resyncs after a reload', async ({ page }) => {
  await openBoard(page);
  await page.reload();
  await expect(page.getByTestId('connection')).toHaveText('Live');
  await expect(page.getByRole('region', { name: 'Tasks' })).toContainText('add a hello function');
});

test('without a token it explains how to open the board', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Open the board from the link printed by')).toBeVisible();
});

test('a wrong token is reported', async ({ page }) => {
  await page.goto('/#token=wrong-token-wrong-token-wrong-token-xxxxxxx');
  await expect(page.getByTestId('connection')).toHaveText('Token rejected');
});

test('stays usable on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 900 });
  await openBoard(page);
  await expect(page.getByRole('heading', { name: 'Mochi' })).toBeInViewport();
  await page.screenshot({ path: `${SHOTS}/narrow.png`, fullPage: true, animations: 'disabled' });
});
