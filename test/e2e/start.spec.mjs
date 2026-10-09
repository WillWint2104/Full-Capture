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

test('a double-click on Start or on Stop & save: the second click never lands on the view that appears', async ({ page }) => {
  // A person's second click comes 100-250 ms after the first; a take records ~30 ms after
  // Start, and Review is up ~90 ms after Stop & save. At 1920×1080 Pause sits under Start.
  await page.setViewportSize({ width: 1920, height: 1080 });
  await openApp(page);
  await micLive(page);
  await chooseScreen(page);
  const at = async (id, fx = 0.5) => { const b = await page.locator(id).boundingBox(); return [b.x + b.width * fx, b.y + b.height * 0.45]; };
  const [sx, sy] = await at('#btnStart', 0.25);
  await page.mouse.click(sx, sy);
  await page.waitForFunction(() => window.fullCapture.state.phase === 'recording', null, { polling: 5 });
  await page.mouse.click(sx, sy);
  await page.waitForTimeout(800);
  expect(await phase(page)).toBe('recording');         // not paused by a click on Pause
  expect(await state(page, st => st.take.markers.length)).toBe(0);
  const [tx, ty] = await at('#btnStop');
  const download = page.waitForEvent('download');
  await page.mouse.click(tx, ty);
  await download;
  await page.waitForFunction(() => window.fullCapture.state.phase === 'review', null, { polling: 5, timeout: 20_000 });
  await page.mouse.click(tx, ty);
  await page.waitForTimeout(800);
  expect(await phase(page)).toBe('review');            // not sent on by "Record another take"
  // Once the view has settled, the keyboard works as usual.
  await page.locator('#btnNewTake').focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => phase(page)).toBe('ready');
});

/** A lessons folder whose files take `window.__openDelay` ms to open. */
const slowFolder = () => {
  const files = new Map();
  window.__openDelay = 0;
  const dir = {
    kind: 'directory', name: 'Lessons',
    async queryPermission() { return 'granted'; },
    async requestPermission() { return 'granted'; },
    async getFileHandle(name, opts = {}) {
      if (!files.has(name)) { if (!opts.create) throw new DOMException('not found', 'NotFoundError'); files.set(name, new Blob([])); }
      return {
        kind: 'file', name,
        async createWritable() {
          await new Promise(r => setTimeout(r, window.__openDelay));
          const parts = [];
          return { async write(d) { if (!(d && d.type === 'write')) parts.push(d); }, async close() { files.set(name, new Blob(parts)); }, async abort() {} };
        },
        async getFile() { return new File([files.get(name)], name); },
      };
    },
    async removeEntry(name) { files.delete(name); },
  };
  window.showDirectoryPicker = async () => dir;
};

/** Keep the crash journal's store busy from another connection for `ms`. */
const holdJournal = (page, ms) => page.evaluate(ms => new Promise((resolve, reject) => {
  const r = indexedDB.open('full-capture');
  r.onerror = () => reject(r.error);
  r.onsuccess = () => {
    const store = r.result.transaction(['journalMeta'], 'readwrite').objectStore('journalMeta');
    const until = performance.now() + ms;
    const spin = () => { if (performance.now() < until) store.get('x').onsuccess = spin; };
    spin();
    resolve();
  };
}), ms);

test('storage that doesn’t answer: the take still starts within seconds, without its safety copy, and says so', async ({ page }) => {
  await openApp(page);
  await micLive(page);
  await chooseScreen(page);
  await holdJournal(page, 15_000);
  const t0 = Date.now();
  await page.click('#btnStart');
  await expect.poll(() => phase(page), { timeout: 10_000 }).toBe('recording');
  expect(Date.now() - t0).toBeLessThan(8000);
  await expect(page.locator('#toasts')).toContainText('didn’t answer in time');
  expect(await state(page, st => st.take.safetyCopy)).toBe(false);
});

test('a lessons folder that doesn’t answer: the take starts anyway and will download instead', async ({ page }) => {
  await openApp(page, {}, [slowFolder]);
  await micLive(page);
  await page.evaluate(() => window.fullCapture.chooseFolder());
  await expect.poll(() => state(page, st => st.folder.status)).toBe('ready');
  await chooseScreen(page);
  await page.evaluate(() => { window.__openDelay = 20_000; });
  await page.click('#btnStart');
  await expect.poll(() => phase(page), { timeout: 12_000 }).toBe('recording');
  await expect(page.locator('#toasts')).toContainText('Couldn’t write to your folder');
  expect(await state(page, st => st.take.savingTo)).toBe('memory');
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

// ---- Findings of the independent review ------------------------------------

/** Every phase seen during `ms` (catches brief ones). */
const watchPhases = (page, ms) => page.evaluate(ms => new Promise(resolve => {
  const seen = [document.documentElement.dataset.phase];
  const off = window.fullCapture.on('change', st => { if (seen[seen.length - 1] !== st.phase) seen.push(st.phase); });
  setTimeout(() => { off(); resolve(seen); }, ms);
}), ms);

/** A microphone permission the test controls; every mic track handed out is kept. */
const controllablePermission = () => {
  const perm = { state: 'granted', onchange: null };
  window.__perm = { set(s) { perm.state = s; perm.onchange?.(); } };
  const realQuery = navigator.permissions.query.bind(navigator.permissions);
  navigator.permissions.query = async d => (d?.name === 'microphone' ? perm : realQuery(d));
  const md = navigator.mediaDevices;
  const real = md.getUserMedia.bind(md);
  window.__micTracks = [];
  md.getUserMedia = async c => {
    if (c?.audio && perm.state === 'denied') throw new DOMException('Permission denied', 'NotAllowedError');
    const st = await real(c);
    if (c?.audio) window.__micTracks.push(...st.getAudioTracks());
    return st;
  };
};

/** Screen picks: plan[i] = {delay} or {reject, delay} for the i-th getDisplayMedia call. */
const plannedPicks = plan => {
  const md = navigator.mediaDevices;
  const real = md.getDisplayMedia.bind(md);
  let n = 0;
  md.getDisplayMedia = async o => {
    const step = plan[n++] || {};
    await new Promise(r => setTimeout(r, step.delay || 0));
    if (step.reject) throw new DOMException('Permission denied by user', step.reject);
    return real(o);
  };
};

test('the microphone blocked mid-take and then allowed again: the voice comes back', async ({ page }) => {
  await openApp(page, {}, [controllablePermission]);
  await micLive(page);
  await chooseScreen(page);
  await page.click('#btnStart');
  await expect.poll(() => phase(page), { timeout: 15_000 }).toBe('recording');
  await page.evaluate(() => {
    window.__perm.set('denied');
    for (const t of window.__micTracks) { t.stop(); t.dispatchEvent(new Event('ended')); }
  });
  await expect.poll(() => state(page, st => st.mic.status), { timeout: 10_000 }).toBe('blocked');
  await expect(page.locator('#banners')).toContainText('without your voice');
  await page.evaluate(() => window.__perm.set('granted'));
  await expect.poll(() => state(page, st => st.mic.status), { timeout: 5000 }).toBe('live');
  expect(await phase(page)).toBe('recording');
  expect(await state(page, st => st.alerts.some(a => a.id === 'mic-lost'))).toBe(false);
});

test('a Change pick cancelled while Start waits for it: no take starts on the old screen', async ({ page }) => {
  await openApp(page, {}, [keepRecorded], [plannedPicks, [{ delay: 0 }, { reject: 'NotAllowedError', delay: 1000 }]]);
  await micLive(page);
  await chooseScreen(page);
  await page.click('#btnChooseScreen');           // "Change": the picker is open
  await page.waitForTimeout(150);
  await page.keyboard.press('Alt+r');             // the same path as the floating Start
  await expect(page.locator('#toasts')).toContainText('No screen chosen');
  await page.waitForTimeout(1000);
  expect(await phase(page)).toBe('ready');
  expect(await page.evaluate(() => window.__recorded.length)).toBe(0);
});

for (const how of ['twice', 'held']) {
  test(`Enter pressed ${how} on Start: the new take keeps recording`, async ({ page }) => {
    await openApp(page);
    await micLive(page);
    await chooseScreen(page);
    await page.waitForTimeout(600);
    await page.locator('#btnStart').focus();
    const seen = watchPhases(page, 3000);
    if (how === 'twice') {
      await page.keyboard.press('Enter');
      await page.waitForTimeout(200);
      await page.keyboard.press('Enter');
    } else {
      await page.keyboard.down('Enter');
      await page.waitForTimeout(500);               // the usual auto-repeat delay
      for (let i = 0; i < 6; i++) { await page.keyboard.down('Enter'); await page.waitForTimeout(33); }
      await page.keyboard.up('Enter');
    }
    expect(await seen).not.toContain('stopping');
    expect(await phase(page)).toBe('recording');
  });
}

test('a camera switched off while it was still opening is not waited for', async ({ page }) => {
  await openApp(page, {}, [slowCamera, { delay: 20_000 }]);
  await micLive(page);
  await chooseScreen(page);
  await page.check('#cameraToggle');
  await expect.poll(() => state(page, st => st.camera.status)).toBe('starting');
  await page.uncheck('#cameraToggle');
  await page.waitForTimeout(600);
  const t0 = Date.now();
  await page.click('#btnStart');
  await expect.poll(() => phase(page), { timeout: 10_000 }).toBe('recording');
  expect(Date.now() - t0).toBeLessThan(2000);
});

test('the floating controls show the start under way, with a Cancel that works', async ({ page }) => {
  await openApp(page, { floatingControls: true }, [fakePip], [slowCamera, { delay: 20_000 }]);
  await micLive(page);
  await chooseScreen(page);
  await recordAndStop(page);                        // Start opened the floating controls
  await page.evaluate(() => { window.fullCapture.setCamera(true); });
  await expect.poll(() => state(page, st => st.camera.status)).toBe('starting');
  await page.evaluate(() => window.__pip.document.querySelector('[data-action="start"]').click());
  await expect.poll(() => state(page, st => st.preparing)).toBe(true);
  const pip = await page.evaluate(() => {
    const d = window.__pip.document, b = d.querySelector('[data-action="start"]');
    return { pill: d.querySelector('[data-field="pill"]').textContent, start: b.textContent.trim(), disabled: b.getAttribute('aria-disabled') };
  });
  expect(pip).toEqual({ pill: 'Starting…', start: 'Cancel', disabled: null });
  await page.waitForTimeout(500);                   // past the 400 ms double-press guard
  await page.evaluate(() => window.__pip.document.querySelector('[data-action="start"]').click());
  await expect(page.locator('#toasts')).toContainText('Recording cancelled');
  await expect.poll(() => state(page, st => st.preparing), { timeout: 5000 }).toBe(false);
  expect(['ready', 'review']).toContain(await phase(page));
});

test('Discard confirmed after the take was thrown away elsewhere says it had already ended', async ({ page }) => {
  await openApp(page);
  await micLive(page);
  await chooseScreen(page);
  await page.click('#btnStart');
  await expect.poll(() => phase(page), { timeout: 15_000 }).toBe('recording');
  await page.waitForTimeout(700);
  await page.click('#btnDiscard');
  await expect(page.locator('#confirmDialog')).toBeVisible();
  await page.evaluate(() => window.fullCapture.cancelTake());   // e.g. Discard in the floating controls
  await expect.poll(() => phase(page)).not.toBe('recording');
  await page.click('#btnConfirmOk');
  await expect(page.locator('#toasts')).toContainText('had already ended');
  await expect(page.locator('#toasts')).not.toContainText('already saved');
});


test('Discard confirmed while a take stopped elsewhere is still saving says it was saved', async ({ page }) => {
  await openApp(page, {}, [() => {
    const real = MediaRecorder.prototype.stop;   // saving takes a couple of seconds
    MediaRecorder.prototype.stop = function () { setTimeout(() => real.call(this), 2000); };
  }]);
  await micLive(page);
  await chooseScreen(page);
  await page.click('#btnStart');
  await expect.poll(() => phase(page), { timeout: 15_000 }).toBe('recording');
  await page.waitForTimeout(1500);
  await page.click('#btnDiscard');
  await expect(page.locator('#confirmDialog')).toBeVisible();
  const download = page.waitForEvent('download');
  await page.evaluate(() => { window.fullCapture.stop(); });   // e.g. Stop & save in the floating controls
  await expect.poll(() => phase(page)).toBe('stopping');
  await page.click('#btnConfirmOk');
  await download;
  await expect(page.locator('#toasts')).toContainText('That take was already saved');
  await expect(page.locator('#toasts')).not.toContainText('nothing left to discard');
  expect(await state(page, st => st.library.length)).toBe(1);
});
