// Records the README's demo GIF from the real `agentcats --demo`: the
// scripted cats, plus what a person would do (answer the approval, look at a
// cat, open the cost meter). Run after building the UI:
//
//   pnpm -F @agentcats/ui build && node packages/ui/scripts/record-demo.mjs
//
// Writes docs/media/demo.gif. Needs the Playwright browser (see CONTRIBUTING.md).
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';
import gifenc from 'gifenc';
import { PNG } from 'pngjs';

const { GIFEncoder, quantize, applyPalette } = gifenc;

const root = fileURLToPath(new URL('../../..', import.meta.url));
const OUT = join(root, 'docs', 'media', 'demo.gif');
const VIEW = { width: 1280, height: 720 };
const SCALE = 0.625; // 800 x 450 in the GIF
const FRAME_MS = 250;
const LENGTH_MS = 60_000;

const daemon = spawn(
  process.execPath,
  [
    '--conditions=@agentcats/source',
    '--import',
    'tsx',
    'packages/cli/src/bin.ts',
    '--demo',
    '--no-open',
  ],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
);
let output = '';
daemon.stdout.on('data', (chunk) => (output += chunk));
const url = await new Promise((resolve, reject) => {
  const timer = setInterval(() => {
    const match = /Board: (\S+)/.exec(output);
    if (match) {
      clearInterval(timer);
      resolve(match[1]);
    }
  }, 100);
  setTimeout(() => reject(new Error(`no board URL:\n${output}`)), 60_000);
});

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: VIEW, colorScheme: 'light' });
await page.goto(url);
await page.getByTestId('connection').filter({ hasText: 'Live' }).waitFor();

// Frames, captured on a fixed clock while the script below plays.
const frames = [];
const started = Date.now();
let capturing = true;
const capture = (async () => {
  while (capturing && Date.now() - started < LENGTH_MS) {
    const next = Date.now() + FRAME_MS;
    frames.push({ at: Date.now(), png: await page.screenshot({ type: 'png' }) });
    await new Promise((r) => setTimeout(r, Math.max(0, next - Date.now())));
  }
})();

const pause = (ms) => page.waitForTimeout(ms);
// A person answers the network approval after reading it.
const bubble = page.getByRole('alertdialog', { name: /Approval request from/ });
await bubble.waitFor({ timeout: 45_000 });
await pause(2_500);
await bubble.getByRole('button', { name: 'Allow' }).click();
// The failing migration: its caption shows; then a look at a cat and at the spend.
await page.locator('.meme-caption').first().waitFor({ timeout: 45_000 });
await pause(4_000);
await page.getByRole('button', { name: 'Tux: open details' }).hover();
await pause(3_000);
await page.mouse.move(5, 5);
await page.getByRole('button', { name: /Team spend/ }).click();
await pause(4_000);
await page.keyboard.press('Escape');
await pause(2_000);
capturing = false;
await capture;
await browser.close();
daemon.kill('SIGINT');

/** Box-filter downscale of an RGBA image. */
function downscale(png) {
  const w = Math.round(png.width * SCALE);
  const h = Math.round(png.height * SCALE);
  const out = new Uint8Array(w * h * 4);
  const step = 1 / SCALE;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sum = [0, 0, 0];
      let n = 0;
      for (
        let sy = Math.floor(y * step);
        sy < Math.min(png.height, Math.floor((y + 1) * step));
        sy++
      ) {
        for (
          let sx = Math.floor(x * step);
          sx < Math.min(png.width, Math.floor((x + 1) * step));
          sx++
        ) {
          const i = (sy * png.width + sx) * 4;
          sum[0] += png.data[i];
          sum[1] += png.data[i + 1];
          sum[2] += png.data[i + 2];
          n++;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = sum[0] / n;
      out[o + 1] = sum[1] / n;
      out[o + 2] = sum[2] / n;
      out[o + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}

const gif = GIFEncoder();
// Each frame shows until the next was taken, so the GIF plays in real time;
// identical frames merge into one.
let pending = null;
const flush = (until) => {
  if (!pending) return;
  const palette = quantize(pending.image.data, 256);
  gif.writeFrame(
    applyPalette(pending.image.data, palette),
    pending.image.width,
    pending.image.height,
    {
      palette,
      delay: Math.max(20, until - pending.at),
    },
  );
};
for (const frame of frames) {
  const image = downscale(PNG.sync.read(frame.png));
  if (pending && Buffer.compare(Buffer.from(pending.image.data), Buffer.from(image.data)) === 0)
    continue;
  flush(frame.at);
  pending = { at: frame.at, image };
}
flush((pending?.at ?? 0) + 2_000);
const stills = process.env['DEMO_STILLS'];
if (stills) {
  for (const share of [0.15, 0.35, 0.55, 0.75, 0.95]) {
    const frame = frames[Math.floor(frames.length * share)];
    if (frame) await writeFile(join(stills, `still-${String(share * 100)}.png`), frame.png);
  }
}
gif.finish();
await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, gif.bytes());
console.log(`${String(frames.length)} frames, ${(gif.bytes().length / 1e6).toFixed(1)} MB: ${OUT}`);
process.exit(0);
