// Set up and the views around a take, as a teacher sees them at common window
// sizes: where a view opens, what the pinned Start bar may cover, what Set up
// says on a single screen, and a microphone that sends pure silence.
// Run `npm run build` first.
import { test, expect } from '@playwright/test';
import { APP_URL, trackErrors, freeStorage } from './helpers.mjs';

const SETTINGS_KEY = 'full-capture:settings:v1';

// What Chrome shows inside a maximised window (taskbar and Chrome's own bars taken off).
const FHD = { width: 1920, height: 945 };
const LAPTOP = { width: 1366, height: 633 };
const HALF = { width: 960, height: 945 };

/** Open the app with settings seeded and page scripts installed before it boots. */
async function openApp(page, settings = {}, ...scripts) {
  await page.addInitScript(([key, value]) => {
    try { if (!localStorage.getItem('full-capture:test-seeded')) { localStorage.setItem(key, value); localStorage.setItem('full-capture:test-seeded', '1'); } } catch {}
  }, [SETTINGS_KEY, JSON.stringify({ countdown: false, floatingControls: false, ...settings })]);
  await page.addInitScript(freeStorage);
  for (const [fn, arg] of scripts) await page.addInitScript(fn, arg);
  await page.goto(APP_URL);
  await page.waitForFunction(() => document.documentElement.dataset.ready === 'true');
}

const phase = page => page.evaluate(() => document.documentElement.dataset.phase);
const state = (page, fn) => page.evaluate(`(${fn})(window.fullCapture.state)`);
const settle = page => page.waitForTimeout(600);

/** A first visit: the browser hasn't been asked about the microphone yet. */
const micNotAsked = () => {
  const realQuery = navigator.permissions.query.bind(navigator.permissions);
  navigator.permissions.query = async d => (d?.name === 'microphone' ? { state: 'prompt', onchange: null } : realQuery(d));
};

/** A microphone that opens but sends pure silence (a muted headset). */
const silentMic = () => {
  const md = navigator.mediaDevices;
  const real = md.getUserMedia.bind(md);
  md.getUserMedia = async c => {
    if (!c?.audio || c.video) return real(c);
    const ctx = new AudioContext();
    return new MediaStream([ctx.createMediaStreamDestination().stream.getAudioTracks()[0]]);
  };
};

/** The page's displays: more than one (the controls could sit on a screen that isn't recorded). */
const twoDisplays = () => { Object.defineProperty(Screen.prototype, 'isExtended', { configurable: true, get: () => true }); };

async function micLive(page) {
  await page.mouse.click(5, 5);   // a gesture starts the audio
  await expect.poll(() => state(page, st => st.mic.status)).toBe('live');
}

async function chooseScreen(page) {
  await page.click('#btnChooseScreen');
  await expect(page.locator('#screenSummary')).toBeVisible();
}

/** Is the element's centre the element itself (not covered by something pinned over it)? */
const uncovered = (page, sel) => page.locator(sel).evaluate(el => {
  const r = el.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return !!hit && (hit === el || el.contains(hit));
});

let errors;
test.beforeEach(async ({ page }) => { errors = trackErrors(page); });
test.setTimeout(90_000);
test.afterEach(() => {
  expect(errors.filter(e => !/favicon|Failed to load resource/.test(e))).toEqual([]);
});

test('Recording and Review open at their top, even when Set up was scrolled down before Start', async ({ page }) => {
  await page.setViewportSize(LAPTOP);
  await openApp(page);
  await micLive(page);
  await chooseScreen(page);
  // The teacher scrolls down (to the Screen or Camera step), then starts with Alt+R.
  await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
  expect(await page.evaluate(() => scrollY)).toBeGreaterThan(300);
  await settle(page);
  await page.keyboard.press('Alt+r');
  await expect.poll(() => phase(page), { timeout: 15_000 }).toBe('recording');
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => scrollY)).toBe(0);
  // The timer and the "Recording" badge are in view.
  for (const id of ['recPill', 'recTimer']) {
    const top = await page.locator(`#${id}`).evaluate(el => el.getBoundingClientRect().top);
    expect(top).toBeGreaterThanOrEqual(0);
  }

  // Scrolled down while recording, Stop & save opens Review at its top too.
  await expect.poll(() => state(page, st => st.take?.bytes ?? 0), { timeout: 15_000 }).toBeGreaterThan(0);
  await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
  expect(await page.evaluate(() => scrollY)).toBeGreaterThan(100);
  const download = page.waitForEvent('download');
  await page.keyboard.press('Alt+r');
  await download;
  await expect.poll(() => phase(page), { timeout: 20_000 }).toBe('review');
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => scrollY)).toBe(0);
});

test('first visit: the pinned Start bar never covers Turn on microphone, and pins once the microphone is on', async ({ page }) => {
  await openApp(page, {}, [micNotAsked]);
  for (const size of [FHD, LAPTOP, HALF]) {
    await page.setViewportSize(size);
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await expect(page.locator('#btnMicOn')).toBeVisible();
    expect(await page.locator('#btnStart').getAttribute('aria-disabled')).toBe('true');
    expect(await page.locator('.start-bar').evaluate(el => getComputedStyle(el).position)).toBe('static');
    // Scrolled so the button sits right at the bottom edge of the window, where a pinned bar would be.
    await page.locator('#btnMicOn').evaluate(el => window.scrollBy({ top: el.getBoundingClientRect().bottom - innerHeight + 2, behavior: 'instant' }));
    expect(await uncovered(page, '#btnMicOn'), `Turn on microphone covered at ${size.width}×${size.height}`).toBe(true);
  }
  // At 1920 × 1080 it is in view, uncovered, without scrolling.
  await page.setViewportSize(FHD);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  const box = await page.locator('#btnMicOn').boundingBox();
  expect(box.y + box.height).toBeLessThanOrEqual(FHD.height);
  expect(await uncovered(page, '#btnMicOn')).toBe(true);

  await page.click('#btnMicOn');
  await expect.poll(() => state(page, st => st.mic.status)).toBe('live');
  await expect.poll(() => page.locator('.start-bar').evaluate(el => getComputedStyle(el).position)).toBe('sticky');
});

/** Hold back microphone opens by window.__micDelay ms (a device that is slow to switch). */
const slowMicOpens = () => {
  const md = navigator.mediaDevices;
  const real = md.getUserMedia.bind(md);
  md.getUserMedia = async c => {
    if (c?.audio && !c.video && window.__micDelay) await new Promise(r => setTimeout(r, window.__micDelay));
    return real(c);
  };
};

test('Start pressed before the microphone is on pins the bar with the reason in view; a microphone switching devices keeps it pinned', async ({ page }) => {
  await page.setViewportSize(LAPTOP);
  await openApp(page, {}, [micNotAsked], [slowMicOpens]);
  expect(await page.locator('.start-bar').evaluate(el => getComputedStyle(el).position)).toBe('static');
  await page.keyboard.press('Alt+r');
  // Says why, in the (now pinned) Start bar, and points at the fix.
  await expect(page.locator('#startHint')).toBeVisible();
  await expect(page.locator('#startHint')).toContainText('microphone');
  await expect.poll(() => page.locator('.start-bar').evaluate(el => getComputedStyle(el).position)).toBe('sticky');
  await expect(page.locator('#btnMicOn')).toBeFocused();
  await page.waitForTimeout(800);   // the smooth scroll to the fix
  const hint = await page.locator('#startHint').evaluate(el => { const r = el.getBoundingClientRect(); return [r.top, r.bottom, innerHeight]; });
  expect(hint[0]).toBeGreaterThanOrEqual(0);
  expect(hint[1]).toBeLessThanOrEqual(hint[2]);
  expect(await uncovered(page, '#btnMicOn')).toBe(true);

  await page.click('#btnMicOn');
  await expect.poll(() => state(page, st => st.mic.status)).toBe('live');
  await expect.poll(() => page.locator('.start-bar').evaluate(el => getComputedStyle(el).position)).toBe('sticky');
  // Another microphone: it reopens ("starting") without the bar dropping out of view.
  await page.evaluate(() => { window.__micDelay = 1500; });
  const options = await page.locator('#micSelect option').evaluateAll(os => os.map(o => o.value));
  const current = await page.locator('#micSelect').inputValue();
  await page.locator('#micSelect').selectOption(options.find(v => v !== current));
  await expect.poll(() => state(page, st => st.mic.status)).toBe('starting');
  expect(await page.locator('.start-bar').evaluate(el => getComputedStyle(el).position)).toBe('sticky');
  await expect.poll(() => state(page, st => st.mic.status), { timeout: 10_000 }).toBe('live');
});

test('a microphone sending pure silence: Set up says No sound instead of All set, and Start still works', async ({ page }) => {
  await openApp(page, {}, [silentMic]);
  await micLive(page);
  await chooseScreen(page);
  await expect.poll(() => state(page, st => st.alerts.some(a => a.id === 'no-audio')), { timeout: 15_000 }).toBe(true);
  await expect(page.locator('#banners')).toContainText('No sound from your microphone');
  await expect(page.locator('#micChip')).toHaveText('No sound');
  await expect(page.locator('#stepMic')).toHaveAttribute('data-status', 'attention');
  await expect(page.locator('#readiness')).toHaveAttribute('data-ready', 'false');
  await expect(page.locator('#readiness')).not.toContainText('All set');
  await expect(page.locator('#readiness')).toContainText('no sound');
  // Recording stays allowed: the teacher may mean to record without a voice.
  expect(await page.locator('#btnStart').getAttribute('aria-disabled')).toBeNull();
  await settle(page);
  await page.click('#btnStart');
  await expect.poll(() => phase(page), { timeout: 15_000 }).toBe('recording');
});

test('on the only screen, Set up says before Start that the floating controls hide and how to pause or stop', async ({ page }) => {
  await page.setViewportSize(LAPTOP);
  await openApp(page, { floatingControls: true });
  expect(await page.evaluate(() => screen.isExtended)).toBe(false);
  // Before a screen is chosen, the Start card no longer promises controls on top of the slides.
  await expect(page.locator('#tipFloatingHides')).toBeVisible();
  await expect(page.locator('#tipFloating')).toBeHidden();
  await micLive(page);
  await chooseScreen(page);
  const tip = page.locator('#screenOneTip');
  await expect(tip).toBeVisible();
  await expect(tip).toContainText('only screen');
  await expect(tip).toContainText('floating controls hide');
  await expect(tip).toContainText('switch back to this tab');
  await expect(tip).toContainText('That moment is recorded');
  // With floating controls off, it still says how shortcuts work, but not that controls hide.
  await page.click('#btnSettings');
  await page.locator('#floatingToggle').uncheck();
  await page.click('#btnSettingsClose');
  expect(await state(page, st => st.prefs.floatingControls)).toBe(false);
  await expect(tip).not.toContainText('floating controls hide');
  await expect(tip).toContainText('switch back to this tab');
  await expect(page.locator('#tipFloatingHides')).toBeHidden();
});

test('with a second display, Set up keeps the usual guidance', async ({ page }) => {
  await page.setViewportSize(LAPTOP);
  await openApp(page, { floatingControls: true }, [twoDisplays]);
  await micLive(page);
  await chooseScreen(page);
  await expect(page.locator('#screenOneTip')).toBeHidden();
  await expect(page.locator('#screenTip')).toBeVisible();
  await expect(page.locator('#tipFloating')).toBeVisible();
  await expect(page.locator('#tipFloatingHides')).toBeHidden();
});
