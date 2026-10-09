// The floating controls (Document Picture-in-Picture) during a take: Hide and
// Alt+H, closing themselves when a whole-screen recording would include them,
// and warnings that stay visible while they are hidden. The PiP window is an
// iframe stand-in (helpers.mjs › fakePip); the fake screen is a whole monitor
// (3840×2160) on one display. A real whole-screen capture of them is checked
// in controls-capture.spec.mjs. Run `npm run build` first.
import { test, expect } from '@playwright/test';
import { APP_URL, trackErrors, fakePip, freeStorage } from './helpers.mjs';

const SETTINGS_KEY = 'full-capture:settings:v1';

/** Open the app with settings seeded, the stand-in PiP and page scripts installed before it boots. */
async function openApp(page, settings = {}, ...scripts) {
  await page.addInitScript(([key, value]) => {
    try { if (!localStorage.getItem('full-capture:test-seeded')) { localStorage.setItem(key, value); localStorage.setItem('full-capture:test-seeded', '1'); } } catch {}
  }, [SETTINGS_KEY, JSON.stringify({ countdown: false, floatingControls: true, ...settings })]);
  await page.addInitScript(fakePip);
  for (const [fn, arg] of scripts) await page.addInitScript(fn, arg);
  await page.goto(APP_URL);
  await page.waitForFunction(() => document.documentElement.dataset.ready === 'true');
}

const phase = page => page.evaluate(() => document.documentElement.dataset.phase);
const state = (page, fn) => page.evaluate(`(${fn})(window.fullCapture.state)`);
const pipOpen = page => page.evaluate(() => !!window.__pip);
const pip = page => page.frameLocator('body > iframe');

/** The times MediaRecorder.start() was called (performance.now()). */
const logRecorderStarts = () => {
  window.__recStarts = [];
  const start = MediaRecorder.prototype.start;
  MediaRecorder.prototype.start = function (...a) { window.__recStarts.push(performance.now()); return start.apply(this, a); };
};

/** The i-th screen pick reports surfaces[i] (the last one repeats). */
const surfaces = list => {
  const md = navigator.mediaDevices;
  const real = md.getDisplayMedia.bind(md);
  let n = 0;
  md.getDisplayMedia = async o => {
    const s = await real(o);
    const surface = list[Math.min(n++, list.length - 1)];
    const t = s.getVideoTracks()[0];
    const get = t.getSettings.bind(t);
    t.getSettings = () => ({ ...get(), displaySurface: surface });
    return s;
  };
};

/** Every phase with its time, from now on. */
const watchPhases = page => page.evaluate(() => {
  window.__phases = [[document.documentElement.dataset.phase, performance.now()]];
  window.fullCapture.on('change', st => { const l = window.__phases; if (l[l.length - 1][0] !== st.phase) l.push([st.phase, performance.now()]); });
});
const phaseAt = (page, name) => page.evaluate(n => window.__phases.find(p => p[0] === n)?.[1] ?? null, name);

async function micLive(page) {
  await page.mouse.click(5, 5);
  await expect.poll(() => state(page, st => st.mic.status)).toBe('live');
}

async function chooseScreen(page) {
  await page.click('#btnChooseScreen');
  await expect(page.locator('#screenSummary')).toBeVisible();
}

async function startTake(page) {
  await page.click('#btnStart');
  await expect.poll(() => phase(page), { timeout: 15_000 }).toBe('recording');
}

// Presses on a view in its first 500 ms are ignored (app.js), so wait that out.
const settle = page => page.waitForTimeout(600);

async function stopTake(page) {
  await settle(page);
  // A take with no data yet is "too short to save" and downloads nothing. The first chunk comes
  // after ~1 s, later on a busy machine (e.g. while the real-capture test runs alongside).
  await expect.poll(() => state(page, st => st.take?.bytes ?? 0), { timeout: 15_000 }).toBeGreaterThan(0);
  const download = page.waitForEvent('download');
  await page.click('#btnStop');
  await download;
  await expect.poll(() => phase(page), { timeout: 20_000 }).toBe('review');
}

/** Review → "Record another take" → Set up, settled. */
async function newTake(page) {
  await settle(page);
  await page.click('#btnNewTake');
  await expect.poll(() => phase(page)).toBe('ready');
  await settle(page);
}

let errors;
test.beforeEach(async ({ page }) => { errors = trackErrors(page); });
test.setTimeout(90_000);
test.afterEach(() => {
  expect(errors.filter(e => !/favicon|Failed to load resource/.test(e))).toEqual([]);
});

test('Hide closes the floating controls and the take carries on; the tab’s shortcuts still work, and Alt+H brings them back and hides them', async ({ page }) => {
  // Auto-hide off: the controls stay open as the take starts, and this test hides them by hand.
  await openApp(page, { autoHideControls: false });
  await micLive(page);
  await chooseScreen(page);
  await startTake(page);
  await expect.poll(() => pipOpen(page)).toBe(true);
  const hide = pip(page).getByRole('button', { name: 'Hide controls' });
  await expect(hide).toHaveAttribute('aria-keyshortcuts', 'Alt+H');
  await expect(page.locator('#btnPopout')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#btnPopout .on-tag')).toHaveText('Shown');
  await expect(page.locator('#btnPopout')).toHaveAttribute('aria-keyshortcuts', 'Alt+H');

  await hide.click();
  await expect.poll(() => pipOpen(page)).toBe(false);
  await expect(page.locator('#btnPopout')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#btnPopout .on-tag')).toHaveText('Hidden');

  // Recording goes on uninterrupted.
  const before = await state(page, st => ({ ms: st.take.elapsedMs, bytes: st.take.bytes }));
  await page.waitForTimeout(1600);
  const after = await state(page, st => ({ phase: st.phase, ms: st.take.elapsedMs, bytes: st.take.bytes }));
  expect(after.phase).toBe('recording');
  expect(after.ms).toBeGreaterThan(before.ms + 1000);
  expect(after.bytes).toBeGreaterThan(before.bytes);

  // Alt+M, Alt+P still work in the tab while the controls are hidden.
  await page.locator('#btnStop').focus();
  await page.keyboard.press('Alt+m');
  await expect.poll(() => state(page, st => st.take.markers.length)).toBe(1);
  await page.keyboard.press('Alt+p');
  await expect.poll(() => phase(page)).toBe('paused');
  await page.waitForTimeout(500);                         // past the 400 ms double-press guard
  await page.keyboard.press('Alt+p');
  await expect.poll(() => phase(page)).toBe('recording');
  expect(await pipOpen(page)).toBe(false);

  // Alt+H in the tab shows them again; held down (auto-repeat), it acts once.
  await page.keyboard.down('Alt');
  await page.keyboard.down('h');
  for (let i = 0; i < 5; i++) { await page.waitForTimeout(30); await page.keyboard.down('h'); }
  await page.keyboard.up('h');
  await page.keyboard.up('Alt');
  await expect.poll(() => pipOpen(page)).toBe(true);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__pipEvents.map(e => e[0]))).toEqual(['opened', 'closed', 'opened']);
  await expect(page.locator('#btnPopout')).toHaveAttribute('aria-pressed', 'true');

  // Alt+H in the floating controls hides them.
  await pip(page).locator('[data-action="pause"]').focus();
  await page.keyboard.press('Alt+h');
  await expect.poll(() => pipOpen(page)).toBe(false);
  expect(await phase(page)).toBe('recording');

  // Alt+R in the tab stops and saves the take, chapter included.
  await page.locator('#btnStop').focus();
  const download = page.waitForEvent('download');
  await page.keyboard.press('Alt+r');
  await download;
  await expect.poll(() => phase(page), { timeout: 20_000 }).toBe('review');
  await expect(page.locator('#chapterList .chapter')).toHaveCount(1);
});

test('a whole-screen take on one display closes the floating controls before it records, says so, and the next Start opens them again', async ({ page }) => {
  await openApp(page, { countdown: true }, [logRecorderStarts]);
  await micLive(page);
  await chooseScreen(page);
  expect(await page.evaluate(() => [screen.isExtended, window.fullCapture.state.screen.surface])).toEqual([false, 'monitor']);

  for (const take of [1, 2]) {
    if (take === 2) await newTake(page);
    await page.click('#btnStart');
    await expect.poll(() => phase(page)).toBe('countdown');
    await expect.poll(() => pipOpen(page)).toBe(true);    // open for the 3-2-1
    await expect(pip(page).locator('[data-field="countdown"]')).toBeVisible();
    await expect.poll(() => phase(page), { timeout: 15_000 }).toBe('recording');
    expect(await pipOpen(page)).toBe(false);
    // Gone before the first frame: the recorder started only after they had closed.
    const [closedAt, recAt] = await page.evaluate(() => [window.__pipEvents.filter(e => e[0] === 'closed').at(-1)?.[1], window.__recStarts.at(-1)]);
    expect(closedAt).toBeLessThan(recAt);
    await expect(page.locator('#toasts')).toContainText('Floating controls hidden');
    await expect(page.locator('#toasts')).toContainText('press Alt+H or Floating controls');
    await expect(page.locator('#btnPopout')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#btnPopout .on-tag')).toHaveText('Hidden');

    if (take === 2) {
      // Shown again during the take, they stay for the rest of it.
      await settle(page);
      await page.click('#btnPopout');
      await expect.poll(() => pipOpen(page)).toBe(true);
      await page.waitForTimeout(1500);
      expect(await pipOpen(page)).toBe(true);
      await expect(page.locator('#btnPopout')).toHaveAttribute('aria-pressed', 'true');
    } else {
      await page.waitForTimeout(1000);
    }
    await stopTake(page);
    expect(await pipOpen(page)).toBe(take === 2);
  }
  expect(await page.evaluate(() => window.__pipEvents.map(e => e[0]))).toEqual(['opened', 'closed', 'opened', 'closed', 'opened']);
});

test('a take waits for floating controls that are slow to close, never more than 2 s for ones that don’t, and can still be cancelled', async ({ page }) => {
  await openApp(page, {}, [logRecorderStarts]);
  await micLive(page);
  await chooseScreen(page);

  // Slow to close (an operating system that animates windows away).
  await page.evaluate(() => { window.__pipCloseDelay = 600; });
  await startTake(page);
  const [closedAt, recAt] = await page.evaluate(() => [window.__pipEvents.find(e => e[0] === 'closed')?.[1], window.__recStarts[0]]);
  expect(recAt - closedAt).toBeGreaterThanOrEqual(290);   // closed, then a moment for the capture to catch up
  await page.waitForTimeout(800);
  await stopTake(page);

  // Never closes: the take starts anyway, about 2 s late.
  await page.evaluate(() => { window.__pipCloseDelay = Infinity; });
  await newTake(page);
  await watchPhases(page);
  await startTake(page);
  const waited = (await phaseAt(page, 'recording')) - (await phaseAt(page, 'starting'));
  expect(waited).toBeGreaterThanOrEqual(1900);
  expect(waited).toBeLessThan(5000);
  const bytes = await state(page, st => st.take.bytes);
  await page.waitForTimeout(1500);
  expect(await state(page, st => st.take.bytes)).toBeGreaterThan(bytes);
  await stopTake(page);
  expect(await state(page, st => st.library.length)).toBe(2);

  // Escape while the take waits for them: nothing is recorded, and no recorder even starts.
  await newTake(page);
  const recorders = await page.evaluate(() => window.__recStarts.length);
  await page.click('#btnStart');
  await expect.poll(() => phase(page)).toBe('starting');
  await page.keyboard.press('Escape');
  await expect(page.locator('#toasts')).toContainText('Recording cancelled');
  await expect.poll(() => phase(page), { timeout: 10_000 }).toBe('ready');
  expect(await state(page, st => st.library.length)).toBe(2);
  expect(await page.evaluate(() => window.__recStarts.length)).toBe(recorders);
});

test('a window capture keeps the floating controls open; the same controls close once the whole screen is recorded', async ({ page }) => {
  await openApp(page, {}, [surfaces, ['window', 'monitor']]);
  await micLive(page);
  await chooseScreen(page);
  expect(await state(page, st => st.screen.surface)).toBe('window');
  await startTake(page);
  await page.waitForTimeout(1000);
  expect(await pipOpen(page)).toBe(true);
  await expect(page.locator('#toasts')).not.toContainText('Floating controls hidden');
  await stopTake(page);

  await newTake(page);
  await chooseScreen(page);                               // Change: the whole screen this time
  await expect.poll(() => state(page, st => st.screen.surface)).toBe('monitor');
  await startTake(page);
  await expect.poll(() => pipOpen(page)).toBe(false);
  await expect(page.locator('#toasts')).toContainText('Floating controls hidden');
  await stopTake(page);
});

test('on an extended desktop the controls stay open on a display that isn’t the recorded monitor, or with the setting off', async ({ page }) => {
  await openApp(page);
  await micLive(page);
  await chooseScreen(page);
  // The recorded monitor's size before fitting (the fake screen is 3840×2160).
  const [w, h] = await state(page, st => [st.screen.nativeWidth, st.screen.nativeHeight]);

  // The controls' display is that size (at 150 %): it may be the recorded monitor, so they close.
  await page.evaluate(([w, h]) => { window.__pipScreen = { isExtended: true, width: w / 1.5, height: h / 1.5 }; window.__pipDpr = 1.5; }, [w, h]);
  await startTake(page);
  await expect.poll(() => pipOpen(page)).toBe(false);
  await expect(page.locator('#toasts')).toContainText('Floating controls hidden');
  await stopTake(page);

  // On a 1280×1024 display, it isn't the recorded monitor: the next Start opens them and they stay.
  await page.evaluate(() => { window.__pipScreen = { isExtended: true, width: 1280, height: 1024 }; window.__pipDpr = 1; });
  await newTake(page);
  await startTake(page);
  await page.waitForTimeout(1000);
  expect(await pipOpen(page)).toBe(true);
  await stopTake(page);

  // Back on a display of the recorded monitor's size, with auto-hide switched off: they stay.
  await page.evaluate(([w, h]) => { window.__pipScreen = { isExtended: true, width: w / 1.5, height: h / 1.5 }; window.__pipDpr = 1.5; }, [w, h]);
  await page.click('#btnSettings');
  await expect(page.locator('#autoHideToggle')).toBeChecked();
  await page.locator('#autoHideToggle').uncheck();
  await page.click('#btnSettingsClose');
  expect(await state(page, st => st.prefs.autoHideControls)).toBe(false);
  await newTake(page);
  await startTake(page);
  await page.waitForTimeout(1000);
  expect(await pipOpen(page)).toBe(true);
  await stopTake(page);
});

test('a warning while the controls are hidden shows in the tab title, and in the controls once they are shown again', async ({ page }) => {
  await openApp(page, { lessonName: 'Fractions', camera: true }, [freeStorage]);
  await micLive(page);
  await chooseScreen(page);
  await expect.poll(() => state(page, st => st.camera.status)).toBe('live');
  await startTake(page);
  await expect.poll(() => page.title()).toMatch(/^● 00:0\d Recording – Fractions$/);

  // The camera is unplugged mid-take.
  await page.evaluate(() => {
    const t = window.fullCapture.state.camera.previewStream.getVideoTracks()[0];
    t.stop();
    t.dispatchEvent(new Event('ended'));
  });
  await expect.poll(() => page.title()).toMatch(/^● 00:\d\d Recording · ⚠ Camera disconnected – Fractions$/);
  expect(await phase(page)).toBe('recording');
  await expect(page.locator('#banners')).toContainText('Camera disconnected');
  expect(await pipOpen(page)).toBe(false);                // they closed as the take started (whole screen, one display)

  // Shown again, the controls say it too, out loud as well. (A press within 1.5 s of them closing
  // themselves is taken as a late "hide": see the Alt+H test below.)
  await page.waitForFunction(() => performance.now() - window.__pipEvents.findLast(e => e[0] === 'closed')[1] > 1600);
  await page.locator('#btnStop').focus();
  await page.keyboard.press('Alt+h');
  await expect.poll(() => pipOpen(page)).toBe(true);
  await expect(pip(page).locator('[data-part="alert"]')).toBeVisible();
  await expect(pip(page).locator('[data-part="alert"]')).toContainText('Camera disconnected');
  await expect(pip(page).locator('[data-part="nosound"]')).toBeHidden();
  await expect(pip(page).locator('[role="status"]')).toContainText('Camera disconnected');

  // Dismissed in the tab: gone from both.
  await page.locator('#banners .banner', { hasText: 'Camera disconnected' }).getByRole('button', { name: 'Dismiss' }).first().click();
  await expect.poll(() => page.title()).toMatch(/^● \d\d:\d\d Recording – Fractions$/);
  await expect(pip(page).locator('[data-part="alert"]')).toBeHidden();
  await stopTake(page);
});

test('a warning keeps the state in the tab title: paused still reads Paused', async ({ page }) => {
  await openApp(page, { lessonName: 'Fractions' }, [() => { window.__freeBytes = 200e6; }], [freeStorage]);
  await micLive(page);
  await chooseScreen(page);
  await expect(page.locator('#banners')).toContainText('Storage is nearly full');
  await startTake(page);
  await expect.poll(() => page.title()).toMatch(/^● 00:\d\d Recording · ⚠ Storage is nearly full – Fractions$/);
  await settle(page);
  await page.click('#btnPause');
  await expect.poll(() => phase(page)).toBe('paused');
  await expect.poll(() => page.title()).toBe('❚❚ Paused · ⚠ Storage is nearly full – Fractions');
  await settle(page);
  await page.click('#btnResumeBig');
  await expect.poll(() => phase(page)).toBe('recording');
  await stopTake(page);
});

test('Alt+H pressed as the controls close themselves doesn’t bring them back into the recording', async ({ page }) => {
  await openApp(page, { countdown: true });
  await micLive(page);
  await chooseScreen(page);
  await page.click('#btnStart');
  // The moment they close (at the end of the countdown), the teacher presses Alt+H to hide them.
  await page.waitForFunction(() => (window.__pipEvents || []).some(e => e[0] === 'closed'), null, { polling: 'raf', timeout: 15_000 });
  await page.keyboard.press('Alt+h');
  await expect.poll(() => phase(page), { timeout: 15_000 }).toBe('recording');
  await page.waitForTimeout(500);
  expect(await pipOpen(page)).toBe(false);
  // A deliberate Alt+H a moment later brings them back.
  await page.waitForTimeout(1200);
  await page.keyboard.press('Alt+h');
  await expect.poll(() => pipOpen(page)).toBe(true);
  await stopTake(page);
});
