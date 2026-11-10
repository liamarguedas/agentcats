import { expect, type Page, test } from '@playwright/test';

import { E2E_TOKEN } from '../playwright.config.js';

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
  await chat(page, 'Add a login endpoint and write tests for it');
  await expect(page.getByRole('region', { name: 'Chat' })).toContainText('Add a login endpoint');

  const workers = page.getByRole('region', { name: 'Workers' }).locator('.seat');
  await expect(workers).toHaveCount(2, { timeout: 15_000 });
  await expect(page.getByTestId('cat-Mochi').getByTestId('cat-status')).toHaveText(
    /Thinking|Working/,
  );
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

test('a crashing worker is retried once, then failed, and can be re-run', async ({ page }) => {
  await openBoard(page);
  await chat(page, 'Build the thing\n/single\n/crash');
  const card = tasks(page).locator('.task-card', { hasText: 'Build the thing' });
  await expect(card.locator('.chip')).toHaveText('Failed', { timeout: 20_000 });
  await expect(card).toContainText('attempt 2');
  await shot(page, 'failed');

  await card.click();
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Re-run' })).toBeVisible();
  await page.keyboard.press('Escape');
});

test('cat properties can be edited', async ({ page }) => {
  await openBoard(page);
  await page.getByRole('button', { name: 'Properties of Mochi' }).click();
  const drawer = page.getByRole('dialog');
  await expect(drawer).toContainText('Worker: edits in its own worktree');
  await drawer.getByLabel('Budget ($)').fill('5');
  await drawer.getByRole('button', { name: 'Save' }).click();
  await expect(drawer.getByRole('status')).toHaveText('Saved');
  await shot(page, 'properties');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('cat-Mochi')).toContainText('/ $5.00');
});

test('the board resyncs after a reload', async ({ page }) => {
  await openBoard(page);
  await page.reload();
  await expect(page.getByTestId('connection')).toHaveText('Live');
  await expect(tasks(page)).toContainText('Build the thing');
  await expect(page.getByRole('region', { name: 'Chat' })).toContainText('Add a login endpoint');
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
  await expect(lead(page)).toBeInViewport();
  await shot(page, 'narrow', true);
});
