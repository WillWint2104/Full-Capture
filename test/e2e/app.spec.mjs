// The whole app, built (full-capture.html) and opened from file:// with
// Chromium's fake mic, camera and screen. Run `npm run build` first.
import { test, expect } from '@playwright/test';
import { APP_URL, trackErrors, freeStorage } from './helpers.mjs';
import { REQUIRED_IDS, RADIOS, SELECT_VALUES, TEMPLATE_PARTS, checkDocument } from '../../scripts/check-contract.mjs';

const SETTINGS_KEY = 'full-capture:settings:v1';

/** Open the app with some settings pre-seeded (e.g. no countdown, no floating controls). */
async function openApp(page, settings = {}, { init } = {}) {
  await page.addInitScript(([key, value]) => {
    // Seed once per test. The marker lives in the storage it protects: a reload can come
    // before Chromium has made the page's sessionStorage visible again, which re-seeded.
    try { if (!localStorage.getItem('full-capture:test-seeded')) { localStorage.setItem(key, value); localStorage.setItem('full-capture:test-seeded', '1'); } } catch {}
  }, [SETTINGS_KEY, JSON.stringify({ countdown: false, floatingControls: false, ...settings })]);
  if (init) await page.addInitScript(init);
  await page.goto(APP_URL);
  await page.waitForFunction(() => document.documentElement.dataset.ready === 'true');
}

const phase = page => page.evaluate(() => document.documentElement.dataset.phase);
const visible = (page, id) => page.locator(`#${id}`).isVisible();

/** Choose screen, start, wait for the recording view. */
async function startRecording(page) {
  await page.click('#btnChooseScreen');
  await expect(page.locator('#screenSummary')).toBeVisible();
  await page.click('#btnStart');
  await expect.poll(() => phase(page), { timeout: 15_000 }).toBe('recording');
}

let errors;
test.beforeEach(async ({ page }) => { errors = trackErrors(page); });
// Saving can take a few seconds on a busy machine.
test.setTimeout(90_000);
test.afterEach(() => {
  // Media errors from the fake devices are not app errors.
  expect(errors.filter(e => !/favicon|Failed to load resource/.test(e))).toEqual([]);
});

test('the built page satisfies the UI contract and boots on file://', async ({ page }) => {
  await openApp(page);
  const problems = await page.evaluate(
    ([fn, consts]) => {
      const { REQUIRED_IDS, RADIOS, SELECT_VALUES, TEMPLATE_PARTS } = consts;
      // eslint-disable-next-line no-new-func
      return new Function('REQUIRED_IDS', 'RADIOS', 'SELECT_VALUES', 'TEMPLATE_PARTS', `return (${fn})(document)`)(REQUIRED_IDS, RADIOS, SELECT_VALUES, TEMPLATE_PARTS);
    },
    [checkDocument.toString(), { REQUIRED_IDS, RADIOS, SELECT_VALUES, TEMPLATE_PARTS }],
  );
  expect(problems).toEqual([]);
  expect(await page.evaluate(() => location.protocol)).toBe('file:');
  expect(await phase(page)).toBe('setup');
  await expect(page.locator('#viewSetup')).toBeVisible();
  await expect(page.locator('#viewRecording')).toBeHidden();
  await expect(page.locator('#viewReview')).toBeHidden();
});

test('microphone goes live (permission granted) and its meter moves', async ({ page }) => {
  await openApp(page);
  await page.mouse.click(5, 5);   // a gesture starts the audio
  await expect.poll(() => page.evaluate(() => window.fullCapture.state.mic.status)).toBe('live');
  await expect(page.locator('#micControls')).toBeVisible();
  await expect.poll(() => page.evaluate(() => Number(getComputedStyle(document.getElementById('micMeter')).getPropertyValue('--level')) || 0), { timeout: 5000 }).toBeGreaterThan(0.2);
});

test('record → chapter → pause → resume → stop & save → review, then it is in the takes list', async ({ page }) => {
  // Enough free space: test browsers get under 1 GB, and the "Storage is nearly full"
  // warning would take over the tab title checked below (controls.spec.mjs covers that).
  await openApp(page, { lessonName: 'Fractions – Week 3' }, { init: freeStorage });
  await startRecording(page);
  await expect(page.locator('#viewRecording')).toBeVisible();
  await expect(page.locator('#recPill')).toContainText('Recording');
  await page.waitForTimeout(1300);
  await page.click('#btnMarker');
  await expect(page.locator('#markerCount')).toHaveText('1');
  await page.click('#btnPause');
  await expect.poll(() => phase(page)).toBe('paused');
  await expect(page.locator('#recBanner')).toBeVisible();
  await page.waitForTimeout(1200);
  await page.click('#btnResumeBig');
  await expect.poll(() => phase(page), { timeout: 15_000 }).toBe('recording');
  await page.waitForTimeout(1200);
  expect(await page.title()).toMatch(/● 00:0\d Recording – Fractions – Week 3/);

  const download = page.waitForEvent('download');
  await page.click('#btnStop');
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^Fractions – Week 3 \(\d{4}-\d\d-\d\d \d\d\.\d\d\)\.(webm|mp4)$/);
  await expect.poll(() => phase(page), { timeout: 20_000 }).toBe('review');
  await expect(page.locator('#viewReview')).toBeVisible();
  await expect(page.locator('#reviewSaved')).toContainText('Downloads');
  await expect(page.locator('#chapterList .chapter')).toHaveCount(1);

  // The take plays with a real, finite duration that excludes the pause.
  const duration = await page.evaluate(async () => {
    const v = document.getElementById('reviewVideo');
    if (!(v.duration > 0)) await new Promise(r => v.addEventListener('loadedmetadata', r, { once: true }));
    return v.duration;
  });
  expect(duration).toBeGreaterThan(2);
  expect(duration).toBeLessThan(4.2);

  await expect(page.locator('#takeList .take')).toHaveCount(1);
  await expect(page.locator('#takeList .take [data-field="name"]')).toHaveText('Fractions – Week 3');
});

test('countdown shows 3-2-1 and Escape cancels it', async ({ page }) => {
  await openApp(page, { countdown: true });
  await page.click('#btnChooseScreen');
  await expect(page.locator('#screenSummary')).toBeVisible();
  await page.click('#btnStart');
  await expect.poll(() => phase(page)).toBe('countdown');
  await expect(page.locator('#countdown')).toBeVisible();
  await expect(page.locator('#countdownNum')).toHaveText('3');
  await expect(page.locator('#btnStart')).toContainText('Cancel');
  expect(await page.title()).toMatch(/Starting in/);
  await page.keyboard.press('Escape');
  await expect.poll(() => phase(page)).toBe('ready');
  await expect(page.locator('#countdown')).toBeHidden();
});

test('Discard take asks first; keeping it continues, discarding saves nothing', async ({ page }) => {
  await openApp(page);
  await startRecording(page);
  await page.waitForTimeout(800);
  await page.click('#btnDiscard');
  await expect(page.locator('#confirmDialog')).toBeVisible();
  await expect(page.locator('#btnConfirmCancel')).toBeFocused();
  await page.click('#btnConfirmCancel');
  expect(await phase(page)).toBe('recording');
  await page.click('#btnDiscard');
  await page.click('#btnConfirmOk');
  await expect.poll(() => phase(page)).toBe('ready');
  await expect(page.locator('#takeList .take')).toHaveCount(0);
  await expect(page.locator('#libraryEmpty')).toBeVisible();
});

test('keyboard: Alt+R starts and stops, Alt+M adds a chapter', async ({ page }) => {
  await openApp(page);
  await page.click('#btnChooseScreen');
  await expect(page.locator('#screenSummary')).toBeVisible();
  await page.locator('body').click({ position: { x: 2, y: 2 } });
  await page.keyboard.press('Alt+r');
  await expect.poll(() => phase(page), { timeout: 15_000 }).toBe('recording');
  await page.waitForTimeout(700);
  await page.keyboard.press('Alt+m');
  await expect(page.locator('#markerCount')).toHaveText('1');
  const download = page.waitForEvent('download');
  await page.keyboard.press('Alt+r');
  await download;
  await expect.poll(() => phase(page), { timeout: 20_000 }).toBe('review');
});

/** Count MediaRecorder instances the page creates (and keep the streams they record). */
const countRecorders = () => {
  const Real = window.MediaRecorder;
  window.__recorders = 0;
  window.__recorded = [];
  window.MediaRecorder = class extends Real { constructor(...a) { super(...a); window.__recorders++; window.__recorded.push(a[0]); } };
  for (const k of ['isTypeSupported']) window.MediaRecorder[k] = Real[k].bind(Real);
};

test('a double click on Start makes one take, and it keeps recording', async ({ page }) => {
  await openApp(page, {}, { init: countRecorders });
  await page.click('#btnChooseScreen');
  await expect(page.locator('#screenSummary')).toBeVisible();
  await page.dblclick('#btnStart');
  await expect.poll(() => phase(page), { timeout: 15_000 }).toBe('recording');
  await page.waitForTimeout(800);
  expect(await phase(page)).toBe('recording');
  expect(await page.evaluate(() => window.__recorders)).toBe(1);
});

test('holding Alt+R down starts once (key repeat is ignored)', async ({ page }) => {
  await openApp(page, {}, { init: countRecorders });
  await page.click('#btnChooseScreen');
  await expect(page.locator('#screenSummary')).toBeVisible();
  await page.locator('body').click({ position: { x: 2, y: 2 } });
  await page.keyboard.down('Alt');
  await page.keyboard.down('r');
  for (let i = 0; i < 5; i++) await page.keyboard.down('r');   // auto-repeat
  await page.keyboard.up('r');
  await page.keyboard.up('Alt');
  await expect.poll(() => phase(page), { timeout: 15_000 }).toBe('recording');
  await page.waitForTimeout(800);
  expect(await phase(page)).toBe('recording');
  expect(await page.evaluate(() => window.__recorders)).toBe(1);
});

test('Alt+R with the microphone off explains why and goes to the fix, without recording', async ({ page }) => {
  await openApp(page, { micEnabled: false }, { init: countRecorders });
  await page.click('#btnChooseScreen');
  await expect(page.locator('#screenSummary')).toBeVisible();
  await page.locator('body').click({ position: { x: 2, y: 2 } });
  await page.keyboard.press('Alt+r');
  await expect(page.locator('#startHint')).toBeVisible();
  await expect(page.locator('#startHint')).toContainText('microphone');
  await expect(page.locator('#btnMicOn')).toBeFocused();
  await page.waitForTimeout(500);
  expect(await phase(page)).toBe('ready');
  expect(await page.evaluate(() => window.__recorders)).toBe(0);
});

test('Escape during the countdown cancels without starting a recorder', async ({ page }) => {
  await openApp(page, { countdown: true }, { init: countRecorders });
  await page.click('#btnChooseScreen');
  await expect(page.locator('#screenSummary')).toBeVisible();
  await page.click('#btnStart');
  await expect.poll(() => phase(page)).toBe('countdown');
  await page.keyboard.press('Escape');
  await expect.poll(() => phase(page)).toBe('ready');
  await page.waitForTimeout(3500);
  expect(await phase(page)).toBe('ready');
  expect(await page.evaluate(() => window.__recorders)).toBe(0);
  await expect(page.locator('#btnStart')).toBeFocused();
});

/**
 * Control when the browser's screen pick finishes. plan[i] is for the i-th
 * getDisplayMedia call: {delay} ms before it resolves, or {reject: 'NotAllowedError'}.
 * Every stream handed out is kept on window.__shared.
 */
const slowScreenPicks = plan => {
  const md = navigator.mediaDevices;
  const real = md.getDisplayMedia.bind(md);
  window.__shared = [];
  md.getDisplayMedia = async options => {
    const step = plan[window.__shared.length] || {};
    window.__shared.push(null);
    const i = window.__shared.length - 1;
    if (step.reject) {
      await new Promise(r => setTimeout(r, step.delay || 0));
      throw new DOMException('Permission denied by user', step.reject);
    }
    const stream = await real(options);
    await new Promise(r => setTimeout(r, step.delay || 0));
    window.__shared[i] = stream;
    return stream;
  };
};

/** One init script from several page functions: fn, or [fn, arg]. */
const pageScript = (...parts) => ({
  content: parts.map(p => (Array.isArray(p) ? `(${p[0]})(${JSON.stringify(p[1])});` : `(${p})();`)).join('\n'),
});

/** readyState of every video track the page's recorders are recording. */
const recordedVideo = page => page.evaluate(() => window.__recorded.flatMap(s => s.getVideoTracks().map(t => t.readyState)));

/** Watch the phase for a while; returns every phase seen (catches brief ones). */
const watchPhases = (page, ms) => page.evaluate(ms => new Promise(resolve => {
  const seen = [document.documentElement.dataset.phase];
  const off = window.fullCapture.on('change', st => { if (seen[seen.length - 1] !== st.phase) seen.push(st.phase); });
  setTimeout(() => { off(); resolve(seen); }, ms);
}), ms);

for (const camera of [false, true]) {
  test(`Start pressed while the chosen screen is still being set up: one picker, and the take keeps its screen${camera ? ' (camera bubble on)' : ''}`, async ({ page }) => {
    await openApp(page, {}, { init: pageScript(countRecorders, [slowScreenPicks, [{ delay: 1200 }, { delay: 0 }]]) });
    await page.mouse.click(5, 5);
    await expect.poll(() => page.evaluate(() => window.fullCapture.state.mic.status)).toBe('live');
    if (camera) {
      await page.check('#cameraToggle');
      await expect.poll(() => page.evaluate(() => window.fullCapture.state.camera.status)).toBe('live');
    }
    await page.click('#btnChooseScreen');
    await page.waitForTimeout(150);
    await page.click('#btnStart');
    await expect(page.locator('#btnStart')).toContainText('Starting');
    await expect.poll(() => phase(page), { timeout: 15_000 }).toBe('recording');
    // The pick that was already under way is the one recorded: no second picker,
    // and nothing replaces (and stops) the screen once the take is running.
    expect(await watchPhases(page, 2500)).toEqual(['recording']);
    const shared = await page.evaluate(() => window.__shared.map(s => s && s.getVideoTracks()[0].readyState));
    expect(shared).toEqual(['live']);
    expect(await page.evaluate(() => window.__recorders)).toBe(1);
    expect(await recordedVideo(page)).toEqual(['live']);
    const download = page.waitForEvent('download');
    await page.click('#btnStop');
    await download;
    await expect.poll(() => phase(page), { timeout: 20_000 }).toBe('review');
    expect(await page.evaluate(() => window.fullCapture.state.review.durationMs)).toBeGreaterThan(2000);
  });
}

test('Start pressed while a changed screen is still being set up records the new screen', async ({ page }) => {
  await openApp(page, {}, { init: pageScript(countRecorders, [slowScreenPicks, [{ delay: 0 }, { delay: 1200 }]]) });
  await page.mouse.click(5, 5);
  await expect.poll(() => page.evaluate(() => window.fullCapture.state.mic.status)).toBe('live');
  await page.click('#btnChooseScreen');
  await expect(page.locator('#screenSummary')).toBeVisible();
  await page.click('#btnChooseScreen');        // "Change"
  await page.waitForTimeout(150);
  await page.click('#btnStart');
  await expect.poll(() => phase(page), { timeout: 15_000 }).toBe('recording');
  expect(await watchPhases(page, 1500)).toEqual(['recording']);
  const tracks = await page.evaluate(() => window.__shared.map(s => s.getVideoTracks()[0].readyState));
  expect(tracks).toEqual(['ended', 'live']);   // the old screen is let go, the new one is recorded
  expect(await page.evaluate(() => window.fullCapture.state.screen.stream === window.__shared[1])).toBe(true);
  expect(await page.evaluate(() => window.__recorders)).toBe(1);
  // The recorder records the new screen, not the one that was let go.
  expect(await recordedVideo(page)).toEqual(['live']);
  expect(await page.evaluate(() => window.__recorded[0].getVideoTracks()[0] === window.__shared[1].getVideoTracks()[0])).toBe(true);
});

test('Start pressed while the screen picker is open, then the picker is cancelled: says so, opens no second picker', async ({ page }) => {
  await openApp(page, {}, { init: pageScript(countRecorders, [slowScreenPicks, [{ reject: 'NotAllowedError', delay: 1000 }, { delay: 0 }]]) });
  await page.mouse.click(5, 5);
  await expect.poll(() => page.evaluate(() => window.fullCapture.state.mic.status)).toBe('live');
  await page.click('#btnChooseScreen');
  await page.waitForTimeout(150);
  await page.click('#btnStart');
  await expect(page.locator('#toasts')).toContainText('No screen chosen');
  await expect(page.locator('#btnStart')).toContainText('Start recording');
  await page.waitForTimeout(500);
  expect(await phase(page)).toBe('setup');
  expect(await page.evaluate(() => window.__shared.length)).toBe(1);
  expect(await page.evaluate(() => window.__recorders)).toBe(0);
});

test('a take survives a crash: the next visit offers it and Save it recovers a playable file', async ({ page, context }) => {
  await openApp(page, { lessonName: 'Crash test' });
  await startRecording(page);
  await page.waitForTimeout(3500);
  // Simulate the tab dying mid-lesson.
  await page.close({ runBeforeUnload: false });

  const page2 = await context.newPage();
  errors = trackErrors(page2);
  await page2.goto(APP_URL);
  await page2.waitForFunction(() => document.documentElement.dataset.ready === 'true');
  const banner = page2.locator('#banners .banner', { hasText: 'didn’t finish' });
  await expect(banner).toBeVisible({ timeout: 15_000 });
  await expect(banner).toContainText('Crash test');
  const download = page2.waitForEvent('download');
  await banner.getByRole('button', { name: 'Save it' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^RECOVERED_Crash test/);
  await expect(banner).toBeHidden();
  await expect(page2.locator('#takeList .take')).toHaveCount(1);
  const duration = await page2.evaluate(async () => {
    const t = window.fullCapture.state.library[0];
    const v = document.createElement('video');
    v.src = t.url;
    await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error('not playable')); });
    return v.duration;
  });
  expect(duration).toBeGreaterThan(2);
});

// An in-memory stand-in for the folder the teacher would pick.
const FAKE_FOLDER = () => {
  const files = new Map();
  window.__files = files;
  class Writable {
    constructor(name) { this.name = name; this.parts = []; this.pos = 0; this.buf = new Uint8Array(0); }
    async write(data) {
      if (data && data.type === 'write' && 'position' in data) { this.pos = data.position; data = data.data; }
      const bytes = new Uint8Array(data instanceof Blob ? await data.arrayBuffer() : data.buffer ? data.buffer.slice(data.byteOffset || 0, (data.byteOffset || 0) + data.byteLength) : data);
      const end = this.pos + bytes.length;
      if (end > this.buf.length) { const n = new Uint8Array(end); n.set(this.buf); this.buf = n; }
      this.buf.set(bytes, this.pos); this.pos = end;
    }
    async seek(p) { this.pos = p; }
    async truncate(n) { this.buf = this.buf.slice(0, n); }
    async close() { files.set(this.name, new File([this.buf], this.name)); }
    async abort() {}
  }
  const fileHandle = name => ({
    kind: 'file', name,
    async createWritable() { return new Writable(name); },
    async getFile() { const f = files.get(name); if (!f) throw new DOMException('gone', 'NotFoundError'); return f; },
    async move(newName) { files.set(newName, files.get(name)); files.delete(name); this.name = newName; },
  });
  const dir = {
    kind: 'directory', name: 'Lessons',
    async queryPermission() { return 'granted'; },
    async requestPermission() { return 'granted'; },
    async getFileHandle(name, opts = {}) {
      if (!files.has(name)) { if (!opts.create) throw new DOMException('missing', 'NotFoundError'); files.set(name, new File([], name)); }
      return fileHandle(name);
    },
    async removeEntry(name) { if (!files.delete(name)) throw new DOMException('missing', 'NotFoundError'); },
    async *entries() { for (const n of files.keys()) yield [n, fileHandle(n)]; },
    async *keys() { for (const n of files.keys()) yield n; },
    async isSameEntry(o) { return o === dir; },
  };
  window.showDirectoryPicker = async () => dir;
};

test('with a folder chosen, takes stream straight into it with a correct duration', async ({ page }) => {
  await openApp(page, { lessonName: 'Folder lesson' }, { init: FAKE_FOLDER });
  await page.evaluate(() => window.fullCapture.chooseFolder());
  await expect(page.locator('#btnFolder')).toContainText('Lessons');
  await startRecording(page);
  await page.waitForTimeout(2500);
  await page.click('#btnStop');
  await expect.poll(() => phase(page), { timeout: 20_000 }).toBe('review');
  await expect(page.locator('#reviewSaved')).toContainText('Lessons');
  const r = await page.evaluate(async () => {
    const names = [...window.__files.keys()];
    const f = window.__files.get(names.find(n => /^Folder lesson/.test(n)));
    const v = document.createElement('video');
    v.src = URL.createObjectURL(f);
    await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error('not playable')); });
    return { names, size: f.size, duration: v.duration };
  });
  expect(r.names.some(n => /^Folder lesson \(.*\)\.(webm|mp4)$/.test(n))).toBe(true);
  expect(r.size).toBeGreaterThan(10_000);
  expect(r.duration).toBeGreaterThan(1.5);
  expect(r.duration).toBeLessThan(4);
  // Delete take removes the file from the folder. (A view ignores pointer clicks for
  // its first half second, so the second click of a double-click can't land on it.)
  await page.waitForTimeout(600);
  await page.click('#btnDeleteTake');
  await page.click('#btnConfirmOk');
  await expect.poll(() => page.evaluate(() => [...window.__files.keys()].filter(n => /^Folder lesson/.test(n)).length)).toBe(0);
});

test('sound check runs inline and ends in a verdict card', async ({ page }) => {
  test.setTimeout(40_000);
  await openApp(page);
  await page.mouse.click(5, 5);
  await expect.poll(() => page.evaluate(() => window.fullCapture.state.mic.status)).toBe('live');
  await page.click('#btnSoundCheck');
  await expect(page.locator('#scRun')).toBeVisible();
  await expect(page.locator('#scLine')).toBeVisible({ timeout: 8000 });
  await expect(page.locator('#scResult')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#scHeadline')).not.toBeEmpty();
  await expect(page.locator('#scHeadline')).toBeFocused();
});

test('camera bubble: preview appears and the recording carries the composited video', async ({ page }) => {
  await openApp(page);
  await page.check('#cameraToggle');
  await expect.poll(() => page.evaluate(() => window.fullCapture.state.camera.status)).toBe('live');
  await page.click('#btnChooseScreen');
  await expect(page.locator('#bubblePreview')).toBeVisible();
  await page.click('#btnStart');
  await expect.poll(() => phase(page), { timeout: 15_000 }).toBe('recording');
  expect(await page.evaluate(() => { const st = window.fullCapture.state; return !!st.take && st.camera.status === 'live'; })).toBe(true);
  await page.waitForTimeout(1500);
  const download = page.waitForEvent('download');
  await page.click('#btnStop');
  await download;
  await expect.poll(() => phase(page), { timeout: 20_000 }).toBe('review');
  const size = await page.evaluate(async () => {
    const v = document.getElementById('reviewVideo');
    if (!v.videoWidth) await new Promise(r => v.addEventListener('loadedmetadata', r, { once: true }));
    return [v.videoWidth, v.videoHeight];
  });
  expect(size[0]).toBeGreaterThan(0);
  expect(size[1]).toBeGreaterThan(0);
});

test('settings dialog: theme switch applies and persists', async ({ page }) => {
  await openApp(page);
  await page.click('#btnSettings');
  await expect(page.locator('#settingsDialog')).toBeVisible();
  await page.selectOption('#themeSelect', 'dark');
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
  await page.click('#btnSettingsClose');
  await expect(page.locator('#settingsDialog')).toBeHidden();
  const before = await page.evaluate(k => localStorage.getItem(k), SETTINGS_KEY);
  await page.reload();
  await page.waitForFunction(() => document.documentElement.dataset.ready === 'true');
  // What storage held on each side of the reload, if this ever fails.
  const after = await page.evaluate(k => ({ stored: localStorage.getItem(k), seeded: localStorage.getItem('full-capture:test-seeded'), theme: document.documentElement.dataset.theme ?? null }), SETTINGS_KEY);
  expect(after.theme, JSON.stringify({ before, after })).toBe('dark');
});

test('no horizontal scrolling at phone width in every view', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await openApp(page);
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(await overflow()).toBeLessThanOrEqual(1);
  await startRecording(page);
  expect(await overflow()).toBeLessThanOrEqual(1);
  await page.waitForTimeout(1200);
  const download = page.waitForEvent('download');
  await page.click('#btnStop');
  await download;
  await expect.poll(() => phase(page), { timeout: 20_000 }).toBe('review');
  expect(await overflow()).toBeLessThanOrEqual(1);
});

test('stopping screen share from the browser saves the take and explains why', async ({ page }) => {
  await openApp(page);
  await startRecording(page);
  await page.waitForTimeout(1200);
  const download = page.waitForEvent('download');
  await page.evaluate(() => {
    const track = window.fullCapture.state.screen.stream.getVideoTracks()[0];
    track.stop();
    track.dispatchEvent(new Event('ended'));
  });
  await download;
  await expect.poll(() => phase(page), { timeout: 20_000 }).toBe('review');
  await expect(page.locator('#reviewNotice')).toContainText('screen sharing ended');
});

