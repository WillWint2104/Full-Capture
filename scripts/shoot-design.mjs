// Screenshots a static UI design in every state, theme and viewport so
// designs can be compared side by side.
//   node scripts/shoot-design.mjs design/<name>/index.html [--all]
// The page must honour ?state=<state>&theme=<light|dark> (a demo script sets
// up fake content for each state). PNGs go to design/<name>/shots/.
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const file = process.argv[2];
if (!file) { console.error('usage: node scripts/shoot-design.mjs <page.html> [--all]'); process.exit(1); }
const all = process.argv.includes('--all');
const page = path.resolve(file);
const outDir = path.join(path.dirname(page), 'shots');
await mkdir(outDir, { recursive: true });

export const STATES = ['setup', 'ready', 'soundcheck', 'recording', 'review', 'library', 'popout'];
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

// The default set is what judges look at; --all adds every combination.
const shots = all
  ? STATES.flatMap(s => ['light', 'dark'].flatMap(t => [[s, t, DESKTOP], [s, t, PHONE]]))
  : [
      ['setup', 'light', DESKTOP], ['soundcheck', 'light', DESKTOP], ['recording', 'light', DESKTOP],
      ['review', 'light', DESKTOP], ['ready', 'dark', DESKTOP], ['recording', 'dark', DESKTOP],
      ['setup', 'light', PHONE], ['review', 'dark', PHONE], ['popout', 'dark', { width: 320, height: 420 }],
    ];

const browser = await chromium.launch();
for (const [state, theme, vp] of shots) {
  const p = await browser.newPage({ viewport: vp, colorScheme: theme });
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  const url = `${pathToFileURL(page).href}?state=${state}&theme=${theme}`;
  await p.goto(url);
  await p.waitForTimeout(400);
  const name = `${state}-${theme}-${vp.width}.png`;
  await p.screenshot({ path: path.join(outDir, name), fullPage: vp.width > 400 && state !== 'popout' });
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  console.log(name, overflow ? 'HORIZONTAL OVERFLOW' : 'ok', errors.length ? 'ERRORS: ' + errors.join('; ') : '');
  await p.close();
}
await browser.close();
