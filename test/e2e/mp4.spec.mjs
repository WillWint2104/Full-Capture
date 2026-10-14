// A take saved as MP4 through the real app is a finished, seekable file: it
// reports its real length, seeks to several points, decodes after each seek
// and keeps sound and picture in sync there. Chrome's MediaRecorder writes
// fragmented MP4 with no length or seek index; the app indexes it on save.
// Checked with tools that share no code with the app: GStreamer (a player
// stack that trusts the file's header, like Windows' players), ffmpeg, and
// the page's own <video>. Needs ffmpeg and GStreamer's Python bindings
// (skipped without them, except in CI); run `npm run build` first.
import { test, expect } from '@playwright/test';
import { APP_URL, trackErrors } from './helpers.mjs';
import { ROOT, bundleScript } from '../../scripts/bundler.mjs';
import { finalizeMp4Blob } from '../../src/app/media/mp4.js';
import { syncStimulus, mp4InChromium, fakeFolder } from './stimulus.mjs';
import {
  hasFfmpeg, gstPython, gstProbe, ffprobeInfo, decodeErrors, boxes, child, durationOf, timescaleOf,
  flashesAndBeeps, syncOffsets, audioPackets,
} from '../tools/media.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SETTINGS_KEY = 'full-capture:settings:v1';
const PERIOD_S = 2;
const BEEP_S = 0.12;

let errors;
test.beforeEach(async ({ page }) => { errors = trackErrors(page); });
test.afterEach(() => { expect(errors.filter(e => !/favicon|Failed to load resource/.test(e))).toEqual([]); });
test.setTimeout(120_000);

/** Open the app recording MP4 from the sync stimulus. */
async function openApp(page, { folder = false } = {}) {
  await page.addInitScript(([key, value]) => {
    try { if (!localStorage.getItem('full-capture:test-seeded')) { localStorage.setItem(key, value); localStorage.setItem('full-capture:test-seeded', '1'); } } catch {}
  }, [SETTINGS_KEY, JSON.stringify({ countdown: false, floatingControls: false, hidePreview: true, format: 'mp4' })]);
  await page.addInitScript(mp4InChromium);
  await page.addInitScript(syncStimulus, { period: PERIOD_S, beep: BEEP_S });
  if (folder) await page.addInitScript(fakeFolder);
  await page.goto(APP_URL);
  await page.waitForFunction(() => document.documentElement.dataset.ready === 'true');
  await page.mouse.click(5, 5);
  await expect.poll(() => page.evaluate(() => window.fullCapture.state.mic.status)).toBe('live');
}

const phase = page => page.evaluate(() => document.documentElement.dataset.phase);

/** About 12 s of recording with a 2 s pause in the middle. */
async function recordTake(page) {
  await page.click('#btnChooseScreen');
  await expect(page.locator('#screenSummary')).toBeVisible();
  await page.click('#btnStart');
  await expect.poll(() => phase(page), { timeout: 15_000 }).toBe('recording');
  await page.waitForTimeout(6000);
  await page.click('#btnPause');
  await expect.poll(() => phase(page)).toBe('paused');
  await page.waitForTimeout(2000);
  await page.click('#btnResumeBig');
  await expect.poll(() => phase(page)).toBe('recording');
  await page.waitForTimeout(6000);
}

/** Everything a saved MP4 must be. */
async function checkSavedMp4(page, file, recordedMs, testInfo) {
  const bytes = new Uint8Array(readFileSync(file));
  const durationS = recordedMs / 1000;

  // 1. A player (GStreamer, which trusts the file's header) sees the real length and lands
  //    exactly where it seeks, with a picture. (Before the fix: about 2 s, and seeks fell short.)
  const targets = [0.15, 0.4, 0.65, 0.9].map(f => Math.round(f * durationS * 100) / 100);
  const g = gstProbe(file, targets);
  expect(Math.abs(g.duration - durationS)).toBeLessThan(0.5);
  expect(g.seekable).toBe(true);
  for (const s of g.seeks) {
    expect(s.accepted).toBe(true);
    expect(Math.abs(s.pts - s.target)).toBeLessThan(0.05);
    expect(s.bytes).toBeGreaterThan(0);
  }

  // 2. An ordinary indexed MP4 whose header holds the real length.
  const list = boxes(bytes);
  expect(list.map(b => b.type)).toEqual(['ftyp', 'mdat', 'moov']);
  const moov = list[2];
  expect(child(moov, 'mvex')).toBeNull();
  const headerS = durationOf(bytes, child(moov, 'mvhd')) / timescaleOf(bytes, child(moov, 'mvhd'));
  expect(Math.abs(headerS - durationS)).toBeLessThan(0.5);

  // 3. ffmpeg decodes all of it.
  expect(decodeErrors(file)).toBe('');
  const info = ffprobeInfo(file);
  expect(Math.abs(info.duration - headerS)).toBeLessThan(0.05);
  expect(Math.abs(g.duration - headerS)).toBeLessThan(0.1);

  // 4. After seeking (by the index), decoding starts at the right frame, and every flash and
  //    beep is where it was when the whole file was decoded: seeking keeps the sync. Saving
  //    keeps it too: the unit tests show the saved file holds exactly the packets (times,
  //    sizes, keyframes) MediaRecorder wrote. How good the recorded sync is, take by take, is
  //    av-sync.spec.mjs's job; this stimulus is drawn by the page, so a busy machine can delay
  //    or drop its flashes.
  const whole = flashesAndBeeps(file);
  const all = syncOffsets(whole);
  expect(all.length).toBeGreaterThanOrEqual(3);
  const after = [];
  const sound = audioPackets(file);
  // Seek between flashes that have their beep, so the window after each seek holds a pair.
  for (const { at: flash } of [all[0], all[Math.floor(all.length / 2) - 1], all.at(-2)]) {
    const from = Math.round((flash + 0.6) * 100) / 100;
    const seen = flashesAndBeeps(file, { from });
    // The first picture is a frame of the file at the seek point: not earlier, none skipped.
    const i = whole.frames.findIndex(t => Math.abs(t - seen.firstVideo) < 0.001);
    expect(i, `the first frame after seeking to ${from}s is a frame of the file`).toBeGreaterThanOrEqual(0);
    expect(seen.firstVideo).toBeGreaterThanOrEqual(from - 0.001);
    expect(i === 0 || whole.frames[i - 1] < from + 0.001).toBe(true);
    // Sound starts there too: at the seek point (or where the file's sound resumes, if it has a gap
    // there), and at most one packet and 20 ms later: ffmpeg starts reading at the video keyframe
    // it seeks to, so the audio packet holding the seek point can be skipped, and its Opus decoder
    // drops 20 ms after a jump while it warms up (a fragmented copy of the file does the same).
    const at = sound.find(p => p.end > from);
    expect(seen.firstAudio).toBeGreaterThanOrEqual(Math.max(from, at.pts) - 0.001);
    expect(seen.firstAudio).toBeLessThanOrEqual(at.end + 0.021);
    const pairs = syncOffsets(seen);
    expect(pairs.length).toBeGreaterThanOrEqual(1);
    for (const p of pairs) {
      const same = all.find(x => Math.abs(x.at - p.at) < 0.002);
      expect(same, `flash at ${p.at}s is where it was in the whole file`).toBeTruthy();
      expect(Math.abs(p.ms - same.ms)).toBeLessThanOrEqual(10);
      after.push({ from, ...p });
    }
  }

  // 5. The page's own player knows the length and seeks.
  const played = await page.evaluate(async ({ url, targets }) => {
    const v = document.createElement('video');
    v.muted = true;
    v.src = url;
    await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error('not playable')); });
    const seeks = [];
    for (const t of targets) {
      v.currentTime = t;
      await new Promise(r => v.addEventListener('seeked', r, { once: true }));
      seeks.push(v.currentTime);
    }
    return { duration: v.duration, seeks };
  }, { url: await page.evaluate(() => window.fullCapture.state.review.url), targets });
  expect(Math.abs(played.duration - headerS)).toBeLessThan(0.1);
  played.seeks.forEach((t, i) => expect(Math.abs(t - targets[i])).toBeLessThan(0.05));

  const report = { recordedMs, headerS, ffprobe: info.duration, gstreamer: g, sync: all, afterSeek: after, page: played };
  console.log('MP4 check:', JSON.stringify(report));
  await testInfo.attach('mp4-check.json', { body: JSON.stringify(report, null, 1), contentType: 'application/json' });
}

const tools = !(hasFfmpeg && gstPython) && !process.env.CI;

test('a take saved as MP4 to Downloads reports its length, seeks, decodes and stays in sync after seeking', async ({ page }, testInfo) => {
  test.skip(tools, 'ffmpeg and GStreamer (python3-gst-1.0) are needed to check the saved file');
  await openApp(page);
  await recordTake(page);
  const download = page.waitForEvent('download');
  await page.click('#btnStop');
  const dl = await download;
  expect(dl.suggestedFilename()).toMatch(/\.mp4$/);
  const file = testInfo.outputPath('take.mp4');
  await dl.saveAs(file);
  await expect.poll(() => phase(page), { timeout: 20_000 }).toBe('review');
  const recordedMs = await page.evaluate(() => window.fullCapture.state.review.durationMs);
  await checkSavedMp4(page, file, recordedMs, testInfo);
});

test('a take saved as MP4 into a folder is the same finished file', async ({ page }, testInfo) => {
  test.skip(tools, 'ffmpeg and GStreamer (python3-gst-1.0) are needed to check the saved file');
  await openApp(page, { folder: true });
  await page.evaluate(() => window.fullCapture.chooseFolder());
  await expect.poll(() => page.evaluate(() => window.fullCapture.state.folder.status)).toBe('ready');
  await recordTake(page);
  await page.click('#btnStop');
  await expect.poll(() => phase(page), { timeout: 20_000 }).toBe('review');
  const review = await page.evaluate(() => ({ ...window.fullCapture.state.review }));
  expect(review.savedTo).toBe('folder');
  expect(review.filename).toMatch(/\.mp4$/);
  const b64 = await page.evaluate(async name => {
    const f = window.__files.get(name);
    const bytes = new Uint8Array(await f.arrayBuffer());
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }, review.filename);
  const file = testInfo.outputPath('take.mp4');
  writeFileSync(file, Buffer.from(b64, 'base64'));
  await checkSavedMp4(page, file, review.durationMs, testInfo);
});

test('the folder sink indexes an MP4 through Chrome’s own file stream, byte for byte', async ({ page }) => {
  // The origin-private file system gives a real FileSystemWritableFileStream (temporary file,
  // committed on close, positioned writes); it needs a secure origin, so the page is served
  // as http://localhost (from memory: nothing listens there).
  await page.route('http://localhost:1/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>OPFS</title>' }));
  await page.goto('http://localhost:1/');
  const { text } = await bundleScript(path.resolve(ROOT, 'test/e2e/harness/recording.entry.js'));
  await page.addScriptTag({ content: text });
  const raw = readFileSync(path.resolve(ROOT, 'test/fixtures/mediarecorder-h264-opus.mp4'));
  const saved = await page.evaluate(async b64 => {
    const bytes = Uint8Array.from(atob(b64), ch => ch.charCodeAt(0));
    const root = await navigator.storage.getDirectory();
    for await (const name of root.keys()) await root.removeEntry(name);
    window.showDirectoryPicker = async () => root;
    const store = new window.rec.FolderStore();
    await store.choose();
    const sink = new window.rec.FolderSink(store);
    await sink.open({ filename: 'Lesson.mp4', container: 'mp4' });
    for (let p = 0; p < bytes.length; p += 30_000) await sink.write(new Blob([bytes.subarray(p, p + 30_000)]));
    const before = (await (await root.getFileHandle(sink.filename)).getFile()).size;
    const r = await sink.finalize({ durationMs: 4000 });
    const out = new Uint8Array(await (await (await root.getFileHandle(r.filename)).getFile()).arrayBuffer());
    let s = '';
    for (let i = 0; i < out.length; i += 0x8000) s += String.fromCharCode(...out.subarray(i, i + 0x8000));
    return { before, size: r.size, b64: btoa(s) };
  }, raw.toString('base64'));
  expect(saved.before).toBe(0);   // nothing reaches the real file until it is finished
  const expected = new Uint8Array(await (await finalizeMp4Blob(new Blob([raw]))).blob.arrayBuffer());
  const got = new Uint8Array(Buffer.from(saved.b64, 'base64'));
  expect(saved.size).toBe(expected.length);
  expect(Buffer.compare(Buffer.from(got), Buffer.from(expected))).toBe(0);
  expect(boxes(got).map(b => b.type)).toEqual(['ftyp', 'mdat', 'moov']);
});
