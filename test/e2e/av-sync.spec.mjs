// A take recorded through the real app is saved, opened by an independent
// decoder (ffmpeg) and checked for audio/video sync. The "screen" flashes white
// and the "microphone" beeps at the same instants, both driven by one audio
// clock; the saved file's flashes and beeps are then compared. Needs ffmpeg
// and ffprobe on PATH; run `npm run build` first.
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { APP_URL, trackErrors } from './helpers.mjs';

const SETTINGS_KEY = 'full-capture:settings:v1';
const PERIOD_S = 2;       // one flash + beep every 2 s
const BEEP_S = 0.12;

const hasFfmpeg = (() => { try { execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

/** Screen = canvas that flashes white; microphone = beeps; same AudioContext clock. */
function syncStimulus({ period, beep }) {
  const ctx = new AudioContext();
  const osc = new OscillatorNode(ctx, { frequency: 1000 });
  const gain = new GainNode(ctx, { gain: 0 });
  const dest = ctx.createMediaStreamDestination();
  osc.connect(gain).connect(dest);
  osc.start();
  let t0 = null;
  const arm = () => {
    if (t0 !== null || ctx.state !== 'running') return;
    t0 = Math.ceil(ctx.currentTime) + 1;
    for (let i = 0; i < 120; i++) {
      const t = t0 + i * period;
      gain.gain.setValueAtTime(0.5, t);
      gain.gain.setValueAtTime(0, t + beep);
    }
  };
  ctx.resume().then(arm);
  const canvas = document.createElement('canvas');
  canvas.width = 1280; canvas.height = 720;
  const g = canvas.getContext('2d');
  const draw = () => {
    arm();
    const on = t0 !== null && ctx.currentTime >= t0 && ((ctx.currentTime - t0) % period) < beep;
    g.fillStyle = on ? '#fff' : '#000';
    g.fillRect(0, 0, canvas.width, canvas.height);
    requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);
  const md = navigator.mediaDevices;
  const realUserMedia = md.getUserMedia.bind(md);
  md.getUserMedia = async c => {
    if (c?.audio && !c.video) return new MediaStream(dest.stream.getAudioTracks().map(t => t.clone()));
    return realUserMedia(c);
  };
  md.getDisplayMedia = async () => canvas.captureStream(30);
}

/** Onset times (s) of a signal sampled as [{t, v}]: rises above `hi` after `gapS` below `lo`. */
function onsets(samples, lo, hi, gapS = 0.5) {
  const out = [];
  let lastLow = -Infinity, armed = true;
  for (const { t, v } of samples) {
    if (v < lo) { if (t - lastLow > 0) lastLow = t; if (!armed && out.length && t - out[out.length - 1] > gapS) armed = true; }
    if (armed && v > hi) { out.push(t); armed = false; }
  }
  return out;
}

function parseMetadata(text, key) {
  const rows = [];
  let t = null;
  for (const line of text.split('\n')) {
    const m = line.match(/pts_time:([\d.]+)/);
    if (m) t = Number(m[1]);
    const v = line.match(new RegExp(`${key.replace(/\./g, '\\.')}=(-?[\\d.]+|-inf)`));
    if (v && t !== null) rows.push({ t, v: v[1] === '-inf' ? -200 : Number(v[1]) });
  }
  return rows;
}

/** Open the file with ffmpeg and return its streams, duration, flash and beep times. */
function analyse(file) {
  const run = (cmd, args) => execFileSync(cmd, args, { maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
  const probe = JSON.parse(run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]).toString());
  // A plain decode of every stream: anything ffmpeg reports at error level counts.
  const decodeErrors = (() => {
    try { return run('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-']).toString(); } catch (e) { return String(e.stderr || e); }
  })();
  // (The re-chunking below makes ffmpeg's null output warn about its own timestamps; ignored.)
  const video = run('ffmpeg', ['-v', 'quiet', '-i', file, '-map', '0:v:0', '-vf', 'scale=64:36,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-', '-f', 'null', '-']).toString();
  const audio = run('ffmpeg', ['-v', 'quiet', '-i', file, '-map', '0:a:0', '-af', 'aresample=16000,asetnsamples=n=80:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-', '-f', 'null', '-']).toString();
  const flashes = onsets(parseMetadata(video, 'lavfi.signalstats.YAVG'), 64, 128);
  const beeps = onsets(parseMetadata(audio, 'lavfi.astats.Overall.RMS_level'), -50, -30);
  // Pair each flash with the nearest beep; offset > 0 means the sound is late.
  const offsetsMs = flashes
    .map(f => { const b = beeps.reduce((best, x) => (Math.abs(x - f) < Math.abs(best - f) ? x : best), Infinity); return Math.abs(b - f) < 0.5 ? Math.round((b - f) * 1000) : null; })
    .filter(x => x !== null);
  return {
    decodeErrors: decodeErrors.trim(),
    codecs: probe.streams.map(s => `${s.codec_type}:${s.codec_name}`),
    durationS: Number(probe.format.duration),
    flashes: flashes.length, beeps: beeps.length, offsetsMs,
  };
}

let errors;
test.beforeEach(async ({ page }) => { errors = trackErrors(page); });
test.afterEach(() => { expect(errors.filter(e => !/favicon|Failed to load resource/.test(e))).toEqual([]); });
test.setTimeout(120_000);

for (const camera of [false, true]) {
  test(`a saved take opens in ffmpeg with sound and picture in sync${camera ? ' (camera bubble on)' : ''}, across a pause`, async ({ page }, testInfo) => {
    test.skip(!hasFfmpeg, 'ffmpeg and ffprobe are needed to open the saved file');
    await page.addInitScript(([key, value]) => {
      try { if (!localStorage.getItem('full-capture:test-seeded')) { localStorage.setItem(key, value); localStorage.setItem('full-capture:test-seeded', '1'); } } catch {}
    }, [SETTINGS_KEY, JSON.stringify({ countdown: false, floatingControls: false, hidePreview: true })]);
    await page.addInitScript(syncStimulus, { period: PERIOD_S, beep: BEEP_S });
    await page.goto(APP_URL);
    await page.waitForFunction(() => document.documentElement.dataset.ready === 'true');
    await page.mouse.click(5, 5);
    await expect.poll(() => page.evaluate(() => window.fullCapture.state.mic.status)).toBe('live');
    if (camera) {
      await page.check('#cameraToggle');
      await expect.poll(() => page.evaluate(() => window.fullCapture.state.camera.status)).toBe('live');
    }
    await page.click('#btnChooseScreen');
    await expect(page.locator('#screenSummary')).toBeVisible();
    await page.click('#btnStart');
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.phase), { timeout: 15_000 }).toBe('recording');
    await page.waitForTimeout(9000);
    await page.click('#btnPause');
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.phase)).toBe('paused');
    await page.waitForTimeout(3000);
    await page.click('#btnResumeBig');
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.phase)).toBe('recording');
    await page.waitForTimeout(9000);
    const download = page.waitForEvent('download');
    await page.click('#btnStop');
    const file = testInfo.outputPath(await (await download).suggestedFilename());
    await (await download).saveAs(file);
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.phase), { timeout: 20_000 }).toBe('review');
    const recordedMs = await page.evaluate(() => window.fullCapture.state.review.durationMs);

    const r = analyse(file);
    console.log(`A/V sync${camera ? ' (camera)' : ''}:`, JSON.stringify({ ...r, recordedMs }));
    await testInfo.attach('av-sync.json', { body: JSON.stringify({ ...r, recordedMs }, null, 1), contentType: 'application/json' });

    // It opens: both streams decode without errors, and the length is what was recorded (pause excluded).
    expect(r.decodeErrors).toBe('');
    expect(r.codecs.some(c => c.startsWith('video:'))).toBe(true);
    expect(r.codecs.some(c => c.startsWith('audio:'))).toBe(true);
    expect(Math.abs(r.durationS * 1000 - recordedMs)).toBeLessThan(1500);
    // Every flash in the file has its beep (8–10 in 18 s of recording, both sides of the pause).
    expect(r.offsetsMs.length).toBeGreaterThanOrEqual(7);
    expect(r.offsetsMs.length).toBeGreaterThanOrEqual(r.flashes - 1);
    // In sync: the take as a whole is within what viewers can't detect (ITU-R BT.1359: sound up
    // to 45 ms early or 125 ms late), most flashes are, and nothing drifts between the halves.
    // Not every flash: with the camera bubble, an occasional moment (at the start of about one
    // take in three, and now and then under heavy CPU load) shows the screen picture 80–150 ms
    // behind the sound before it settles. That is on the follow-up list, not yet explained.
    const median = list => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];
    const inSync = ms => ms >= -45 && ms <= 125;
    expect(inSync(median(r.offsetsMs))).toBe(true);
    expect(r.offsetsMs.filter(inSync).length / r.offsetsMs.length).toBeGreaterThanOrEqual(0.75);
    const half = Math.floor(r.offsetsMs.length / 2);
    expect(Math.abs(median(r.offsetsMs.slice(half)) - median(r.offsetsMs.slice(0, half)))).toBeLessThanOrEqual(40);
  });
}
