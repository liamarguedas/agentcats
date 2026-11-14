// M6 Step 0: stage a team on the mock daemon, take screenshots of the board
// and measure frame times while panning and zooming with cats walking.
//
//   node packages/ui/scripts/canvas-spike.mjs <out-dir> [label]
//
// Needs a built UI in packages/ui/dist (pnpm -F @agentcats/ui build). Writes
// <label>-<cats>-<width>x<height>.png and <label>-frames.json into <out-dir>.
/* global window, document, requestAnimationFrame, cancelAnimationFrame */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

const ui = fileURLToPath(new URL('..', import.meta.url));
const out = process.argv[2] ?? join(tmpdir(), 'canvas-spike');
const label = process.argv[3] ?? 'canvas';
const PORT = 4620;
const TOKEN = 'spike-token-0123456789abcdefghijklmnopqrstuvwxyz';
const BASE = `http://127.0.0.1:${String(PORT)}`;
const SIZES = [
  [1280, 800],
  [1920, 1080],
];

await mkdir(out, { recursive: true });

function startDaemon() {
  const child = spawn(
    process.execPath,
    ['--conditions=@agentcats/source', '--import', 'tsx', 'scripts/mock-daemon.ts'],
    {
      cwd: ui,
      env: {
        ...process.env,
        AGENTCATS_PORT: String(PORT),
        AGENTCATS_TOKEN: TOKEN,
        AGENTCATS_UI_DIR: 'dist',
        AGENTCATS_MAX_WORKERS: '16',
        AGENTCATS_HOME: join(tmpdir(), 'agentcats-spike-home'),
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  );
  return new Promise((resolve) => {
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('Built UI')) resolve(child);
    });
  });
}

const api = async (method, path, body) => {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    ...(body && { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${String(res.status)} ${await res.text()}`);
  return res.json();
};
const workers = async () =>
  Object.values((await api('GET', '/snapshot')).board.cats).filter(
    (c) => c.role === 'worker' && !c.retiredAt,
  );
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what, timeout = 60_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(250);
  }
  const snap = await api('GET', '/snapshot');
  console.error(
    JSON.stringify(
      {
        cats: Object.values(snap.board.cats).map((c) => [c.name, c.role, c.status]),
        tasks: Object.values(snap.board.tasks).map((t) => [t.title, t.status, t.assigneeCatId]),
        notices: snap.events.filter((e) => e.type === 'notice').map((e) => e.payload.message),
      },
      null,
      1,
    ),
  );
  throw new Error(`Timed out waiting for ${what}`);
}

/** Hire `busy` more cats that keep working and `asking` more that wait for an approval. */
async function staff(busy, asking) {
  const start = (await workers()).length;
  for (let i = 0; i < busy + asking; i++) {
    const ask = i >= busy;
    await until(async () => {
      const cats = Object.values((await api('GET', '/snapshot')).board.cats);
      const lead = cats.find((c) => c.role === 'orchestrator');
      return !lead || ['idle', 'done'].includes(lead.status);
    }, 'the lead');
    await api('POST', '/chat', {
      text: `Part ${String(start + i + 1)}
/single
/${ask ? 'approval' : 'hang'}`,
    });
    await until(
      async () => (await workers()).length > start + i,
      `worker ${String(start + i + 1)}`,
    );
  }
  await until(async () => {
    const team = await workers();
    return team.every((c) => ['working', 'thinking', 'waiting_approval'].includes(c.status));
  }, 'the team to settle');
}

const daemon = await startDaemon();
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(`${BASE}/#token=${TOKEN}`);
  await page.getByTestId('connection').filter({ hasText: 'Live' }).waitFor();

  for (const [cats, busy, asking] of [
    [3, 1, 1],
    [12, 7, 2],
  ]) {
    await staff(busy, asking);
    await sleep(1500);
    for (const [width, height] of SIZES) {
      await page.setViewportSize({ width, height });
      await page.reload();
      await page.getByTestId('connection').filter({ hasText: 'Live' }).waitFor();
      await sleep(1200);
      await page.screenshot({
        path: join(out, `${label}-${String(cats)}-${String(width)}x${String(height)}.png`),
      });
    }
  }

  if (process.argv[4] === 'shots-only') process.exit(0);
  // 16 cats: the lead and 15 workers, then cats walk while the view moves.
  await staff(3, 1);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.reload();
  await page.getByTestId('connection').filter({ hasText: 'Live' }).waitFor();
  await sleep(1500);
  const cdp = await page.context().newCDPSession(page);
  const results = {};
  const VARIANTS = [
    ['as-is', 1, ''],
    ['as-is', 4, ''],
    [
      'no-shadows',
      4,
      '.cat-photo__img, .office__desk, .office__table { filter: none !important; box-shadow: none !important; }',
    ],
    ['no-counter-scale', 4, '.bubble, .cat-card__meta { scale: 1 !important; }'],
  ];
  for (const [variant, throttle, css] of VARIANTS) {
    await page.getByRole('button', { name: 'Fit' }).click();
    await sleep(400);
    const style = css ? await page.addStyleTag({ content: css }) : null;
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
    await page.evaluate(() => {
      window.__frames = [];
      let last = performance.now();
      const tick = (now) => {
        window.__frames.push(now - last);
        last = now;
        if (window.__frames.length < 100_000) window.__rafId = requestAnimationFrame(tick);
      };
      window.__rafId = requestAnimationFrame(tick);
    });
    // Cats walk: every second, half of them slide 300 px and back, with the
    // office's own transition and walk cycle. Done in the page, so it costs
    // no agent turns and is the same on every run.
    await page.evaluate(() => {
      let flip = false;
      window.__walk = setInterval(() => {
        flip = !flip;
        document.querySelectorAll('.office__cat').forEach((el, i) => {
          if (i % 2 === 0) return;
          el.classList.toggle('office__cat--walking', true);
          el.style.translate = flip ? '300px 0' : '0 0';
          el.style.transition = 'translate 900ms cubic-bezier(0.45, 0, 0.25, 1)';
        });
      }, 1000);
    });
    const box = page.locator('.canvas__viewport');
    const { x, y, width, height } = await box.boundingBox();
    const empty = { x: x + 30, y: y + height - 80 };
    for (let round = 0; round < 3; round++) {
      await page.mouse.move(empty.x, empty.y);
      await page.mouse.down();
      for (let i = 0; i < 60; i++) await page.mouse.move(empty.x + i * 6, empty.y - i * 3);
      await page.mouse.up();
      await page.mouse.move(x + width / 3, y + height / 2);
      await page.keyboard.down('Control');
      for (let i = 0; i < 12; i++) await page.mouse.wheel(0, i < 6 ? -100 : 100);
      await page.keyboard.up('Control');
      for (let i = 0; i < 20; i++) await page.mouse.wheel(0, 40);
    }
    const frames = await page.evaluate(() => {
      clearInterval(window.__walk);
      cancelAnimationFrame(window.__rafId);
      return window.__frames.slice(1);
    });
    const sorted = [...frames].sort((a, b) => a - b);
    const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
    await style?.evaluate((el) => el.remove());
    results[`${variant}-cpu-x${String(throttle)}`] = {
      frames: frames.length,
      p50: pct(50),
      p95: pct(95),
      p99: pct(99),
      max: sorted.at(-1),
      // At 60 Hz a frame is 16.7 ms; anything over 20 ms is a dropped frame.
      dropped: frames.filter((f) => f > 20).length,
    };
  }
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await page.getByRole('button', { name: 'Fit' }).click();
  await sleep(500);
  await page.screenshot({ path: join(out, `${label}-16-1280x800.png`) });
  await writeFile(join(out, `${label}-frames.json`), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
  daemon.kill();
}
