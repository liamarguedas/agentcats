// Renders the README banner (light and dark) and the GitHub social preview
// from the real cat cut-outs and the board's palette, so they stay in step
// with the product. Rerun after the art or the colors change:
//
//   node packages/ui/scripts/render-banner.mjs
//
// Writes docs/media/banner-light.png, banner-dark.png and social-preview.png.
// Needs the Playwright browser (see CONTRIBUTING.md).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const CATS = join(root, 'packages', 'ui', 'src', 'assets', 'cats');
const MEDIA = join(root, 'docs', 'media');

/** The board's tokens (styles.css), light and dark. */
const THEMES = {
  light: {
    bg: '#f7f5f0',
    grid: '#e4e0d6',
    floor: '#efe7d8',
    floorLine: '#e3d8c4',
    ink: '#26211b',
    ink2: '#6b6357',
    line: '#ddd7cb',
    accent: '#d9622b',
    board: '#ffffff',
  },
  dark: {
    bg: '#1b1916',
    grid: '#2a2622',
    floor: '#2a2520',
    floorLine: '#332d27',
    ink: '#f1ece3',
    ink2: '#a59d90',
    line: '#3a352f',
    accent: '#ef7a43',
    board: '#2f2b26',
  },
};

/** The lead at the whiteboard, then the team; each with its height in px. */
const LINEUP = [
  ['buff-cat', 1],
  ['tuxedo-lounge', 0.62],
  ['standing-kitten', 0.86],
  ['tabby-loaf', 0.72],
  ['grey-wonder', 0.82],
  ['scream', 0.76],
];

const dataUri = async (id) =>
  `data:image/webp;base64,${(await readFile(join(CATS, `${id}.webp`))).toString('base64')}`;

function page(theme, cats, { width, height }) {
  const t = THEMES[theme];
  const tall = height > 450;
  /** The lead's height; the others are a share of it. */
  const catSize = tall ? 192 : 190;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0; }
  body {
    width: ${width}px; height: ${height}px; overflow: hidden;
    font-family: 'Segoe UI', system-ui, -apple-system, Roboto, sans-serif;
    background:
      radial-gradient(${t.grid} 1.2px, transparent 1.2px) 0 0 / 22px 22px,
      ${t.bg};
    color: ${t.ink};
    display: grid; grid-template-columns: ${tall ? '1fr' : '470px 1fr'};
    align-items: center; padding: ${tall ? '56px 64px 0' : '0 0 0 64px'};
  }
  .mark { font-size: ${tall ? 104 : 84}px; font-weight: 800; letter-spacing: -0.04em; line-height: 1; }
  .mark span { color: ${t.accent}; }
  .tag { margin-top: 18px; font-size: ${tall ? 30 : 24}px; line-height: 1.35; color: ${t.ink2}; max-width: ${tall ? 1060 : 420}px; }
  .tag b { color: ${t.ink}; font-weight: 600; }
  .room {
    position: relative; align-self: end; height: ${tall ? 330 : 310}px;
    margin-top: ${tall ? 36 : 0}px;
    border: 1px solid ${t.line}; border-bottom: 0; border-radius: 18px 0 0 0;
    ${tall ? 'border-radius: 18px 18px 0 0;' : ''}
    background:
      linear-gradient(${t.floorLine} 1px, transparent 1px) 0 0 / 100% 40px,
      ${t.floor};
  }
  .wb {
    position: absolute; left: 26px; top: ${tall ? 22 : 20}px; width: 110px; height: 74px;
    border: 6px solid #8f8a80; border-radius: 6px; background: ${t.board};
  }
  .wb i { display: block; height: 4px; margin: 14px 14px 0; border-radius: 2px; background: #5b7fc4; }
  .wb i:nth-child(2) { width: 46%; margin-top: 9px; background: ${t.accent}; }
  .wb i:nth-child(3) { width: 64%; margin-top: 9px; }
  .cats {
    position: absolute; inset: 0; display: flex; align-items: flex-end;
    justify-content: space-between; padding: 0 ${tall ? 40 : 28}px ${tall ? 30 : 16}px 32px;
  }
  .cats img { display: block; min-width: 0; filter: drop-shadow(0 6px 6px rgb(0 0 0 / 18%)); }
</style></head><body>
  <div>
    <h1 class="mark">agent<span>cats</span></h1>
    <p class="tag">Your coding agents, as cats on a whiteboard. <b>Claude Code and Codex</b> work in parallel on their own branches; you approve and review.</p>
  </div>
  <div class="room">
    <div class="wb"><i></i><i></i><i></i></div>
    <div class="cats">${cats.map(([src, h]) => `<img src="${src}" style="height:${Math.round(h * catSize)}px" alt="">`).join('')}</div>
  </div>
</body></html>`;
}

const cats = await Promise.all(LINEUP.map(async ([id, h]) => [await dataUri(id), h]));
const browser = await chromium.launch();
try {
  const shots = [
    ['banner-light.png', 'light', { width: 1280, height: 360 }],
    ['banner-dark.png', 'dark', { width: 1280, height: 360 }],
    ['social-preview.png', 'light', { width: 1280, height: 640 }],
  ];
  for (const [file, theme, size] of shots) {
    const tab = await browser.newPage({ viewport: size, deviceScaleFactor: 1 });
    await tab.setContent(page(theme, cats, size));
    await tab.waitForFunction(() => [...globalThis.document.images].every((i) => i.complete));
    await tab.screenshot({ path: join(MEDIA, file) });
    await tab.close();
    console.log(`wrote docs/media/${file}`);
  }
} finally {
  await browser.close();
}
