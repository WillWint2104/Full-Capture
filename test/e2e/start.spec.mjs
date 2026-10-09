// Starting a take when the microphone or camera isn't quite ready, or the
// screen's reported size is stale. Run `npm run build` first.
import { test, expect } from '@playwright/test';
import { APP_URL, trackErrors } from './helpers.mjs';

const SETTINGS_KEY = 'full-capture:settings:v1';

/** Open the app with settings seeded and page scripts installed before it boots. */
async function openApp(page, settings = {}, ...scripts) {
  await page.addInitScript(([key, value]) => {
    try { if (!sessionStorage.getItem('seeded')) { localStorage.setItem(key, value); sessionStorage.setItem('seeded', '1'); } } catch {}
  }, [SETTINGS_KEY, JSON.stringify({ countdown: false, floatingControls: false, ...settings })]);
  for (const [fn, arg] of scripts) await page.addInitScript(fn, arg);
  await page.goto(APP_URL);
  await page.waitForFunction(() => document.documentElement.dataset.ready === 'true');
}

const phase = page => page.evaluate(() => document.documentElement.dataset.phase);
const state = (page, fn) => page.evaluate(`(${fn})(window.fullCapture.state)`);

/** Keep every stream the page's recorders record. */
const keepRecorded = () => {
  const Real = window.MediaRecorder;
  window.__recorded = [];
  window.MediaRecorder = class extends Real { constructor(...a) { super(...a); window.__recorded.push(a[0]); } };
  window.MediaRecorder.isTypeSupported = Real.isTypeSupported.bind(Real);
};

/** Hold back camera opens: {delay} ms, then resolve or reject with {reject} (a DOMException name). */
const slowCamera = ({ delay, reject }) => {
  const md = navigator.mediaDevices;
  const real = md.getUserMedia.bind(md);
  md.getUserMedia = async c => {
    if (!c?.video) return real(c);
    await new Promise(r => setTimeout(r, delay));
    if (reject) throw new DOMException('test', reject);
    return real(c);
  };
};

/** Document Picture-in-Picture as an iframe, so the floating controls can be driven headlessly. */
const fakePip = () => {
  Object.defineProperty(window, 'documentPictureInPicture', { configurable: true, value: {
    async requestWindow() {
      const f = document.createElement('iframe');
      f.style.cssText = 'position:fixed;right:0;bottom:0;width:320px;height:420px;border:0';
      document.body.append(f);
      await new Promise(r => setTimeout(r, 50));
      window.__pip = f.contentWindow;
      return f.contentWindow;
    },
  } });
};

/** Size of the next frame of the first recorded video track. */
const recordedFrameSize = page => page.evaluate(async () => {
  const track = window.__recorded[0].getVideoTracks()[0].clone();
  const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
  const { value } = await reader.read();
  const size = [value.displayWidth, value.displayHeight];
  value.close(); reader.cancel().catch(() => {}); track.stop();
  return size;
});

async function micLive(page) {
  await page.mouse.click(5, 5);
  await expect.poll(() => state(page, st => st.mic.status)).toBe('live');
}

async function chooseScreen(page) {
  await page.click('#btnChooseScreen');
  await expect(page.locator('#screenSummary')).toBeVisible();
}

async function recordAndStop(page) {
  await page.click('#btnStart');
  await expect.poll(() => phase(page), { timeout: 15_000 }).toBe('recording');
  await page.waitForTimeout(1200);
  const download = page.waitForEvent('download');
  await page.click('#btnStop');
  await download;
  await expect.poll(() => phase(page), { timeout: 20_000 }).toBe('review');
}

let errors;
test.beforeEach(async ({ page }) => { errors = trackErrors(page); });
test.setTimeout(90_000);
test.afterEach(() => {
  expect(errors.filter(e => !/favicon|Failed to load resource/.test(e))).toEqual([]);
});

test('Alt+R on the Review screen with the microphone off goes back to Set up and shows what to fix', async ({ page }) => {
  await openApp(page);
  await micLive(page);
  await chooseScreen(page);
  await recordAndStop(page);
  await page.evaluate(() => window.fullCapture.setMicEnabled(false));
  await page.locator('#reviewHeading').focus();
  await page.keyboard.press('Alt+r');
  await expect(page.locator('#viewSetup')).toBeVisible();
  await expect(page.locator('#startHint')).toBeVisible();
  await expect(page.locator('#startHint')).toContainText('Turn on your microphone');
  await expect(page.locator('#btnMicOn')).toBeFocused();
  expect(await phase(page)).toBe('ready');
});

test('the floating controls say why Start can’t go ahead, and a press there says it out loud', async ({ page }) => {
  await openApp(page, { floatingControls: true }, [fakePip]);
  await micLive(page);
  await chooseScreen(page);
  await recordAndStop(page);                        // Start opened the floating controls
  await page.evaluate(() => window.fullCapture.setMicEnabled(false));
  const pip = () => page.evaluate(() => {
    const d = window.__pip.document;
    const start = d.querySelector('[data-action="start"]');
    return {
      pill: d.querySelector('[data-field="pill"]').textContent,
      blocked: d.querySelector('[data-field="blocked"]').hidden ? '' : d.querySelector('[data-field="blocked"]').textContent,
      disabled: start.getAttribute('aria-disabled'),
    };
  });
  await expect.poll(async () => (await pip()).pill).toBe('Microphone not ready');
  const shown = await pip();
  expect(shown.disabled).toBe('true');
  expect(shown.blocked).toContain('Turn on your microphone');
  await page.evaluate(() => window.__pip.document.querySelector('[data-action="start"]').click());
  await expect.poll(() => page.evaluate(() => window.__pip.document.querySelector('[role="alert"]').textContent)).toContain('Turn on your microphone');
  expect(await phase(page)).toBe('review');
});

test('Start while the microphone is still starting says so, and focus never lands on a disabled button', async ({ page }) => {
  await openApp(page, { micEnabled: false }, [() => {
    const md = navigator.mediaDevices;
    const real = md.getUserMedia.bind(md);
    md.getUserMedia = async c => { if (c?.audio && window.__holdMic) await new Promise(r => setTimeout(r, 2500)); return real(c); };
  }]);
  await chooseScreen(page);
  await page.evaluate(() => { window.__holdMic = true; });
  await page.click('#btnMicOn');
  await expect.poll(() => state(page, st => st.mic.status)).toBe('starting');
  await page.click('#btnStart', { force: true });   // the teacher presses the greyed Start
  await expect(page.locator('#startHint')).toContainText('still starting');
  expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-disabled'))).not.toBe('true');
  expect(await phase(page)).toBe('ready');
  await expect.poll(() => state(page, st => st.mic.status), { timeout: 10_000 }).toBe('live');
});

test('from Start until the take begins, the microphone settings are locked', async ({ page }) => {
  await openApp(page, { countdown: true });
  await micLive(page);
  await chooseScreen(page);
  await page.click('#btnStart');
  await expect.poll(() => phase(page)).toBe('countdown');
  expect(await page.evaluate(() => ['noiseToggle', 'micSelect'].map(id => document.getElementById(id).disabled))).toEqual([true, true]);
  const before = await state(page, st => st.audio.mode);
  await page.evaluate(m => window.fullCapture.setAudioMode(m === 'clean' ? 'studio' : 'clean'), before);
  expect(await state(page, st => st.audio.mode)).toBe(before);
  await page.keyboard.press('Escape');
  await expect.poll(() => phase(page)).toBe('ready');
  expect(await page.evaluate(() => document.getElementById('noiseToggle').disabled)).toBe(false);
});

test('Start gives a camera that is still opening a moment, and the take includes the bubble', async ({ page }) => {
  await openApp(page, { hidePreview: false }, [keepRecorded], [slowCamera, { delay: 1500 }]);
  await micLive(page);
  await chooseScreen(page);
  await page.check('#cameraToggle');
  await expect.poll(() => state(page, st => st.camera.status)).toBe('starting');
  await page.click('#btnStart');
  await expect.poll(() => phase(page), { timeout: 15_000 }).toBe('recording');
  expect(await state(page, st => st.take.camera)).toBe(true);
  expect(await page.evaluate(() => window.__recorded[0].getVideoTracks()[0] instanceof MediaStreamTrackGenerator)).toBe(true);
  await expect(page.locator('#bubblePreview')).toBeVisible();
});

test('a camera that fails while the take starts: the take records without the bubble, says so, and the preview agrees', async ({ page }) => {
  await openApp(page, { hidePreview: false }, [keepRecorded], [slowCamera, { delay: 1000, reject: 'NotReadableError' }]);
  await micLive(page);
  await chooseScreen(page);
  await page.check('#cameraToggle');
  await page.click('#btnStart');
  await expect.poll(() => phase(page), { timeout: 15_000 }).toBe('recording');
  await expect(page.locator('#toasts')).toContainText('Recording without the camera bubble');
  expect(await state(page, st => st.take.camera)).toBe(false);
  await expect(page.locator('#bubblePreview')).toBeHidden();
  await expect(page.locator('#screenVideo')).toBeVisible();
});

test('a camera that only opens after the take has started: the preview shows no bubble, since the take has none', async ({ page }) => {
  await openApp(page, { hidePreview: false }, [keepRecorded], [slowCamera, { delay: 4500 }]);
  await micLive(page);
  await chooseScreen(page);
  await page.check('#cameraToggle');
  await page.click('#btnStart');
  await expect.poll(() => phase(page), { timeout: 15_000 }).toBe('recording');
  await expect(page.locator('#toasts')).toContainText('Recording without the camera bubble');
  await expect.poll(() => state(page, st => st.camera.status), { timeout: 10_000 }).toBe('live');
  await expect(page.locator('#toasts')).toContainText('The camera joins from your next take');
  expect(await state(page, st => st.take.camera)).toBe(false);
  await expect(page.locator('#bubblePreview')).toBeHidden();
  await expect(page.locator('#screenVideo')).toBeVisible();
});

test('a camera-bubble take started straight after sharing is sized from the picture, not a stale report', async ({ page }) => {
  // Chrome can report the capture limits as the track's size for a moment after
  // they are applied; here that lasts 1 s, and Start picks the screen itself.
  await openApp(page, {}, [keepRecorded], [() => {
    const md = navigator.mediaDevices;
    const real = md.getDisplayMedia.bind(md);
    md.getDisplayMedia = async o => {
      const s = await real(o);
      const t = s.getVideoTracks()[0];
      const apply = t.applyConstraints.bind(t), get = t.getSettings.bind(t);
      let stale = null;
      t.applyConstraints = async c => { await apply(c); stale = { w: c?.width?.max, h: c?.height?.max, until: performance.now() + 1000 }; };
      t.getSettings = () => { const r = get(); return stale?.w && performance.now() < stale.until ? { ...r, width: stale.w, height: stale.h } : r; };
      window.__screen = t;
      return s;
    };
  }]);
  await micLive(page);
  await page.check('#cameraToggle');
  await expect.poll(() => state(page, st => st.camera.status)).toBe('live');
  await page.click('#btnStart');
  await expect.poll(() => phase(page), { timeout: 15_000 }).toBe('recording');
  const [w, h] = await recordedFrameSize(page);
  const screen = await page.evaluate(async () => {
    const track = window.__screen.clone();
    const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    const { value } = await reader.read();
    const size = [value.displayWidth, value.displayHeight];
    value.close(); reader.cancel().catch(() => {}); track.stop();
    return size;
  });
  expect(Math.abs(w / h - screen[0] / screen[1])).toBeLessThan(0.02);
});
