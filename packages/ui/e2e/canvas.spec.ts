import { expect, type Page, test } from '@playwright/test';

import { CANVAS_PORT, E2E_TOKEN } from '../playwright.config.js';
import { expectInView, openBoard, shot, showPanel, visibleCanvas } from './helpers.js';

// A big team on the canvas, on a mock daemon of its own (up to 16 workers).
const BASE = `http://127.0.0.1:${String(CANVAS_PORT)}`;

interface CatView {
  readonly name: string;
  readonly role: string;
  readonly status: string;
}

async function api(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${E2E_TOKEN}`, 'Content-Type': 'application/json' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${path}: ${String(response.status)}`);
  return response.json();
}

const cats = async () =>
  Object.values(
    ((await api('GET', '/snapshot')) as { board: { cats: Record<string, CatView> } }).board.cats,
  );

/** Hire `busy` more cats that keep working at their desks and `asking` more that wait for an approval. */
async function staff(busy: number, asking: number) {
  const start = (await cats()).filter((c) => c.role === 'worker').length;
  for (let i = 0; i < busy + asking; i++) {
    // The lead takes one request at a time.
    await expect
      .poll(async () => (await cats()).find((c) => c.role === 'orchestrator')?.status, {
        timeout: 30_000,
      })
      .toMatch(/idle|done/);
    await api('POST', '/chat', {
      text: `Part ${String(start + i + 1)}\n/single\n/${i < busy ? 'hang' : 'approval'}`,
    });
    await expect
      .poll(async () => (await cats()).filter((c) => c.role === 'worker').length, {
        timeout: 30_000,
      })
      .toBe(start + i + 1);
  }
  await expect
    .poll(
      async () =>
        (await cats())
          .filter((c) => c.role === 'worker')
          .every((c) => ['working', 'thinking', 'waiting_approval'].includes(c.status)),
      { timeout: 30_000 },
    )
    .toBe(true);
}

const photo = (page: Page, name: string) =>
  page.getByRole('button', { name: `${name}: open details`, exact: true });
const zoomLabel = (page: Page) => page.getByTestId('zoom');

/** Zoom with the buttons to the minimum or the maximum. */
async function zoomTo(page: Page, limit: 'min' | 'max') {
  const button = page.getByRole('button', { name: limit === 'min' ? 'Zoom out' : 'Zoom in' });
  for (let i = 0; i < 12; i++) await button.click();
  await expect(zoomLabel(page)).toHaveText(limit === 'min' ? '30%' : '200%');
}

/** Give the first cat focus from the keyboard, so focus follows it into view. */
async function focusFirstCat(page: Page) {
  const first = page.getByRole('group', { name: 'Cats' }).getByRole('button').first();
  await first.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(first).toBeFocused();
}

const focusedCat = (page: Page) =>
  page.evaluate(() =>
    (document.activeElement?.getAttribute('aria-label') ?? '').replace(': open details', ''),
  );

test.describe.configure({ mode: 'serial' });

test('Needs you brings the cats waiting for you into view, and N steps through them', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await staff(8, 3);
  await openBoard(page, BASE);
  await expect(page.getByRole('group', { name: 'Cats' }).getByRole('button')).toHaveCount(12);
  const needsYou = page.getByRole('button', { name: /^Needs you/ });
  await expect(needsYou).toHaveText('Needs you 3');
  const asking = (await cats()).filter((c) => c.status === 'waiting_approval').map((c) => c.name);
  expect(asking).toHaveLength(3);

  // Close in on the middle: some of the cats that need you are out of view, with markers at the edge.
  await zoomTo(page, 'max');
  const markers = page.locator('.edge-marker:visible');
  await expect(markers).not.toHaveCount(0);
  for (const marker of await markers.all()) await expectInView(page, marker);
  await shot(page, 'edge-markers');

  await needsYou.click();
  for (const name of asking) await expectInView(page, photo(page, name));
  await expect(markers).toHaveCount(0);
  await shot(page, 'needs-you');

  // N: one cat at a time, in view and with focus, so A and D answer it.
  await zoomTo(page, 'max');
  const seen = new Set<string>();
  for (let i = 0; i < asking.length; i++) {
    await page.locator('body').press('n');
    const name = await focusedCat(page);
    expect(asking).toContain(name);
    seen.add(name);
    await expectInView(page, photo(page, name));
    await expectInView(
      page,
      page.getByRole('alertdialog', { name: `Approval request from ${name}` }),
    );
  }
  expect(seen.size).toBe(asking.length);
});

test('an edge marker brings its cat into view', async ({ page }) => {
  await openBoard(page, BASE);
  await zoomTo(page, 'max');
  const marker = page.locator('.edge-marker:visible').first();
  const name = ((await marker.textContent()) ?? '').replace(' needs you', '');
  await marker.click();
  await expectInView(page, photo(page, name));
});

for (const limit of ['min', 'max'] as const) {
  test(`at ${limit} zoom, with a panel open, every cat's card and bubble stay in view`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1280, height: 680 });
    await openBoard(page, BASE);
    await showPanel(page, 'Chat');
    await zoomTo(page, limit);
    await focusFirstCat(page);
    const count = await page.getByRole('group', { name: 'Cats' }).getByRole('button').count();
    for (let i = 0; i < count; i++) {
      if (i > 0) await page.keyboard.press('Tab');
      const name = await focusedCat(page);
      // Focus follows the cat into view, and opens its card there.
      await expectInView(page, photo(page, name));
      const card = page.getByTestId(`cat-${name}`).locator('.cat-card__meta');
      await expect(card).toBeVisible();
      await expectInView(page, card);
      const bubble = page.getByRole('alertdialog', { name: `Approval request from ${name}` });
      if (limit === 'max' && (await bubble.isVisible())) await expectInView(page, bubble);
    }
    await shot(page, `zoom-${limit}`);
  });
}

test('16 cats stand apart, and Fit shows them all', async ({ page }) => {
  test.setTimeout(120_000);
  await staff(3, 1);
  for (const [width, height] of [
    [1280, 800],
    [1920, 1080],
  ] as const) {
    await page.setViewportSize({ width, height });
    await openBoard(page, BASE);
    await page.getByRole('button', { name: 'Fit' }).click();
    await expect(page.getByRole('group', { name: 'Cats' }).locator('.cat-photo')).toHaveCount(16);
    const area = await visibleCanvas(page);
    // Measured once nothing moves: no cat walking, the view settled.
    await expect
      .poll(
        () =>
          page.evaluate((area) => {
            const problems: string[] = [];
            const boxes = (selector: string, name: (el: Element) => string) =>
              [...document.querySelectorAll(selector)].map((el) => ({
                name: name(el),
                box: el.getBoundingClientRect(),
              }));
            const cats = boxes('.cat-token', (el) => el.getAttribute('data-cat') ?? '?');
            for (const walking of document.querySelectorAll('.office__cat--walking')) {
              const name = walking.querySelector('.cat-token')?.getAttribute('data-cat') ?? '?';
              problems.push(`${name} is walking to ${walking.getAttribute('data-area') ?? '?'}`);
            }
            const apart = (a: DOMRect, b: DOMRect) =>
              a.right <= b.left + 0.5 ||
              b.right <= a.left + 0.5 ||
              a.bottom <= b.top + 0.5 ||
              b.bottom <= a.top + 0.5;
            for (const [i, a] of cats.entries()) {
              const b = a.box;
              if (
                b.left < area.left ||
                b.right > area.right ||
                b.top < area.top ||
                b.bottom > area.bottom
              )
                problems.push(`${a.name} out of view`);
              for (const other of cats.slice(i + 1)) {
                if (!apart(b, other.box)) problems.push(`${a.name} overlaps ${other.name}`);
              }
            }
            // The zones, the desks and the tables do not overlap either.
            for (const selector of ['.office__area', '.office__desk', '.office__table']) {
              const parts = boxes(selector, (el) => el.className);
              for (const [i, a] of parts.entries()) {
                for (const b of parts.slice(i + 1)) {
                  if (!apart(a.box, b.box)) problems.push(`${a.name} overlaps ${b.name}`);
                }
              }
            }
            return problems;
          }, area),
        { timeout: 10_000 },
      )
      .toEqual([]);
    await page.waitForTimeout(1500);
    await shot(page, `team-of-16-${String(width)}x${String(height)}`);
  }
});

test('panning and zooming with 16 cats walking keeps frames on time', async ({ page }) => {
  test.setTimeout(90_000);
  await openBoard(page, BASE);
  await page.getByRole('button', { name: 'Fit' }).click();
  // Half the cats walk 300 px and back every second, with their names and bubbles.
  await page.evaluate(() => {
    const w = window as unknown as { frames: number[]; walk: number; raf: number };
    w.frames = [];
    let flip = false;
    w.walk = window.setInterval(() => {
      flip = !flip;
      const anchors = document.querySelectorAll<HTMLElement>('.anchor');
      document.querySelectorAll<HTMLElement>('.office__cat').forEach((cat, i) => {
        if (i % 2 === 0) return;
        cat.style.transition = 'translate 900ms ease-in-out';
        cat.style.translate = flip ? '300px 0' : '0 0';
        const anchor = anchors[i];
        if (!anchor) return;
        anchor.dataset['x'] ??= anchor.style.getPropertyValue('--wx');
        anchor.style.setProperty('--wx', String(Number(anchor.dataset['x']) + (flip ? 300 : 0)));
      });
    }, 1000);
    let last = performance.now();
    const tick = (now: number) => {
      w.frames.push(now - last);
      last = now;
      w.raf = requestAnimationFrame(tick);
    };
    w.raf = requestAnimationFrame(tick);
  });
  const view = (await page.locator('.canvas__viewport').boundingBox())!;
  const floor = { x: view.x + 20, y: view.y + view.height - 40 };
  for (let round = 0; round < 3; round++) {
    await page.mouse.move(floor.x, floor.y);
    await page.mouse.down();
    for (let i = 0; i < 40; i++) await page.mouse.move(floor.x + i * 6, floor.y - i * 3);
    await page.mouse.up();
    await page.mouse.move(view.x + view.width / 3, view.y + view.height / 2);
    await page.keyboard.down('Control');
    for (let i = 0; i < 10; i++) await page.mouse.wheel(0, i < 5 ? -100 : 100);
    await page.keyboard.up('Control');
    for (let i = 0; i < 15; i++) await page.mouse.wheel(0, 40);
  }
  const frames = await page.evaluate(() => {
    const w = window as unknown as { frames: number[]; walk: number; raf: number };
    clearInterval(w.walk);
    cancelAnimationFrame(w.raf);
    return w.frames.slice(1);
  });
  const sorted = [...frames].sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? Infinity;
  // At 60 Hz a frame is 16.7 ms; over 20 ms, one was dropped.
  const dropped = frames.filter((f) => f > 20).length / frames.length;
  console.log(
    `frames: ${String(frames.length)}, p95 ${p95.toFixed(1)} ms, dropped ${(dropped * 100).toFixed(1)}%`,
  );
  expect(frames.length).toBeGreaterThan(100);
  expect(p95).toBeLessThanOrEqual(17);
  expect(dropped).toBeLessThan(0.05);
});

test('the board works from the keyboard: Enter opens a cat, P pauses and resumes it', async ({
  page,
}) => {
  await openBoard(page, BASE);
  const busy = (await cats()).find((c) => c.role === 'worker' && c.status === 'working');
  expect(busy).toBeDefined();
  const name = busy!.name;
  await photo(page, name).focus();
  await page.keyboard.press('p');
  await expect(page.getByTestId(`cat-${name}`).getByTestId('cat-status')).toHaveText('Paused');
  await page.keyboard.press('p');
  // Resumed: the mock finishes its task quickly, so it may already be done.
  await expect(page.getByTestId(`cat-${name}`).getByTestId('cat-status')).not.toHaveText('Paused');
  // It walked to the table and back; once there, it stops walking.
  await expect(page.locator('.office__cat--walking')).toHaveCount(0, { timeout: 3_000 });
  await page.keyboard.press('Enter');
  const details = page.getByRole('dialog', { name: new RegExp(`^${name}`) });
  await expect(details).toBeVisible();
  // A panel beside the canvas: the cats are still there to use.
  await expect(photo(page, 'Tux')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(details).toBeHidden();
});

test('panels open and collapse, and the board remembers them and the view', async ({ page }) => {
  await openBoard(page, BASE);
  const chatTab = page.getByRole('tab', { name: 'Chat' });
  await expect(chatTab).toHaveAttribute('aria-selected', 'true');
  await chatTab.click();
  await expect(page.locator('.dock__panel:visible')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('connection')).toHaveText('Live');
  await expect(page.locator('.dock__panel:visible')).toHaveCount(0);
  await showPanel(page, 'Tasks');
  await page.reload();
  await expect(page.getByRole('region', { name: 'Tasks' })).toBeVisible();

  // The view: kept across a reload until Fit.
  await page.getByRole('button', { name: 'Fit' }).click();
  await page.waitForTimeout(800);
  const fitted = await zoomLabel(page).textContent();
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await page.getByRole('button', { name: 'Zoom in' }).click();
  // Once the zoom settles, the view is saved.
  await page.waitForTimeout(800);
  const zoomed = await zoomLabel(page).textContent();
  expect(zoomed).not.toBe(fitted);
  await page.reload();
  await expect(zoomLabel(page)).toHaveText(zoomed!);
  await page.locator('.canvas__viewport').press('f');
  await expect(zoomLabel(page)).toHaveText(fitted!);

  // Ctrl or Cmd with + and - zoom the canvas, not the page; with 0, fit it.
  const percent = async () => Number((await zoomLabel(page).textContent())?.replace('%', ''));
  await page.locator('body').press('Control+Equal');
  await expect.poll(percent).toBeGreaterThan(Number(fitted!.replace('%', '')));
  await page.locator('body').press('Control+Minus');
  await page.locator('body').press('Control+Minus');
  await expect.poll(percent).toBeLessThan(Number(fitted!.replace('%', '')));
  expect(await page.evaluate(() => window.devicePixelRatio)).toBe(1);
  await page.locator('body').press('Control+0');
  await expect(zoomLabel(page)).toHaveText(fitted!);

  // Ctrl and the wheel over the canvas zoom it about the pointer, not the page.
  const view = (await page.locator('.canvas__viewport').boundingBox())!;
  await page.mouse.move(view.x + view.width / 3, view.y + view.height / 2);
  await page.waitForTimeout(400); // Fit's animation ends
  // Without Ctrl the wheel pans: the cats move, the zoom stays.
  const tux = async () =>
    (await page.getByRole('button', { name: 'Tux: open details' }).boundingBox())!.y;
  const before = await tux();
  await page.mouse.wheel(0, 200);
  await expect.poll(tux).toBeLessThan(before - 50);
  await expect(zoomLabel(page)).toHaveText(fitted!);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -300);
  await page.keyboard.up('Control');
  await expect.poll(percent).toBeGreaterThan(Number(fitted!.replace('%', '')));
  expect(await page.evaluate(() => window.devicePixelRatio)).toBe(1);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, 600);
  await page.keyboard.up('Control');
  await expect.poll(percent).toBeLessThan(Number(fitted!.replace('%', '')));
  expect(await page.evaluate(() => window.devicePixelRatio)).toBe(1);
  await page.locator('body').press('Control+0');
  await expect(zoomLabel(page)).toHaveText(fitted!);
  await page.waitForTimeout(800);
  await page.reload();
  await expect(zoomLabel(page)).toHaveText(fitted!);
});

test('on a narrow touch screen, panels are bottom sheets and cats open with a tap', async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 400, height: 800 },
    hasTouch: true,
  });
  const page = await context.newPage();
  await openBoard(page, BASE);
  await showPanel(page, 'Chat');
  const sheet = (await page.locator('.dock__panel:visible').boundingBox())!;
  expect(sheet.width).toBeGreaterThan(360);
  expect(sheet.y).toBeGreaterThan(300);
  // Fit frames the team above the sheet.
  await page.getByRole('button', { name: 'Fit' }).tap();
  await expectInView(page, photo(page, 'Tux'));
  await photo(page, 'Tux').tap();
  const details = page.getByRole('dialog', { name: /^Tux/ });
  await expect(details).toBeVisible();
  const box = (await details.boundingBox())!;
  expect(box.width).toBeGreaterThan(360);
  expect(box.y).toBeGreaterThan(300);
  await shot(page, 'narrow-touch');
  await context.close();
});
