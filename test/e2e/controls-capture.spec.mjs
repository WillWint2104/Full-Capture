// A real recording of the whole screen, checked frame by frame: the floating
// controls must be in no frame when they hide themselves as the take starts,
// and in the frames after they are shown again (which proves the check sees
// them). A headed Chromium records its own X display (no fake screen; the
// microphone is a tone) while the controls are painted magenta from the moment
// their window opens. Every decoded frame of the saved file is measured with
// ffmpeg.
//
// Needs a display (CI runs the browser tests under xvfb-run), ffmpeg and
// ffprobe. When Xvfb is installed the test starts its own private 1280×720
// X server, so nothing else on the display can get into the picture and
// parallel runs can't see each other. Run `npm run build` first.
import { test, expect, chromium } from '@playwright/test';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { APP_URL } from './helpers.mjs';

const SETTINGS_KEY = 'full-capture:settings:v1';
const onPath = cmd => spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0;
// Frames are measured at this size; a pixel is the controls' when it is clearly magenta.
const W = 320, H = 180;
const CLEAN = 0.0005;        // at most 0.05 % of a frame (about 29 of 57 600 pixels) may look magenta
const SHOWN = 0.2;           // the controls cover far more than this of the 1280×720 screen when they are in the picture

/** Magenta share of every decoded video frame, with its time in seconds. */
function magentaFrames(file) {
  // stderr is kept out of the log (two frames can share a timestamp, which ffmpeg mentions); it is in the error if ffmpeg fails.
  const run = (cmd, args) => execFileSync(cmd, args, { maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'] });
  const raw = run('ffmpeg', ['-v', 'error', '-i', file, '-fps_mode', 'passthrough', '-vf', `scale=${W}:${H}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  const times = run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'csv=p=0', file])
    .toString().trim().split('\n').map(Number);
  const size = W * H * 3;
  const frames = [];
  for (let o = 0, i = 0; o + size <= raw.length; o += size, i++) {
    let m = 0;
    for (let k = o; k < o + size; k += 3) if (raw[k] > 200 && raw[k + 1] < 60 && raw[k + 2] > 200) m++;
    frames.push({ t: times[i], magenta: m / (W * H) });
  }
  expect(frames.length).toBe(times.length);
  return frames;
}

const describe = frames => frames.map(f => `${f.t.toFixed(2)}s:${(f.magenta * 100).toFixed(1)}%`).join(' ');

test.skip(!process.env.DISPLAY, 'needs a display: run the browser tests under xvfb-run');
test.setTimeout(120_000);

let xvfb = null, browser = null;
test.beforeAll(async () => {
  for (const tool of ['ffmpeg', 'ffprobe']) if (!onPath(tool)) throw new Error(`${tool} is needed to check the recorded frames`);
  let display = process.env.DISPLAY;
  if (onPath('Xvfb')) {
    xvfb = spawn('Xvfb', ['-displayfd', '1', '-screen', '0', '1280x720x24', '-nolisten', 'tcp'], { stdio: ['ignore', 'pipe', 'ignore'] });
    display = await new Promise((resolve, reject) => {
      let buf = '';
      xvfb.stdout.on('data', d => { buf += d; if (buf.includes('\n')) resolve(`:${buf.trim()}`); });
      xvfb.on('exit', code => reject(new Error(`Xvfb exited (${code})`)));
    });
  }
  browser = await chromium.launch({
    headless: false,
    env: { ...process.env, DISPLAY: display, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
    // A real screen capture: no fake screen, and the picker picks the whole screen.
    args: ['--auto-select-desktop-capture-source=Entire screen', '--autoplay-policy=no-user-gesture-required', '--window-position=0,0', '--window-size=1280,720'],
  });
});
test.afterAll(async () => {
  await browser?.close();
  xvfb?.kill();
});

/** Before the app boots: settings, a tone for a microphone, and magenta floating controls. */
function setUp([key, settings]) {
  try { if (!localStorage.getItem('full-capture:test-seeded')) { localStorage.setItem(key, settings); localStorage.setItem('full-capture:test-seeded', '1'); } } catch {}
  const md = navigator.mediaDevices;
  const real = md.getUserMedia.bind(md);
  md.getUserMedia = async c => {
    if (c?.audio && !c.video) {
      const ctx = new AudioContext();
      const tone = new OscillatorNode(ctx, { frequency: 300 });
      const out = ctx.createMediaStreamDestination();
      tone.connect(out);
      tone.start();
      return out.stream;
    }
    return real(c);
  };
  const pip = window.documentPictureInPicture;
  const request = pip.requestWindow.bind(pip);
  pip.requestWindow = async options => {
    const w = await request(options);
    const style = w.document.createElement('style');
    style.textContent = 'html, body, * { background: #ff00ff !important; color: #ff00ff !important; border-color: #ff00ff !important; box-shadow: none !important; }';
    w.document.head.append(style);
    // `window.__slowClose` ms: a window that takes its time to go (an animated close, a busy PC).
    const close = w.close.bind(w);
    w.close = () => { if (window.__slowClose) setTimeout(close, window.__slowClose); else close(); };
    return w;
  };
}

test('whole-screen takes: auto-hidden floating controls are in no recorded frame; shown again, they are', async ({}, testInfo) => {
  const context = await browser.newContext({ viewport: null, acceptDownloads: true, permissions: ['microphone'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  await page.addInitScript(setUp, [SETTINGS_KEY, JSON.stringify({ countdown: true, floatingControls: true, hidePreview: true })]);
  await page.goto(APP_URL);
  await page.waitForFunction(() => document.documentElement.dataset.ready === 'true');
  expect(await page.evaluate(() => 'documentPictureInPicture' in window && screen.isExtended === false)).toBe(true);
  await page.mouse.click(5, 5);
  await expect.poll(() => page.evaluate(() => window.fullCapture.state.mic.status)).toBe('live');
  await page.click('#btnChooseScreen');
  await expect(page.locator('#screenSummary')).toBeVisible({ timeout: 15_000 });
  expect(await page.evaluate(() => window.fullCapture.state.screen.surface)).toBe('monitor');

  const phase = () => page.evaluate(() => document.documentElement.dataset.phase);
  const pipOpen = () => page.evaluate(() => !!documentPictureInPicture.window);
  const settle = () => page.waitForTimeout(600);        // presses on a view in its first 500 ms are ignored
  const stopAndSave = async name => {
    await settle();
    const download = page.waitForEvent('download');
    await page.click('#btnStop');
    const file = testInfo.outputPath(name);
    await (await download).saveAs(file);
    await expect.poll(phase, { timeout: 20_000 }).toBe('review');
    return file;
  };

  // Take 1, the usual way: 3-2-1 in the floating controls, which go as the take starts.
  await page.click('#btnStart');
  await expect.poll(phase).toBe('countdown');
  await expect.poll(pipOpen).toBe(true);
  await expect.poll(phase, { timeout: 15_000 }).toBe('recording');
  const openWhenRecording = await pipOpen();
  await page.waitForTimeout(2000);
  const first = magentaFrames(await stopAndSave('take-1.webm'));
  expect(first.length).toBeGreaterThan(20);
  expect(first.filter(f => f.magenta > CLEAN), describe(first)).toEqual([]);
  expect(openWhenRecording).toBe(false);

  // Take 2: no countdown, so Start opens the controls just as the take begins, and their
  // window takes 400 ms to close. Then, 1.5 s in, Alt+H shows them again.
  await page.evaluate(() => { window.fullCapture.setCountdown(false); window.__slowClose = 400; });
  await settle();
  await page.click('#btnNewTake');
  await expect.poll(phase).toBe('ready');
  await settle();
  await page.click('#btnStart');
  await expect.poll(phase, { timeout: 15_000 }).toBe('recording');
  expect(await pipOpen()).toBe(false);
  await page.waitForTimeout(1500);
  const shownAt = await page.evaluate(() => window.fullCapture.state.take.elapsedMs) / 1000;
  await page.locator('#btnStop').focus();
  await page.keyboard.press('Alt+h');
  await expect.poll(pipOpen).toBe(true);
  await page.waitForTimeout(2000);
  const second = magentaFrames(await stopAndSave('take-2.webm'));
  const before = second.filter(f => f.t < shownAt - 0.1);
  const after = second.filter(f => f.t > shownAt + 1);
  expect(before.length).toBeGreaterThan(10);
  expect(after.length).toBeGreaterThan(10);
  expect(before.filter(f => f.magenta > CLEAN), describe(second)).toEqual([]);
  expect(after.filter(f => f.magenta < SHOWN), describe(second)).toEqual([]);

  expect(errors).toEqual([]);
  await context.close();
});
