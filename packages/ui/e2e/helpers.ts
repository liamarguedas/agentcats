import { expect, type Locator, type Page } from '@playwright/test';

import { E2E_TOKEN } from '../playwright.config.js';

export const SHOTS = 'test-results/screenshots';

export const shot = (page: Page, name: string, fullPage = false) =>
  page.screenshot({ path: `${SHOTS}/${name}.png`, animations: 'disabled', fullPage });

/** Open the board with the token from the link, at `base` (the main mock daemon by default). */
export async function openBoard(page: Page, base = '') {
  await page.goto(`${base}/#token=${E2E_TOKEN}`);
  await expect(page.getByTestId('connection')).toHaveText('Live');
}

/** Open a panel on the right (Chat, Tasks or Events), if it is not open already. */
export async function showPanel(page: Page, name: 'Chat' | 'Tasks' | 'Events') {
  const tab = page.getByRole('tab', { name: new RegExp(`^${name}`) });
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
}

export async function chatPanel(page: Page) {
  await showPanel(page, 'Chat');
  return page.getByRole('region', { name: 'Chat' });
}

export async function chat(page: Page, text: string) {
  await showPanel(page, 'Chat');
  const input = page.getByLabel('Task for the cat');
  await expect(input).toBeEnabled({ timeout: 15_000 });
  await input.fill(text);
  await input.press('Enter');
}

export async function tasks(page: Page) {
  await showPanel(page, 'Tasks');
  return page.getByRole('region', { name: 'Tasks' });
}

/**
 * The part of the canvas no panel covers, in page px: what floats over the
 * cats must stay inside it.
 */
export async function visibleCanvas(page: Page) {
  const canvas = (await page.locator('.canvas__viewport').boundingBox())!;
  let left = canvas.x;
  let right = canvas.x + canvas.width;
  let bottom = canvas.y + canvas.height;
  for (const panel of await page.locator('.dock__panel:visible, .drawer').all()) {
    const box = (await panel.boundingBox())!;
    // A bottom sheet spans the width; a side panel sits left or right of the middle.
    if (box.width > canvas.width * 0.6) bottom = Math.min(bottom, box.y);
    else if (box.x + box.width / 2 > canvas.x + canvas.width / 2) right = Math.min(right, box.x);
    else left = Math.max(left, box.x + box.width);
  }
  return { left, top: canvas.y, right, bottom };
}

/** Expect the element to be entirely inside the visible canvas (within 5 s). */
export async function expectInView(page: Page, locator: Locator) {
  const inside = async () => {
    const box = (await locator.boundingBox())!;
    const area = await visibleCanvas(page);
    const ok =
      box.x >= area.left - 0.5 &&
      box.y >= area.top - 0.5 &&
      box.x + box.width <= area.right + 0.5 &&
      box.y + box.height <= area.bottom + 0.5;
    return { ok, box, area };
  };
  const end = Date.now() + 5_000;
  let last = await inside();
  while (!last.ok && Date.now() < end) {
    await page.waitForTimeout(100);
    last = await inside();
  }
  expect(
    last.ok,
    `${String(locator)} at ${JSON.stringify(last.box)}, visible canvas ${JSON.stringify(last.area)}`,
  ).toBe(true);
}
