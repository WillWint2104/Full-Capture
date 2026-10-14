// Screenshots the REAL built app (full-capture.html) in its main states,
// driven through the UI with Chromium's fake camera, mic and screen.
//   node scripts/shoot-app.mjs [out-dir] [--app path/to/build.html]
// Default output: .build/app-shots/
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './bundler.mjs';

const args = process.argv.slice(2);
const appIdx = args.indexOf('--app');
const app = path.resolve(ROOT, appIdx >= 0 ? args[appIdx + 1] : 'full-capture.html');
const outDir = path.resolve(ROOT, args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--app') || '.build/app-shots');
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  env: { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--auto-select-desktop-capture-source=Entire screen', '--autoplay-policy=no-user-gesture-required'],
});

async function run(name, { viewport = { width: 1440, height: 900 }, theme = 'light', settings = {} } = {}, steps) {
  const ctx = await browser.newContext({ viewport, colorScheme: theme, permissions: ['microphone', 'camera'], acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(s => {
    try { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('full-capture:settings:v1', s); sessionStorage.setItem('seeded', '1'); } } catch {}
  }, JSON.stringify({ floatingControls: false, countdown: false, lessonName: 'Fractions – Week 3', ...settings }));
  await page.goto(pathToFileURL(app).href);
  await page.waitForFunction(() => document.documentElement.dataset.ready === 'true');
  await page.mouse.click(2, 2);
  const shot = async (label, opts = {}) => {
    await page.waitForTimeout(350);
    const file = path.join(outDir, `${name}-${label}.png`);
    await page.screenshot({ path: file, fullPage: opts.fullPage ?? true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    console.log(path.relative(ROOT, file), overflow > 1 ? `OVERFLOW ${overflow}px` : '');
  };
  try { await steps(page, shot); }
  catch (e) { console.log(`${name}: step failed: ${e.message.split('\n')[0]}`); await shot('failed'); }
  if (errors.length) console.log(`${name}: page errors:\n  ${errors.join('\n  ')}`);
  await ctx.close();
}

const phase = page => page.evaluate(() => document.documentElement.dataset.phase);
const waitPhase = (page, p) => page.waitForFunction(x => document.documentElement.dataset.phase === x, p, { timeout: 20_000 });

for (const theme of ['light', 'dark']) {
  await run(`desktop-${theme}`, { theme }, async (page, shot) => {
    await shot('1-setup');
    await page.waitForFunction(() => window.fullCapture.state.mic.status === 'live');
    await page.click('#btnSoundCheck');
    await page.waitForSelector('#scLine:not([hidden])', { timeout: 10_000 });
    await shot('2-soundcheck-running', { fullPage: false });
    await page.waitForSelector('#scResult:not([hidden])', { timeout: 20_000 });
    await shot('3-soundcheck-result');
    await page.click('#btnChooseScreen');
    await page.waitForSelector('#screenSummary:not([hidden])');
    await page.check('#cameraToggle');
    await page.waitForFunction(() => window.fullCapture.state.camera.status === 'live');
    await shot('4-ready');
    await page.click('#btnStart');
    await waitPhase(page, 'recording');
    await page.waitForTimeout(1500);
    await page.click('#btnMarker');
    await shot('5-recording', { fullPage: false });
    await page.click('#btnPause');
    await waitPhase(page, 'paused');
    await shot('6-paused', { fullPage: false });
    await page.click('#btnResumeBig');
    await page.waitForTimeout(1200);
    await page.click('#btnStop');
    await waitPhase(page, 'review');
    await page.waitForTimeout(800);
    await shot('7-review');
    await page.click('#btnSettings');
    await shot('8-settings', { fullPage: false });
    await page.keyboard.press('Escape');
    await page.click('#btnDeleteTake');
    await shot('9-confirm', { fullPage: false });
  });
}

await run('phone', { viewport: { width: 390, height: 844 } }, async (page, shot) => {
  await shot('1-setup');
  await page.click('#btnChooseScreen');
  await page.waitForSelector('#screenSummary:not([hidden])');
  await page.click('#btnStart');
  await waitPhase(page, 'recording');
  await page.waitForTimeout(1200);
  await shot('2-recording', { fullPage: false });
  await page.click('#btnStop');
  await waitPhase(page, 'review');
  await shot('3-review');
});

await browser.close();
