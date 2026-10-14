// Full Capture acceptance run on real hardware: the installed Chrome and Edge,
// the real microphone (and camera, if asked), real screen capture and a test
// pattern as the only thing on screen. Every saved take is checked with
// ffmpeg/ffprobe (analyse.mjs). Evidence and a draft results report go to a
// folder outside the repository. See test/windows/README.md.
//
//   node test/windows/run.mjs [--browsers chrome,msedge] [--seconds 60] [--camera] [--guided]
//
// Nothing here changes the app. The kit only watches it (and paints the
// floating controls magenta so frames can be checked), except where a check
// says "simulated".
import { chromium } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const APP_FILE = path.join(ROOT, 'full-capture.html');
const APP_URL = pathToFileURL(APP_FILE).href;
const PATTERN_TITLE = 'FC acceptance pattern';
// The pattern's window in the sharing window: its title is "FC acceptance pattern - Google Chrome" (the tab is just "FC acceptance pattern").
const WINDOW_SOURCE = `${PATTERN_TITLE} - `;
const SETTINGS_KEY = 'full-capture:settings:v1';
const LESSON = 'Acceptance test';
const SETTLE = 650;              // the app ignores presses in a view's first 500 ms
const RECOVERY_S = 30;           // recorded before the tab crashes or the browser is ended (as in docs/ACCEPTANCE.md)
const LOST_OK_S = 3.5;           // seconds a recovered take may lack at its end and pass
const LOST_MAX_S = 5;            // more than this is a failure
const WIN = process.platform === 'win32';

// ------------------------------------------------------------------ options

const HELP = `Usage: node test/windows/run.mjs [options]
  --browsers LIST    chrome,msedge (default on Windows) or chromium (Playwright's own)
  --out DIR          evidence folder, outside the repository (default ~/FullCaptureAcceptance/<date-time>)
  --seconds N        length of the main take, without its pause (default 60)
  --camera           camera bubble on for the main take (records your webcam)
  --only LIST        main,takes,reliability,recovery,window (default: all)
  --guided [LIST]    also the steps that need you: speak,stop-sharing,folder (the default), and
                     unplug (only with a microphone or headset you can unplug)
  --source TEXT      what the screen picker picks by itself (default "Entire screen", "Screen 1" with two screens)
  --window-source T  the window the picker picks for the window take (default "FC acceptance pattern - ")
  --no-sound         the test pattern flashes without clicks
  --ffmpeg-dir DIR   folder with ffmpeg and ffprobe, when they aren't on PATH
  --keep-profile     keep the test browser profiles (they hold safety copies of the test takes)
  --self-test        for checking the kit on a machine without a microphone or H.264: a synthetic
                     microphone and VP9 in MP4. Never for acceptance (the report says so).`;

function parseArgs(argv) {
  const o = { browsers: null, out: null, seconds: 60, camera: false, only: null, guided: null, source: null, windowSource: null, sound: true, ffmpegDir: null, keepProfile: false, selfTest: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { const v = argv[++i]; if (v == null) throw new Error(`${a} needs a value`); return v; };
    if (a === '--browsers') o.browsers = next().split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--out') o.out = path.resolve(next());
    else if (a === '--seconds') o.seconds = Math.max(10, Number(next()) || 60);
    else if (a === '--camera') o.camera = true;
    else if (a === '--only') o.only = next().split(',');
    else if (a === '--guided') o.guided = argv[i + 1] && !argv[i + 1].startsWith('--') ? next().split(',') : ['speak', 'stop-sharing', 'folder'];
    else if (a === '--source') o.source = next();
    else if (a === '--window-source') o.windowSource = next();
    else if (a === '--no-sound') o.sound = false;
    else if (a === '--ffmpeg-dir') o.ffmpegDir = path.resolve(next());
    else if (a === '--keep-profile') o.keepProfile = true;
    else if (a === '--self-test') o.selfTest = true;
    else if (a === '--help' || a === '-h') { console.log(HELP); process.exit(0); }
    else throw new Error(`Unknown option ${a}\n${HELP}`);
  }
  o.browsers ||= WIN ? ['chrome', 'msedge'] : ['chromium'];
  for (const b of o.browsers) if (!/^(chromium|chrome|msedge)(-beta|-dev|-canary)?$/.test(b)) throw new Error(`Unknown browser "${b}": use chrome, msedge or chromium`);
  for (const g of o.guided || []) if (!['speak', 'unplug', 'stop-sharing', 'folder'].includes(g)) throw new Error(`Unknown guided step "${g}"`);
  o.guided ||= [];
  return o;
}

const OPT = parseArgs(process.argv.slice(2));
if (OPT.ffmpegDir) process.env.PATH = `${OPT.ffmpegDir}${path.delimiter}${process.env.PATH}`;
const A = await import('./analyse.mjs');
const want = s => !OPT.only || OPT.only.includes(s);

const stamp = new Date().toISOString().replace(/[:T]/g, '-').replace(/\..*/, '');
const OUT = OPT.out || path.join(os.homedir(), 'FullCaptureAcceptance', stamp);
const insideRepo = !path.relative(ROOT, OUT).startsWith('..') && !path.isAbsolute(path.relative(ROOT, OUT));
if (insideRepo) throw new Error(`The evidence folder must be outside the repository (it holds recordings): ${OUT}`);
if (fs.existsSync(OUT) && fs.readdirSync(OUT).length) throw new Error(`${OUT} already has files in it; pick a new --out (nothing is overwritten).`);
fs.mkdirSync(OUT, { recursive: true });
// The run saves a few hundred MB of takes; never start it on a nearly full disk.
try {
  const st = fs.statfsSync(OUT);
  if (st.bavail * st.bsize < 5e9) throw new Error(`Only ${(st.bavail * st.bsize / 1e9).toFixed(1)} GB free where the evidence goes (${OUT}); the kit needs 5 GB. Free some space or pass --out on another drive.`);
} catch (e) { if (!/GB free/.test(e.message)) console.warn(`Couldn't check the free space: ${e.message}`); else throw e; }

// ------------------------------------------------------------------ logging and results

const LOG = path.join(OUT, 'run.log');
const HOME_FORMS = [...new Set([os.homedir(), os.homedir().replace(/\\/g, '/'), encodeURI(os.homedir().replace(/\\/g, '/'))])];
/** A path or message with the home folder (and so the user name) replaced. */
const show = p => (p ? HOME_FORMS.reduce((t, h) => t.split(h).join(WIN ? '%USERPROFILE%' : '~'), String(p)) : p);
function log(msg) {
  const line = `${new Date().toISOString().slice(11, 19)} ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG, line + '\n');
}
/** Something only the person at the computer can do: said plainly, then the kit waits and watches. */
function action(msg, S) {
  log(`ACTION NEEDED: ${msg}`);
  S?.pattern?.evaluate(t => window.pattern?.say(t), msg).catch(() => {});
}
const done = S => S?.pattern?.evaluate(() => window.pattern?.say('')).catch(() => {});

const results = [];
const ICON = { pass: 'PASS', fail: 'FAIL', warn: 'WARN', 'not run': 'SKIP', manual: 'MANUAL', info: 'INFO' };
/** One check's outcome. devices: 'real' | 'simulated' | 'self-test' | 'n/a'. */
function record(browser, section, id, title, status, detail, { devices = 'real', evidence = [] } = {}) {
  if (OPT.selfTest && devices === 'real') devices = 'self-test';
  // Evidence inside the evidence folder is listed relative to it; anything else as a full path.
  const where = e => (path.relative(OUT, e).startsWith('..') ? show(e) : path.relative(OUT, e));
  results.push({ browser, section, id, title, status, detail, devices, evidence: evidence.filter(Boolean).map(where) });
  log(`${ICON[status] || status} [${browser || 'all'}] ${title}: ${detail}`);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
/** Poll until fn() is truthy (returns it) or the time is up (returns the last value). */
async function until(fn, ms = 15_000, step = 200) {
  const end = Date.now() + ms;
  let v;
  do {
    try { v = await fn(); if (v) return v; } catch { /* page busy or navigating */ }
    await sleep(step);
  } while (Date.now() < end);
  return v;
}
const sha256 = buf => createHash('sha256').update(buf).digest('hex');
const s1 = ms => (ms / 1000).toFixed(1);

// ------------------------------------------------------------------ in the page

/**
 * Init script for every page. In the app: settings for a first visit, magenta
 * floating controls, MediaRecorder's own output kept (to compare with the saved
 * file), the microphone tracks, toasts and wake locks noted; `?kit-low-disk`
 * reports 1.2 GB free (simulated). With selfTest: a synthetic microphone that
 * clicks with the test pattern, and VP9 in MP4 where H.264 isn't available.
 */
function instrument({ settingsKey, lesson, selfTest, periodMs }) {
  if (!/full-capture\.html$/i.test(location.pathname)) return;
  try {
    if (!localStorage.getItem('fc-kit-seeded')) {
      localStorage.setItem(settingsKey, JSON.stringify({ lessonName: lesson }));
      localStorage.setItem('fc-kit-seeded', '1');
    }
  } catch { /* storage blocked: the app's defaults */ }

  const pip = window.documentPictureInPicture;
  if (pip?.requestWindow) {
    const request = pip.requestWindow.bind(pip);
    pip.requestWindow = async options => {
      const w = await request(options);
      const style = w.document.createElement('style');
      style.textContent = 'html, body, * { background: #ff00ff !important; color: #ff00ff !important; border-color: #ff00ff !important; box-shadow: none !important; }';
      w.document.head.append(style);
      return w;
    };
  }

  const Real = window.MediaRecorder;
  const realSupported = Real.isTypeSupported.bind(Real);
  const mp4 = t => (selfTest && /^video\/mp4/i.test(t || '') && /avc1/i.test(t) && !realSupported('video/mp4;codecs=avc1') ? 'video/mp4;codecs=vp9,opus' : t);
  window.__kitRecStarts = 0;
  window.__kitRaw = null;
  class KitRecorder extends Real {
    constructor(stream, options = {}) {
      super(stream, { ...options, mimeType: mp4(options.mimeType) });
      if (stream.getVideoTracks().length) {
        const chunks = [];
        window.__kitRaw = { chunks, mimeType: this.mimeType };
        this.addEventListener('dataavailable', e => { if (e.data?.size) chunks.push(e.data); });
      }
    }
    start(...a) { window.__kitRecStarts++; return super.start(...a); }
  }
  KitRecorder.isTypeSupported = t => realSupported(mp4(t));
  window.MediaRecorder = KitRecorder;
  window.__kitSaveRaw = name => {
    const r = window.__kitRaw;
    if (!r?.chunks.length) return false;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(r.chunks, { type: r.mimeType }));
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    return true;
  };

  const md = navigator.mediaDevices;
  const realGum = md.getUserMedia.bind(md);
  window.__kitMicTracks = [];
  md.getUserMedia = async c => {
    if (selfTest && c?.audio && !c.video) {
      // Room noise plus a click at every flash of the pattern (whole multiples of periodMs of the clock).
      const ctx = new AudioContext();
      await ctx.resume().catch(() => {});
      const dest = ctx.createMediaStreamDestination();
      const noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      noise.getChannelData(0).forEach((_, i, d) => { d[i] = (Math.random() * 2 - 1) * 0.002; });
      const bed = new AudioBufferSourceNode(ctx, { buffer: noise, loop: true });
      bed.connect(dest);
      bed.start();
      const n = Math.round(ctx.sampleRate * 0.06);
      const click = ctx.createBuffer(1, n, ctx.sampleRate);
      click.getChannelData(0).forEach((_, i, d) => { d[i] = (Math.random() * 2 - 1) * 0.5 * Math.exp(-i / (ctx.sampleRate * 0.015)); });
      const now = () => performance.timeOrigin + performance.now();
      let next = Math.ceil((now() + 300) / periodMs) * periodMs;
      const schedule = () => {
        for (; next < now() + 3000; next += periodMs) {
          const at = ctx.currentTime + (next - now()) / 1000;
          if (at > ctx.currentTime + 0.02) { const s = new AudioBufferSourceNode(ctx, { buffer: click }); s.connect(dest); s.start(at); }
        }
      };
      schedule();
      setInterval(schedule, 500);
      window.__kitMicTracks.push(...dest.stream.getAudioTracks());
      return dest.stream;
    }
    const s = await realGum(c);
    window.__kitMicTracks.push(...s.getAudioTracks());
    return s;
  };

  if (location.search.includes('kit-low-disk')) {
    const est = navigator.storage.estimate.bind(navigator.storage);
    navigator.storage.estimate = async () => { const e = await est(); return { ...e, quota: (e.usage || 0) + 1.2e9 }; };
  }

  const wl = navigator.wakeLock;
  window.__kitWake = [];
  if (wl?.request) {
    const req = wl.request.bind(wl);
    wl.request = async type => {
      const e = { type, at: performance.now(), ok: false, released: null, error: null };
      window.__kitWake.push(e);
      try { const s = await req(type); e.ok = true; s.addEventListener('release', () => { e.released = performance.now(); }); return s; } catch (err) { e.error = err.name; throw err; }
    };
  }

  window.__kitToasts = [];
  document.addEventListener('DOMContentLoaded', () => {
    const toasts = document.getElementById('toasts');
    if (toasts) new MutationObserver(list => {
      for (const m of list) for (const n of m.addedNodes) if (n.classList?.contains('toast')) window.__kitToasts.push(n.querySelector('[data-field="title"]')?.textContent || n.textContent);
    }).observe(toasts, { childList: true });
  });
}

// ------------------------------------------------------------------ the browser

/** Launch the installed browser with real devices: no fake camera, microphone, screen or permission UI. */
async function launch(S, source) {
  S.source = source;          // null: the person picks in the sharing window (--guided)
  S.args = [...(source ? [`--auto-select-desktop-capture-source=${source}`] : []), '--window-position=20,20', '--window-size=900,700'];
  S.context = await chromium.launchPersistentContext(S.profile, {
    ...(S.channel ? { channel: S.channel } : {}),
    headless: false, viewport: null, acceptDownloads: true,
    // The permission prompts for the microphone and camera are answered "Allow" by the kit.
    permissions: ['microphone', 'camera'],
    // Playwright stops Chrome from slowing down background windows; a teacher's browser does slow them.
    ignoreDefaultArgs: ['--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
    args: S.args,
  });
  await S.context.addInitScript(instrument, { settingsKey: SETTINGS_KEY, lesson: LESSON, selfTest: OPT.selfTest, periodMs: 2000 });
  S.context.on('page', p => watch(S, p));
  S.app = S.context.pages()[0] || await S.context.newPage();
  watch(S, S.app);
  S.pattern = null;
  await openApp(S, S.app);
  // Full Capture's window stays in the top left, clear of the right fifth of the screen where the
  // pattern's flashes are measured (at any display scaling).
  const cdp = await S.context.newCDPSession(S.app);
  try {
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    const [aw, ah] = await S.app.evaluate(() => [screen.availWidth, screen.availHeight]);
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: 20, top: 20, width: Math.min(900, Math.floor(aw * 0.7)), height: Math.min(700, ah - 40) } });
  } catch (e) { log(`Full Capture's window couldn't be sized: ${e.message}`); }
  await cdp.detach().catch(() => {});
  if (!S.version) {
    // "Google Chrome 141.0.7390.66" or "Microsoft Edge 141.0.3537.71" (Playwright's own Chromium: "Chromium …").
    S.version = await S.app.evaluate(async () => {
      const { fullVersionList = [] } = await navigator.userAgentData?.getHighEntropyValues(['fullVersionList']) ?? {};
      const b = fullVersionList.find(x => /Chrome|Edge/.test(x.brand)) || fullVersionList.find(x => /Chromium/.test(x.brand));
      return b ? `${b.brand} ${b.version}` : navigator.userAgent;
    });
  }
}

function watch(S, page) {
  if (page.__kitWatched) return;
  page.__kitWatched = true;
  page.on('pageerror', e => S.errors.push(`pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) S.errors.push(`console: ${m.text()}`); });
}

async function openApp(S, page) {
  await page.goto(APP_URL);
  // Polled on a timer: a page hidden behind another window gets no animation frames on Windows.
  await page.waitForFunction(() => document.documentElement.dataset.ready === 'true', null, { timeout: 30_000, polling: 250 });
}

const phase = S => S.app.evaluate(() => document.documentElement.dataset.phase);
const state = (S, fn, arg) => S.app.evaluate(fn, arg);
const pipOpen = S => S.app.evaluate(() => !!window.documentPictureInPicture?.window);
/** The floating controls' own page: the one holding the token the app page puts on its open window. */
async function pipPage(S) {
  const token = await S.app.evaluate(() => {
    const w = window.documentPictureInPicture?.window;
    if (!w) return null;
    w.__kitToken ||= Math.random().toString(36).slice(2);
    return w.__kitToken;
  });
  if (!token) return null;
  for (const p of S.context.pages()) {
    if (p === S.app || p === S.pattern || p.isClosed()) continue;
    if (await p.evaluate(t => window.__kitToken === t, token).catch(() => false)) return p;
  }
  return null;
}
/** Seconds since the take began, by the kit's clock (the app's own figure is refreshed by timers, slowly while it is hidden). */
const sinceStart = start => (Date.now() - start.startedAt) / 1000;
async function toApp(S) { await S.app.bringToFront(); await sleep(300); }
async function toPattern(S) { if (await patternAlive(S)) await S.pattern.bringToFront(); }
const patternAlive = async S => !!S.pattern && !S.pattern.isClosed() && !!(await S.pattern.evaluate(() => 1).catch(() => null));
async function waitPhase(S, p, ms = 20_000) { return until(async () => (await phase(S)) === p, ms, 100); }

/** The test pattern in its own window over the whole screen, clicking with every flash. */
async function openPattern(S) {
  const url = `${pathToFileURL(path.join(ROOT, 'test/windows/stimulus.html')).href}?sound=${OPT.sound && !OPT.selfTest ? 1 : 0}`;
  const opened = S.context.waitForEvent('page');
  await S.app.evaluate(u => { window.open(u, '_blank', `noopener,popup,left=0,top=0,width=${screen.width},height=${screen.height}`); }, url);
  S.pattern = await opened;
  await S.pattern.waitForLoadState();
  // Over the whole screen (the browser doesn't always honour a new window's size and place).
  const cdp = await S.context.newCDPSession(S.pattern);
  try {
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    const [width, height] = await S.pattern.evaluate(() => [screen.width, screen.height]);
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }).catch(() => {});
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: 0, top: 0, width, height } });
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'fullscreen' } });
  } catch (e) { log(`The pattern's window couldn't be made full screen: ${e.message}`); }
  await cdp.detach().catch(() => {});
  await sleep(800);
  await S.pattern.click('#start');
  await until(() => S.pattern.evaluate(() => document.body.classList.contains('running')));
  await sleep(500);
  const info = await S.pattern.evaluate(() => ({
    sound: window.pattern.sound, outputLatency: window.pattern.outputLatency, baseLatency: window.pattern.baseLatency,
    covers: Math.round(100 * Math.min(1, (innerWidth * innerHeight) / (screen.width * screen.height))),
  }));
  S.patternInfo = info;
  return info;
}

/** The first click on the page (it starts the sound), then the microphone. */
async function micOn(S) {
  await toApp(S);
  await S.app.mouse.click(5, 5);
  return until(async () => { const m = await state(S, () => window.fullCapture.state.mic); return m.status === 'live' || m.status === 'error' || m.status === 'blocked' ? m : null; }, 20_000);
}

async function chooseScreen(S) {
  await toApp(S);
  await sleep(SETTLE);
  await S.app.click('#btnChooseScreen');
  // Without a source to pick by itself (two screens, --guided), the person picks the screen the pattern is on.
  let ok = S.source && await until(() => state(S, () => !!window.fullCapture.state.screen), 20_000);
  if (!ok && OPT.guided.length) {
    action(S.source ? `In the browser's sharing window, choose "${S.source}" and press Share (the kit waits 3 minutes).`
      : 'In the browser\'s sharing window, choose the screen showing the test pattern (Entire screen tab) and press Share. The kit waits 3 minutes.', S);
    ok = await until(() => state(S, () => !!window.fullCapture.state.screen), 180_000, 500);
    await done(S);
  }
  if (!ok) throw new Error(`The sharing window didn't choose "${S.source}" by itself. With two screens pass --source "Screen 1"; in a browser that isn't in English, pass the name it shows; or run with --guided and choose it yourself.`);
  return state(S, () => { const s = window.fullCapture.state.screen; return { surface: s.surface, label: s.label, width: s.width, height: s.height, nativeWidth: s.nativeWidth, nativeHeight: s.nativeHeight, hasAudio: s.hasAudio }; });
}

/** Back to "ready" from wherever the last step left the app. */
async function ready(S) {
  await toApp(S);
  let p = await phase(S);
  if (p === 'recording' || p === 'paused') { await stopAndSave(S, 'cleanup').catch(() => {}); p = await phase(S); }
  if (p === 'review') { await sleep(SETTLE); await S.app.click('#btnNewTake'); await waitPhase(S, 'ready', 10_000); }
  if (!(await state(S, () => !!window.fullCapture.state.screen))) await chooseScreen(S);
}

/** Start a take from Set up; returns what the floating controls did on the way. */
async function startTake(S) {
  await ready(S);
  await sleep(SETTLE);
  const starts = await S.app.evaluate(() => window.__kitRecStarts);
  await S.app.click('#btnStart');
  let countdown = false, pipInCountdown = false;
  const ok = await until(async () => {
    const p = await phase(S);
    if (p === 'countdown') { countdown = true; pipInCountdown ||= await pipOpen(S); }
    return p === 'recording';
  }, 25_000, 100);
  if (!ok) throw new Error(`Recording didn't start: the page says "${await phase(S)}" (${JSON.stringify(await state(S, () => window.fullCapture.state.startBlocker))})`);
  return { countdown, pipInCountdown, pipAtRecording: await pipOpen(S), recordersStarted: (await S.app.evaluate(() => window.__kitRecStarts)) - starts, startedAt: Date.now() };
}

/** Save a download into the evidence folder under its own name, never over another file. */
async function keep(S, download, sub = 'downloads') {
  const name = download.suggestedFilename();
  const dir = path.join(S.dir, sub);
  fs.mkdirSync(dir, { recursive: true });
  let target = path.join(dir, name);
  for (let i = 2; fs.existsSync(target); i++) target = path.join(dir, name.replace(/(\.\w+)?$/, ` (kit ${i})$1`));
  await download.saveAs(target);
  return { file: target, name };
}

async function stopAndSave(S) {
  await toApp(S);
  await sleep(SETTLE);
  const dl = S.app.waitForEvent('download', { timeout: 60_000 });
  const stoppedAt = Date.now();
  await S.app.click('#btnStop');
  const saved = await keep(S, await dl);
  await waitPhase(S, 'review', 30_000);
  const review = await state(S, () => { const r = window.fullCapture.state.review; return r && { filename: r.filename, durationMs: r.durationMs, savedTo: r.savedTo, size: r.size, endedBy: r.endedBy, justSaved: r.justSaved, mimeType: r.mimeType }; });
  return { ...saved, review, stoppedAt };
}

async function screenshot(S, name) {
  const file = path.join(S.dir, 'screenshots', `${name}.png`);
  try { await toApp(S); await S.app.screenshot({ path: file, timeout: 10_000 }); return file; } catch { return null; }
}

async function meter(S, ms) {
  const xs = await S.app.evaluate(ms => new Promise(res => {
    const out = [];
    const off = window.fullCapture.on('meter', m => out.push([m.raw.rmsDb, m.raw.peakDb, m.raw.clips || 0, m.digitalSilence ? 1 : 0, m.speech ? 1 : 0]));
    setTimeout(() => { off(); res(out); }, ms);
  }), ms);
  const sorted = xs.map(x => x[0]).sort((a, b) => a - b);
  return {
    samples: xs.length, rmsMedianDb: sorted.length ? Math.round(sorted[Math.floor(sorted.length / 2)]) : null,
    peakMaxDb: xs.length ? Math.round(Math.max(...xs.map(x => x[1]))) : null, clips: xs.reduce((n, x) => n + x[2], 0),
    digitalSilence: xs.some(x => x[3]), speech: xs.filter(x => x[4]).length,
  };
}

/** End the test browser like Task Manager's "End task": only processes started with this run's own profile. */
function killBrowser(profile) {
  let pids = [];
  if (WIN) {
    const ps = "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:FC_PROFILE) } | ForEach-Object { $_.ProcessId }";
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { env: { ...process.env, FC_PROFILE: profile }, encoding: 'utf8', timeout: 60_000 });
    pids = String(r.stdout || '').split(/\s+/).filter(Boolean).map(Number);
  } else {
    pids = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' }).split('\n')
      .filter(l => l.includes(profile) && !l.includes('run.mjs')).map(l => Number(l.trim().split(/\s+/)[0]));
  }
  pids = pids.filter(p => p && p !== process.pid);
  for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
  return pids.length;
}

// ------------------------------------------------------------------ checks of a saved take

/** Turn one take's analysis into results. */
function judgeTake(S, sec, label, a, review, expect) {
  const b = S.name;
  const ev = [a.file];
  const p = a.probe;
  const h264 = p.video?.codec === 'h264';
  const lengthS = a.layout?.headerS ?? p.durationS;
  const appS = review ? review.durationMs / 1000 : null;
  const finalised = a.layout && a.layout.moov && a.layout.moovAtEnd && !a.layout.fragmented;
  const lenOk = appS == null || Math.abs(lengthS - appS) < 0.5;
  record(b, 5, `mp4.format.${label}`, `${label}: MP4 with H.264, finalised, length right`,
    /mp4/.test(p.container) && finalised && lenOk && (h264 || OPT.selfTest) ? 'pass' : 'fail',
    `${p.video?.codec}/${p.audio?.codec ?? 'no sound'} ${p.video?.width}×${p.video?.height} ${p.video?.avgFps} fps; layout ${a.layout ? a.layout.order.join(' ') : p.container}; ` +
    `length: app ${appS ?? '?'} s, header ${a.layout?.headerS ?? '–'} s, ffprobe ${p.durationS} s; ${(p.bytes / 1e6).toFixed(1)} MB`, { evidence: ev });
  record(b, 5, `mp4.decode.${label}`, `${label}: ffmpeg decodes every frame without errors`, a.decodeErrors ? 'fail' : 'pass', a.decodeErrors ? a.decodeErrors.slice(0, 300) : `${a.frames.count} frames, ${a.frames.first}–${a.frames.last} s`);
  const seekProblems = a.seeks.filter(s => s.firstVideo == null || s.firstVideo < s.target - 0.001 || s.firstVideo > s.target + 0.5 ||
    (p.audio && (s.firstAudio == null || s.firstAudio < s.target - 0.05 || s.firstAudio > s.target + 0.3)) || s.decodeErrors || s.syncKept === false);
  record(b, 5, `mp4.seek.${label}`, `${label}: seeks at 25/50/75 %: a frame there, clean decoding, sync kept`, seekProblems.length ? 'fail' : 'pass',
    a.seeks.map(s => `${s.target} s → picture ${s.firstVideo}, sound ${s.firstAudio}${s.syncKept == null ? '' : s.syncKept ? ', sync kept' : ', SYNC CHANGED'}${s.decodeErrors ? ', ERRORS' : ''}`).join('; '),
    { evidence: a.seeks.map(s => s.png) });
  if (a.windows) {
    const w = a.windows;
    record(b, 5, `mp4.windows.${label}`, `${label}: Windows reads its length (Explorer → Properties → Details)`,
      w.error ? 'warn' : Math.abs(w.durationS - lengthS) < 0.6 ? 'pass' : 'fail', w.error ? `couldn't ask Windows: ${w.error}` : `${w.durationS} s, ${w.width}×${w.height}`);
  }
  if (a.packets) {
    record(b, 5, `mp4.packets.${label}`, `${label}: the saved file holds exactly the recorder's packets (original kept beside it)`, a.packets.identical ? 'pass' : 'fail',
      `${a.packets.rawPackets} packets from the recorder, ${a.packets.savedPackets} in the saved file${a.packets.identical ? '' : `; only in the original: ${a.packets.onlyRaw.join(' | ')}; only saved: ${a.packets.onlySaved.join(' | ')}`}`, { evidence: [a.raw] });
  }
  if (p.audio) {
    const g = a.gaps;
    const clipped = a.loudness.samplesAtFullScale > 10;
    record(b, 4, `au.recorded.${label}`, `${label}: recorded sound: level, clipping, dropouts`,
      g.soundGaps.length ? 'fail' : clipped || a.digitalSilence.length || g.pictureGaps.length ? 'warn' : 'pass',
      `mean ${a.loudness.meanDb} dB, peak ${a.loudness.maxDb} dB, ${a.loudness.samplesAtFullScale} samples at full scale; gaps in the sound: ${g.soundGaps.length ? JSON.stringify(g.soundGaps.slice(0, 5)) : 'none'}; ` +
      `digital silence: ${a.digitalSilence.length ? JSON.stringify(a.digitalSilence.slice(0, 5)) : 'none'}; longest gap between frames ${g.maxFrameGapS} s`);
  } else {
    record(b, 4, `au.recorded.${label}`, `${label}: recorded sound`, 'fail', 'the file has no sound track');
  }
  const sy = a.sync;
  if (!sy.measured) {
    record(b, 4, `au.sync.${label}`, `${label}: sound and picture in sync (start, after pause, end)`, 'not run',
      `not measurable: ${sy.flashes} flashes and ${sy.clicks} clicks found${sy.clicks < 3 ? ' (the microphone didn’t hear the pattern’s clicks: a headset? Use the clap test in docs/ACCEPTANCE.md)' : ''}`);
  } else {
    // The offset itself includes the speakers' and display's delays, so only a large one is worth a look.
    // A change of it during the take (by the end, or after the pause) is the app's: more than 60 ms fails.
    const drift = Math.abs((sy.end?.medianMs ?? sy.medianMs) - (sy.start?.medianMs ?? sy.medianMs));
    const afterPause = sy.afterPause ? Math.abs(sy.afterPause.medianMs - (sy.start?.medianMs ?? sy.medianMs)) : 0;
    const status = drift > 60 || afterPause > 60 ? 'fail' : Math.abs(sy.medianMs) > 120 || drift > 45 || afterPause > 45 ? 'warn' : 'pass';
    record(b, 4, `au.sync.${label}`, `${label}: sound and picture in sync (start, after pause, end)`, status,
      `sound ${sy.medianMs > 0 ? 'late' : 'early'} by ${Math.abs(sy.medianMs)} ms (median of ${sy.pairs.length}; range ${sy.minMs}…${sy.maxMs}); start ${sy.start?.medianMs} ms, after pause ${sy.afterPause?.medianMs ?? '–'} ms, end ${sy.end?.medianMs} ms; ` +
      `first pairs ${sy.pairs.slice(0, 3).map(x => `${x.at}s:${x.ms}`).join(' ')}. Includes the speakers' and display's own delay${S.patternInfo?.outputLatency != null ? ` (the browser reports ${Math.round(S.patternInfo.outputLatency * 1000)} ms output latency, allowed for)` : ''}` +
      `${S.screenInfo?.hasAudio ? '. The computer’s sound is recorded too, so the clicks may have come through it rather than the microphone' : ''}.`);
  }
  for (const c of a.controls) {
    record(b, 3, `fc.frames.${label}.${c.name}`, `${label}: ${c.title}`, c.wrong ? 'fail' : c.frames ? 'pass' : 'warn',
      `${c.frames} frames from ${c.from.toFixed(1)} to ${c.to.toFixed(1)} s; magenta share max ${c.maxMagenta}, min ${c.minMagenta}${c.wrong ? `; ${c.wrong} wrong frames, e.g. at ${c.examples.join(', ')} s` : ''}`);
  }
  if (expect.wallS != null) {
    const diff = Math.abs(lengthS - expect.wallS);
    record(b, 2, `cap.length.${label}`, `${label}: the file is as long as the time recorded, without the pause`, diff <= 1.5 ? 'pass' : 'fail',
      `${lengthS} s in the file; ${expect.wallS.toFixed(1)} s recorded by the clock (pause of ${expect.pausedS?.toFixed(1) ?? 0} s left out)`);
  }
}

/** Stop this browser's run if the recording doesn't show the test pattern: something else on screen is being recorded. */
function patternRecorded(S, a, label) {
  if (a.sync.flashes >= 3) return;
  record(S.name, 2, `cap.subject.${label}`, `${label}: the recording shows the test pattern`, 'fail',
    `only ${a.sync.flashes} of its flashes are in the video, so another screen or window was recorded; the run stops here so nothing else on your screens is recorded`);
  throw new StopRun('the recording doesn’t show the test pattern');
}

/** Ends this browser's run, not just the step it happens in. */
class StopRun extends Error {}

async function analyse(S, saved, name, expect = {}, raw = null) {
  log(`Analysing ${show(saved.file)} …`);
  const a = await A.analyseTake(saved.file, { outDir: path.join(S.dir, 'frames'), name: `${S.name}-${name}`, expect, raw });
  a.raw = raw;
  fs.writeFileSync(path.join(S.dir, 'analysis', `${name}.json`), JSON.stringify(a, null, 1));
  return a;
}

/** The saved file opened in a new tab of this browser: its length, three seeks, and playback. */
async function playInBrowser(S, file, lengthS) {
  const page = await S.context.newPage();
  try {
    await page.bringToFront();
    await page.goto(pathToFileURL(file).href);
    return await page.evaluate(async targets => {
      const v = document.querySelector('video');
      if (!v) return { error: 'the browser showed no player' };
      v.muted = true;
      if (v.readyState < 1) await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error(`media error ${v.error?.code}`)); setTimeout(() => rej(new Error('no metadata after 10 s')), 10_000); });
      const seeks = [];
      for (const t of targets) {
        v.currentTime = t;
        await new Promise(res => { v.addEventListener('seeked', res, { once: true }); setTimeout(res, 5000); });
        const frame = await new Promise(res => { if (!v.requestVideoFrameCallback) return res(null); v.requestVideoFrameCallback((_, m) => res(m.mediaTime)); setTimeout(() => res(null), 3000); });
        seeks.push({ target: t, at: Math.round(v.currentTime * 1000) / 1000, frame: frame == null ? null : Math.round(frame * 1000) / 1000 });
      }
      v.currentTime = targets[1];
      await new Promise(res => { v.addEventListener('seeked', res, { once: true }); setTimeout(res, 5000); });
      await v.play().catch(() => {});
      const t0 = v.currentTime;
      await new Promise(r => setTimeout(r, 1500));
      const played = Math.round((v.currentTime - t0) * 1000) / 1000;
      v.pause();
      return { duration: v.duration, width: v.videoWidth, height: v.videoHeight, seeks, played, error: v.error?.code ?? null };
    }, [0.25, 0.5, 0.75].map(f => Math.round(f * lengthS * 100) / 100));
  } catch (e) {
    return { error: e.message };
  } finally {
    await page.close().catch(() => {});
  }
}

// ------------------------------------------------------------------ scenarios

async function setUp(S) {
  const b = S.name;
  const m = await micOn(S);
  const mic = await state(S, () => { const s = window.fullCapture.state; return { status: s.mic.status, label: s.mic.label, error: s.micError, devices: (s.mic.devices || []).map(d => d.label) }; });
  S.devices = { mic: mic.label, mics: mic.devices };
  if (m?.status !== 'live') {
    record(b, 4, 'au.mic', 'The microphone opens', 'fail', `${mic.status}: ${mic.error || 'no message'}. If Windows blocks it: Settings → Privacy & security → Microphone → let desktop apps use it.`);
    throw new Error('No microphone, so nothing can be recorded');
  }
  record(b, 4, 'au.mic', 'The microphone opens', 'pass', `“${mic.label}” (${mic.devices.length} microphones listed)`, { devices: OPT.selfTest ? 'self-test' : 'real' });
  const quiet = await meter(S, 3000);
  S.displays = await state(S, () => ({ isExtended: screen.isExtended, width: screen.width, height: screen.height, dpr: devicePixelRatio, availHeight: screen.availHeight }));
  S.storage = await S.app.evaluate(async () => { const e = await navigator.storage.estimate(); return { freeGB: Math.round((e.quota - e.usage) / 1e8) / 10 }; });
  const info = await openPattern(S);
  await sleep(1000);
  const clicks = await meter(S, 6000);
  S.audible = clicks.peakMaxDb != null && quiet.rmsMedianDb != null && clicks.peakMaxDb - quiet.rmsMedianDb > 15;
  record(b, 4, 'au.level', 'Levels: quiet room, then the pattern’s clicks', quiet.clips + clicks.clips > 0 || quiet.digitalSilence ? 'warn' : 'pass',
    `quiet: ${quiet.rmsMedianDb} dB (peak ${quiet.peakMaxDb}); with clicks: peak ${clicks.peakMaxDb} dB → ${S.audible ? 'the microphone hears the speakers' : 'not heard (headset?): sync can’t be measured automatically'}; clipped samples ${quiet.clips + clicks.clips}${quiet.digitalSilence ? '; DIGITAL SILENCE (muted?)' : ''}; pattern sound ${info.sound ? 'on' : 'off'}, covering ${info.covers} % of the screen`);
  if (OPT.camera) {
    await toApp(S);
    await S.app.check('#cameraToggle');
    const cam = await until(async () => { const c = await state(S, () => window.fullCapture.state.camera); return c.status === 'live' || c.error ? c : null; }, 20_000);
    S.devices.camera = cam?.label;
    record(b, 4, 'au.camera', 'Camera bubble on (real webcam)', cam?.status === 'live' ? 'pass' : 'fail', cam?.status === 'live' ? `“${cam.label}”` : `${cam?.status}: ${cam?.error}`);
  } else {
    record(b, 4, 'au.camera', 'Camera bubble', 'not run', 'run with --camera to include the webcam (it records you)', { devices: 'n/a' });
  }
  const sc = await chooseScreen(S);
  S.screenInfo = sc;
  record(b, 2, 'cap.screen', 'Whole screen chosen in the sharing window', sc.surface === 'monitor' ? 'pass' : 'fail',
    `${sc.surface} “${sc.label}”, ${sc.nativeWidth}×${sc.nativeHeight} (recorded at ${sc.width}×${sc.height}), ${sc.hasAudio ? 'with' : 'without'} the computer’s sound; display ${S.displays.width}×${S.displays.height} at ${S.displays.dpr}× scaling, ${S.displays.isExtended ? 'more than one screen' : 'one screen'}; picked by “${S.source}”`);
  S.shots.push(await screenshot(S, 'setup-ready'));
}

async function mainTake(S) {
  const b = S.name;
  const start = await startTake(S);
  await toPattern(S);
  const half = OPT.seconds / 2;
  await sleep(2000);
  const background = await state(S, () => ({ visibility: document.visibilityState, wake: window.__kitWake.map(w => ({ ok: w.ok, released: w.released != null, error: w.error })) }));
  await sleep((half - 2) * 1000);
  await toApp(S);
  await sleep(SETTLE);
  await S.app.click('#btnMarker');
  await sleep(400);
  const pauseAt = sinceStart(start);
  const pausedWall = Date.now();
  await S.app.click('#btnPause');
  const paused = await waitPhase(S, 'paused', 5000);
  S.shots.push(await screenshot(S, 'main-paused'));
  await sleep(4000);
  await S.app.click('#btnResumeBig');
  const resumed = await waitPhase(S, 'recording', 5000);
  const pausedS = (Date.now() - pausedWall) / 1000;
  await toPattern(S);
  await sleep(half * 1000);
  const saved = await stopAndSave(S);
  const wallS = (saved.stoppedAt - start.startedAt) / 1000 - pausedS;
  const chapters = await state(S, () => window.fullCapture.state.review?.markers?.length ?? 0);
  const toasts = await S.app.evaluate(() => window.__kitToasts);
  S.shots.push(await screenshot(S, 'main-review'));
  const rawDl = S.app.waitForEvent('download', { timeout: 30_000 });
  const raw = await S.app.evaluate(() => window.__kitSaveRaw('take-1-as-recorded.fragmented.mp4')) ? (await keep(S, await rawDl, 'original')).file : null;

  record(b, 2, 'cap.countdown', 'Start: the 3-2-1 countdown, then Recording', start.countdown && start.recordersStarted === 1 ? 'pass' : 'fail',
    `countdown ${start.countdown ? 'shown' : 'NOT SHOWN'}; recorders started: ${start.recordersStarted}`);
  record(b, 2, 'cap.pause', 'Pause and Resume during a take', paused && resumed ? 'pass' : 'fail', `paused at ${pauseAt.toFixed(1)} s for ${pausedS.toFixed(1)} s; chapters added: ${chapters}`);
  record(b, 2, 'cap.save', 'Stop & save gives “Lesson (date time).mp4” in Downloads', /\.mp4$/.test(saved.name) && saved.name.startsWith(LESSON) && saved.review?.justSaved ? 'pass' : 'fail',
    `“${saved.name}”, ${(fs.statSync(saved.file).size / 1e6).toFixed(1)} MB; the app says ${saved.review?.durationMs} ms, saved to ${saved.review?.savedTo}`, { evidence: [saved.file] });
  const wake = background.wake;
  record(b, 2, 'cap.background', 'Full Capture in the background while it records', 'info',
    `the page was ${background.visibility} behind the lesson window; screen wake lock: ${wake.length ? wake.map(w => (w.ok ? (w.released ? 'taken, then released' : 'held') : `refused (${w.error})`)).join(', ') : 'never asked for'}` +
    `${background.visibility === 'hidden' && !wake.some(w => w.ok && !w.released) ? '. A hidden page holds no wake lock of its own; Chrome keeps the display awake during a whole-screen capture, which the 20-minute line of docs/ACCEPTANCE.md confirms' : ''}`);
  const single = !S.displays.isExtended;
  record(b, 3, 'fc.autohide', single ? 'One screen: the controls open for the countdown and close before recording' : 'Two screens: what the controls did at Start',
    !single ? 'info' : start.pipInCountdown && !start.pipAtRecording && toasts.filter(t => t === 'Floating controls hidden').length === 1 ? 'pass' : 'fail',
    `open during the countdown: ${start.pipInCountdown}; open when recording began: ${start.pipAtRecording}; “Floating controls hidden” toasts: ${toasts.filter(t => t === 'Floating controls hidden').length}`);

  const a = await analyse(S, saved, 'take-1', { pauseAt, controls: [{ name: 'hidden', title: 'no recorded frame shows the floating controls', from: -1, to: 1e9, shown: false }] }, raw);
  patternRecorded(S, a, 'Take 1');
  judgeTake(S, 'main', 'Take 1', a, saved.review, { wallS, pausedS });
  const play = await playInBrowser(S, saved.file, a.layout?.headerS ?? a.probe.durationS);
  const playOk = !play.error && Math.abs(play.duration - (a.layout?.headerS ?? a.probe.durationS)) < 0.2 && play.seeks.every(s => Math.abs(s.at - s.target) < 0.1) && play.played > 0.5;
  record(b, 5, 'mp4.browser', `Take 1 plays and seeks in ${S.version.replace(/ [\d.]+$/, '')} (the file opened in a tab)`, playOk ? 'pass' : 'fail',
    play.error ? play.error : `length ${play.duration?.toFixed(2)} s, ${play.width}×${play.height}; seeks ${play.seeks.map(s => `${s.target}→${s.at}${s.frame != null ? ` (frame ${s.frame})` : ''}`).join(', ')}; played ${play.played} s in 1.5 s`);
  S.takes.push(saved);
}

/** Take 2: the controls brought back mid-take (so they're in the video) and hidden again. */
async function controlsTake(S) {
  const b = S.name;
  const start = await startTake(S);
  await toPattern(S);
  await sleep(3000);
  const shownAt = sinceStart(start);
  await S.app.keyboard.press('Alt+h');
  const shown = await until(() => pipOpen(S), 5000);
  await sleep(4000);
  const pip = await until(() => pipPage(S), 5000);
  if (!pip) throw new Error('the floating controls window isn’t reachable');
  const hiddenAt = sinceStart(start);
  // The window can close under the click before Playwright hears back from it: that is the button working.
  await pip.click('[data-action="hide"]', { timeout: 5000 }).catch(e => { if (!/closed/i.test(e.message)) throw e; });
  const hidden = await until(async () => !(await pipOpen(S)), 5000);
  await sleep(3000);
  const saved = await stopAndSave(S);
  record(b, 3, 'fc.restore', 'Alt+H brings the controls back mid-take; Hide controls closes them again', shown && hidden ? 'pass' : 'fail', `shown at ${shownAt.toFixed(1)} s (${shown ? 'opened' : 'DID NOT OPEN'}), hidden at ${hiddenAt.toFixed(1)} s (${hidden ? 'closed' : 'STAYED OPEN'})`);
  const a = await analyse(S, saved, 'take-2', { controls: [
    // Margins for the window opening and closing (and its animation).
    { name: 'before', title: 'controls hidden: in no frame', from: -1, to: shownAt - 0.3, shown: false },
    { name: 'shown', title: 'controls shown: in the frames (proves the check sees them)', from: shownAt + 1.5, to: hiddenAt - 0.5, shown: true },
    { name: 'after', title: 'hidden again: in no frame', from: hiddenAt + 1.5, to: 1e9, shown: false },
  ] });
  patternRecorded(S, a, 'Take 2');
  judgeTake(S, 'takes', 'Take 2', a, saved.review, {});
  S.takes.push(saved);
}

/** Take 3: paused in the floating controls, Resume double-clicked, Stop & save there. */
async function pausedControlsTake(S) {
  const b = S.name;
  await startTake(S);
  await sleep(2000);          // Alt+H within 1.5 s of the controls hiding themselves is taken as a late press and ignored
  await S.app.keyboard.press('Alt+h');
  if (!(await until(() => pipOpen(S), 5000))) throw new Error('Alt+H didn’t bring the floating controls back');
  const pip = await until(() => pipPage(S), 5000);
  if (!pip) throw new Error('the floating controls window isn’t reachable');
  await sleep(SETTLE);
  await pip.click('[data-action="pause"]');
  const paused = await waitPhase(S, 'paused', 5000);
  await sleep(700);
  const sizes = await pip.evaluate(() => {
    const box = s => { const e = document.querySelector(s); if (!e || e.hidden || !e.offsetParent) return null; const r = e.getBoundingClientRect(); return { h: Math.round(r.height), bottom: Math.round(r.bottom) }; };
    return { resume: box('[data-action="resume"]'), stop: box('[data-action="stop"]'), height: innerHeight };
  });
  await pip.dblclick('[data-action="resume"]');
  await sleep(1500);
  const afterDbl = await phase(S);
  await sleep(SETTLE);
  const dl = S.app.waitForEvent('download', { timeout: 60_000 });
  await pip.click('[data-action="stop"]');
  const saved = await keep(S, await dl);
  await waitPhase(S, 'review', 30_000);
  const line = await until(() => pip.evaluate(() => { const e = document.querySelector('[data-field="saved"]'); return e && !e.hidden ? e.textContent : null; }), 5000);
  const big = sizes.resume && sizes.stop && sizes.resume.h > sizes.stop.h && sizes.resume.bottom <= sizes.height && sizes.stop.bottom <= sizes.height;
  record(b, 3, 'fc.paused', 'In the floating controls: Resume is the big button when paused; a double-click on it resumes once; ✓ Saved after Stop & save',
    paused && big && afterDbl === 'recording' && /Saved · .+ · in /.test(line || '') ? 'pass' : 'fail',
    `paused: ${!!paused}; Resume ${sizes.resume?.h}px tall, Stop & save ${sizes.stop?.h}px (window ${sizes.height}px); after double-click: ${afterDbl}; saved line: “${line || 'none'}”`);
  S.takes.push(saved);
}

async function takeNames(S) {
  const names = S.takes.map(t => t.name);
  const distinct = new Set(names).size === names.length;
  const numbered = names.slice(1).every((n, i) => n.includes(`take ${i + 2}`));
  record(S.name, 2, 'cap.takes', 'Several takes in one visit: numbered, none overwritten', distinct && numbered ? 'pass' : 'fail', names.map(n => `“${n}”`).join(', '));
}

async function reliability(S) {
  const b = S.name;
  // Esc in the countdown.
  await step(S, 6, 'rel.cancel', 'Esc during the countdown: no recording, no file', async () => {
    await ready(S);
    await sleep(SETTLE);
    const before = await S.app.evaluate(() => window.__kitRecStarts);
    let downloads = 0;
    const count = () => downloads++;
    S.app.on('download', count);
    await S.app.click('#btnStart');
    const counted = await waitPhase(S, 'countdown', 5000);
    await S.app.keyboard.press('Escape');
    const back = await until(async () => ['ready', 'setup'].includes(await phase(S)), 5000, 100);
    await sleep(3000);
    S.app.off('download', count);
    const started = (await S.app.evaluate(() => window.__kitRecStarts)) - before;
    const pip = await pipOpen(S);
    // The floating controls may stay open: their idle view offers Start recording again.
    record(b, 6, 'rel.cancel', 'Esc during the countdown: no recording, no file', counted && back && !started && !downloads ? 'pass' : 'fail',
      `countdown ${counted ? 'shown' : 'NOT SEEN'}; back to ${await phase(S)}; recorders started ${started}; files ${downloads}; floating controls ${pip ? 'still open (their Start recording view)' : 'closed'}`);
  });
  // Stop & save pressed twice.
  await step(S, 6, 'rel.doublestop', 'Stop & save double-clicked: one file, no new take', async () => {
    await startTake(S);
    await sleep(3000);
    await toApp(S);
    await sleep(SETTLE);
    let downloads = 0;
    const files = [];
    const count = d => { downloads++; files.push(keep(S, d)); };
    S.app.on('download', count);
    const before = await S.app.evaluate(() => window.__kitRecStarts);
    await S.app.dblclick('#btnStop');
    await sleep(200);
    await S.app.click('#btnStop', { timeout: 2000 }).catch(() => {});
    await waitPhase(S, 'review', 30_000);
    await sleep(4000);
    S.app.off('download', count);
    const started = (await S.app.evaluate(() => window.__kitRecStarts)) - before;
    const saved = await Promise.all(files);
    record(b, 6, 'rel.doublestop', 'Stop & save double-clicked: one file, no new take', downloads === 1 && !started && (await phase(S)) === 'review' ? 'pass' : 'fail',
      `files ${downloads} (${saved.map(s => `“${s.name}”`).join(', ')}); recorders started afterwards ${started}; page ${await phase(S)}`, { evidence: saved.map(s => s.file) });
  });
  // Sharing ended (simulated: what the browser's Stop sharing button does to the track).
  await step(S, 6, 'rel.share', 'Screen sharing ends mid-take: saved up to then, Review says why', async () => {
    await startTake(S);
    await toPattern(S);
    await sleep(4000);
    const dl = S.app.waitForEvent('download', { timeout: 60_000 });
    await S.app.evaluate(() => { const t = window.fullCapture.state.screen.stream.getVideoTracks()[0]; t.stop(); t.dispatchEvent(new Event('ended')); });
    const saved = await keep(S, await dl);
    await waitPhase(S, 'review', 30_000);
    const note = await S.app.locator('#reviewNotice').textContent().catch(() => '');
    const p = A.probe(saved.file);
    record(b, 6, 'rel.share', 'Screen sharing ends mid-take: saved up to then, Review says why', /screen sharing ended/i.test(note) && p.durationS > 3 ? 'pass' : 'fail',
      `“${saved.name}”, ${p.durationS} s; Review: “${(note || '').trim().slice(0, 140)}”`, { devices: 'simulated', evidence: [saved.file] });
  });
  // Microphone lost (simulated: the track ends as if unplugged; the device itself is still there).
  await step(S, 6, 'rel.mic', 'Microphone lost mid-take: a warning, the take goes on, the microphone comes back', async () => {
    await startTake(S);
    await toPattern(S);
    await sleep(3000);
    await S.app.evaluate(() => { const t = window.__kitMicTracks.filter(x => x.readyState === 'live').at(-1); t.stop(); t.dispatchEvent(new Event('ended')); });
    const lost = await until(() => state(S, () => window.fullCapture.state.alerts.find(a => a.id === 'mic-lost')?.title), 8000);
    const still = await phase(S);
    const back = await until(async () => !(await state(S, () => window.fullCapture.state.alerts.some(a => a.id === 'mic-lost'))) && (await state(S, () => window.fullCapture.state.mic.status)) === 'live', 20_000, 500);
    await sleep(2000);
    const saved = await stopAndSave(S);
    const p = A.probe(saved.file);
    record(b, 6, 'rel.mic', 'Microphone lost mid-take: a warning, the take goes on, the microphone comes back', lost && still === 'recording' && back && p.audio ? 'pass' : 'fail',
      `warning: “${lost || 'none'}”; take ${still}; microphone ${back ? 'back' : 'NOT BACK'}; “${saved.name}” ${p.durationS} s with ${p.audio ? 'sound' : 'NO SOUND'}`, { devices: 'simulated', evidence: [saved.file] });
  });
  // Low disk space (simulated: the browser reports 1.2 GB free).
  await step(S, 6, 'rel.disk', 'Low disk space: a warning before a long lesson', async () => {
    const page = await S.context.newPage();
    try {
      await page.bringToFront();
      await page.goto(`${APP_URL}?kit-low-disk`);
      await page.waitForFunction(() => document.documentElement.dataset.ready === 'true', null, { timeout: 30_000, polling: 250 });
      const alert = await until(() => page.evaluate(() => window.fullCapture.state.alerts.find(a => a.id === 'storage-low')), 15_000);
      const banner = await page.locator('#banners').textContent().catch(() => '');
      const file = path.join(S.dir, 'screenshots', 'low-disk.png');
      await page.screenshot({ path: file, timeout: 10_000 }).catch(() => {});
      record(b, 6, 'rel.disk', 'Low disk space: a warning before a long lesson', alert && /nearly full/i.test(banner) ? 'pass' : 'fail',
        alert ? `“${alert.title}: ${alert.text}”` : 'no warning', { devices: 'simulated', evidence: [file] });
    } finally { await page.close(); }
  });
}

/** The tab crashes mid-take; the next visit offers the recording. */
async function tabCrash(S) {
  const start = await startTake(S);
  await toPattern(S);
  await sleep(RECOVERY_S * 1000);
  const recordedS = sinceStart(start);
  const crashed = new Promise(r => S.app.once('crash', r));
  const cdp = await S.context.newCDPSession(S.app);
  cdp.send('Page.crash').catch(() => {});
  await Promise.race([crashed, sleep(10_000)]);
  S.app = await S.context.newPage();
  await S.app.bringToFront();
  await openApp(S, S.app);
  if (!(await patternAlive(S))) await openPattern(S);
  await recover(S, 'rel.tabcrash', 'The tab crashes mid-take: the next visit recovers a playable file', recordedS);
}

/** The browser is ended mid-take (its processes killed); the next start offers the recording. */
async function browserKill(S, nextSource) {
  const b = S.name;
  await micOn(S);
  const start = await startTake(S);
  await toPattern(S);
  await sleep(RECOVERY_S * 1000);
  const recordedS = sinceStart(start);
  const killed = killBrowser(S.profile);
  await Promise.race([S.context.close().catch(() => {}), sleep(10_000)]);
  await sleep(2000);
  await launch(S, nextSource);
  if (!killed) { record(b, 6, 'rel.kill', 'The browser is ended mid-take: the next start recovers it', 'fail', 'no browser process found to end'); return; }
  await recover(S, 'rel.kill', `The browser is ended mid-take (${killed} processes killed, like Task Manager’s End task): the next start recovers a playable file`, recordedS);
}

async function recover(S, id, title, recordedS) {
  const banner = S.app.locator('#banners .banner', { hasText: 'didn’t finish' });
  const seen = await banner.first().waitFor({ timeout: 20_000 }).then(() => true, () => false);
  const shot = await screenshot(S, `${id}-banner`);
  if (!seen) { record(S.name, 6, id, title, 'fail', 'no “We found a recording that didn’t finish” banner', { evidence: [shot] }); return; }
  const dl = S.app.waitForEvent('download', { timeout: 60_000 });
  await banner.first().getByRole('button', { name: 'Save it' }).click();
  const saved = await keep(S, await dl);
  const p = A.probe(saved.file);
  const errors = (await import('../tools/media.mjs')).decodeErrors(saved.file);
  const layout = /mp4/.test(p.container) ? A.mp4Layout(saved.file) : null;
  // The safety copy is written every second, and the browser's MP4 writer holds back about a second more,
  // so the last seconds before a crash can be missing (2–3.5 s in the kit's own runs). Up to LOST_OK_S
  // passes, up to LOST_MAX_S is worth a look, and more is lost footage: a failure.
  const lost = recordedS - p.durationS;
  const playable = saved.name.startsWith('RECOVERED_') && !errors && p.audio && (!layout || (layout.moovAtEnd && !layout.fragmented));
  record(S.name, 6, id, title, !playable || lost > LOST_MAX_S ? 'fail' : lost > LOST_OK_S ? 'warn' : 'pass',
    `“${saved.name}”: ${p.durationS} s of the ${recordedS.toFixed(1)} s recorded (the last ${Math.max(0, lost).toFixed(1)} s missing), ${p.video?.codec}/${p.audio?.codec ?? 'NO SOUND'}${layout ? `, ${layout.order.join(' ')}` : ''}${errors ? `; decode errors: ${errors.slice(0, 200)}` : ', decodes cleanly'}`,
    { evidence: [saved.file, shot] });
  await toApp(S);
  await micOn(S);
}

/** A window captured instead of the screen: the floating controls stay open and aren't in the video. */
async function windowCapture(S) {
  const b = S.name;
  if (!(await patternAlive(S))) await openPattern(S);
  await micOn(S);
  const sc = await chooseScreen(S);
  if (sc.surface !== 'window') { record(b, 2, 'cap.window', 'A window chosen in the sharing window', 'fail', `got ${sc.surface} “${sc.label}”`); return; }
  const start = await startTake(S);
  await toPattern(S);
  await sleep(8000);
  const openWhileRecording = await pipOpen(S);
  const saved = await stopAndSave(S);
  const a = await analyse(S, saved, 'window', { controls: [{ name: 'window', title: 'window capture: the open controls are in no frame', from: -1, to: 1e9, shown: false }] });
  record(b, 2, 'cap.window', 'Window capture records that window', a.sync.flashes >= 2 ? 'pass' : 'fail', `“${sc.label}”, ${sc.width}×${sc.height}; ${a.sync.flashes} flashes of the pattern in ${a.probe.durationS} s`, { evidence: [saved.file] });
  record(b, 3, 'fc.window', 'Window capture: the controls stay open while recording', start.pipAtRecording && openWhileRecording ? 'pass' : 'fail', `open at start ${start.pipAtRecording}, 8 s in ${openWhileRecording}`);
  judgeTake(S, 'window', 'Window take', a, saved.review, {});
}

// ------------------------------------------------------------------ guided steps (the person at the computer acts)

async function guided(S) {
  const b = S.name;
  if (OPT.guided.includes('speak')) await step(S, 4, 'au.speech', 'Speech: heard at a good level, not clipped', async () => {
    action('Say “This is a Full Capture microphone test, one, two, three” at your normal teaching volume. The kit waits up to 2 minutes for you to start.', S);
    // Wait for speech to start (relaying the request takes a while), then listen for 8 s.
    const heard = await until(async () => (await meter(S, 1000)).speech > 3, 120_000, 0);
    const m = heard ? await meter(S, 8000) : { speech: 0, peakMaxDb: null, clips: 0 };
    await done(S);
    record(b, 4, 'au.speech', 'Speech: heard at a good level, not clipped', m.speech > 10 && m.peakMaxDb > -30 && !m.clips ? 'pass' : 'warn',
      heard ? `peak ${m.peakMaxDb} dB, ${m.speech} meter readings with speech, ${m.clips} clipped samples` : 'no speech heard in 2 minutes');
  });
  if (OPT.guided.includes('unplug')) await step(S, 6, 'rel.unplug', 'Microphone unplugged mid-take, then plugged back in', async () => {
    await startTake(S);
    await toPattern(S);
    action('Unplug your microphone or headset now (the kit waits 2 minutes).', S);
    const lost = await until(() => state(S, () => window.fullCapture.state.alerts.find(a => a.id === 'mic-lost')?.title), 120_000, 500);
    const still = await phase(S);
    action('Plug it back in now (the kit waits 2 minutes).', S);
    const back = await until(async () => (await state(S, () => window.fullCapture.state.mic.status)) === 'live' && !(await state(S, () => window.fullCapture.state.alerts.some(a => a.id === 'mic-lost'))), 120_000, 500);
    await done(S);
    const saved = await stopAndSave(S);
    record(b, 6, 'rel.unplug', 'Microphone unplugged mid-take, then plugged back in', lost && still === 'recording' && back ? 'pass' : 'fail',
      `warning “${lost || 'none'}”; take ${still}; microphone ${back ? 'back' : 'NOT BACK'}; saved “${saved.name}”`, { evidence: [saved.file] });
  });
  if (OPT.guided.includes('stop-sharing')) await step(S, 6, 'rel.stopshare', 'Stop sharing pressed in the browser’s bar: the take is saved and Review says why', async () => {
    await startTake(S);
    await toPattern(S);
    const dl = S.app.waitForEvent('download', { timeout: 180_000 });
    action('Click “Stop sharing” in the browser’s sharing bar (bottom of the screen) now (the kit waits 3 minutes).', S);
    const saved = await keep(S, await dl);
    await done(S);
    await waitPhase(S, 'review', 30_000);
    const endedBy = await state(S, () => window.fullCapture.state.review?.endedBy);
    record(b, 6, 'rel.stopshare', 'Stop sharing pressed in the browser’s bar: the take is saved and Review says why', endedBy === 'share-ended' ? 'pass' : 'fail', `“${saved.name}”, ended by ${endedBy}`, { evidence: [saved.file] });
    await chooseScreen(S);
  });
  if (OPT.guided.includes('folder')) await step(S, 5, 'mp4.folder', 'Saving into a chosen folder', async () => {
    const dir = path.join(S.dir, 'lessons-folder');
    fs.mkdirSync(dir, { recursive: true });
    await ready(S);
    await sleep(SETTLE);
    await S.app.click('#btnChooseFolder');
    action(`In the folder window, open ${dir}, select it, then press Select Folder and Allow (“View files”/“Allow” on the browser's question). The kit waits 3 minutes.`, S);
    const okFolder = await until(() => state(S, () => window.fullCapture.state.folder.status === 'ready'), 180_000, 500);
    await done(S);
    if (!okFolder) { record(b, 5, 'mp4.folder', 'Saving into a chosen folder', 'not run', 'no folder was chosen'); return; }
    await startTake(S);
    await toPattern(S);
    await sleep(10_000);
    await toApp(S);
    await sleep(SETTLE);
    await S.app.click('#btnStop');
    await waitPhase(S, 'review', 30_000);
    const r = await state(S, () => window.fullCapture.state.review);
    const file = path.join(dir, r.filename);
    const there = fs.existsSync(file);
    const a = there ? await analyse(S, { file, name: r.filename }, 'folder-take') : null;
    record(b, 5, 'mp4.folder', 'Saving into a chosen folder: the file is there straight away and is a finished MP4', there && r.savedTo === 'folder' && a?.layout?.moovAtEnd && !a.decodeErrors ? 'pass' : 'fail',
      there ? `“${r.filename}”, ${a.probe.durationS} s, ${a.layout?.order.join(' ')}` : `not found in ${show(dir)}`, { evidence: [file] });
    await S.app.evaluate(() => window.fullCapture.forgetFolder());
  });
}

/** Run one scenario; a failure is recorded and the run goes on. */
async function step(S, section, id, title, fn) {
  try { await fn(); } catch (e) {
    if (e instanceof StopRun) throw e;
    record(S.name, section, id, title, 'fail', `the step stopped: ${e.message.split('\n')[0]}`);
    try { await ready(S); } catch { /* the next step will say */ }
  }
}

// ------------------------------------------------------------------ one browser

async function runBrowser(name) {
  const S = { name, channel: name === 'chromium' ? null : name, dir: path.join(OUT, name), errors: [], takes: [], shots: [] };
  for (const d of ['downloads', 'original', 'frames', 'screenshots', 'analysis']) fs.mkdirSync(path.join(S.dir, d), { recursive: true });
  S.profile = path.join(S.dir, 'profile');
  try {
    await launch(S, OPT.source || 'Entire screen');
  } catch (e) {
    record(name, 2, 'cap.launch', 'The installed browser starts', 'not run', `couldn't start ${name}: ${e.message.split('\n')[0]}`, { devices: 'n/a' });
    return S;
  }
  try {
    // Two screens: which one the sharing window calls "Screen 1" isn't known, and recording the wrong one
    // would record whatever else is on it. The person picks the screen with the pattern (--guided), or
    // names it (--source); otherwise this browser's run stops here.
    if (await state(S, () => screen.isExtended) && !OPT.source) {
      if (!OPT.guided.length) {
        record(name, 2, 'cap.launch', 'The installed browser starts with real devices', 'not run',
          'Two screens: run with --guided (you choose the screen showing the test pattern) or with --source naming it, e.g. --source "Screen 1"', { devices: 'n/a' });
        return S;
      }
      await S.context.close();
      await launch(S, null);
    }
    record(name, 2, 'cap.launch', 'The installed browser starts with real devices', 'pass',
      `${S.version}; no fake camera, microphone, screen or permission UI; switches: ${S.args.join(' ')}; permission prompts answered by the kit`, { devices: OPT.selfTest ? 'self-test' : 'real' });
    await setUp(S);
    if (want('main')) await step(S, 2, 'cap.main', 'Take 1: the main take', () => mainTake(S));
    if (want('takes')) {
      await step(S, 3, 'fc.restore', 'Alt+H brings the controls back mid-take; Hide controls closes them again', () => controlsTake(S));
      await step(S, 3, 'fc.paused', 'In the floating controls: Resume is the big button when paused; a double-click on it resumes once; ✓ Saved after Stop & save', () => pausedControlsTake(S));
      await takeNames(S);
    }
    if (want('reliability')) await reliability(S);
    if (OPT.guided.length) await guided(S);
    let windowSource = false;
    if (want('recovery')) {
      await step(S, 6, 'rel.tabcrash', 'The tab crashes mid-take: the next visit recovers a playable file', () => tabCrash(S));
      await step(S, 6, 'rel.kill', 'The browser is ended mid-take: the next start recovers a playable file', async () => { await browserKill(S, OPT.windowSource || WINDOW_SOURCE); windowSource = true; });
    }
    if (want('window')) {
      if (!windowSource) { await S.context.close().catch(() => {}); await launch(S, OPT.windowSource || WINDOW_SOURCE); }
      await step(S, 2, 'cap.window', 'Window capture records that window', () => windowCapture(S));
    }
  } catch (e) {
    record(name, 2, 'cap.run', 'The run', 'fail', `stopped early: ${e.message.split('\n')[0]}`);
  } finally {
    record(name, 6, 'rel.errors', 'No errors in the page’s console', S.errors.length ? 'warn' : 'pass', S.errors.length ? S.errors.slice(0, 8).join(' | ') : 'none');
    await S.context?.close().catch(() => {});
  }
  return S;
}

// ------------------------------------------------------------------ before the browsers

function preflight() {
  const git = (...a) => { try { return execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
  const head = git('rev-parse', 'HEAD');
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  const upstreamName = git('rev-parse', '--abbrev-ref', '@{u}');
  const upstream = git('rev-parse', '@{u}');
  const dirty = git('status', '--porcelain', '--untracked-files=no');
  const env = {
    commit: head, branch, upstream: upstreamName, upstreamCommit: upstream, os: `${os.type()} ${os.release()} (${os.version?.() || ''}) ${os.arch()}`,
    node: process.version, playwright: JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules/@playwright/test/package.json'), 'utf8')).version, ...A.toolVersions(),
    cpus: `${os.cpus().length} × ${os.cpus()[0]?.model}`, memoryGB: Math.round(os.totalmem() / 1e9),
  };
  record(null, 1, 'app.commit', 'The commit under test is the pull request’s latest', head && head === upstream && !dirty ? 'pass' : 'warn',
    `${branch} at ${head?.slice(0, 7)}; ${upstreamName ? `${upstreamName} is ${upstream?.slice(0, 7)} (as of the last git fetch)` : 'no upstream branch'}; ${dirty ? `uncommitted changes:\n${dirty}` : 'no uncommitted changes'}`, { devices: 'n/a' });
  const built = path.join(OUT, 'build', 'full-capture.html');
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts/build.mjs'), '--out', built], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    const mine = fs.readFileSync(APP_FILE, 'utf8'), fresh = fs.readFileSync(built, 'utf8');
    const same = mine.replace(/\r\n/g, '\n') === fresh.replace(/\r\n/g, '\n');
    record(null, 1, 'app.build', 'The committed full-capture.html is a fresh build of src/', same ? 'pass' : 'fail',
      `${same ? 'same' : 'DIFFERENT'} (sha256 ${sha256(mine).slice(0, 12)} committed, ${sha256(fresh).slice(0, 12)} built${mine.includes('\r\n') ? '; the checkout has Windows line endings, compared without them' : ''})`, { devices: 'n/a', evidence: [built] });
  } catch (e) {
    record(null, 1, 'app.build', 'The committed full-capture.html is a fresh build of src/', 'fail', `the build failed: ${String(e.stderr || e.message).slice(0, 300)}`, { devices: 'n/a' });
  }
  record(null, 1, 'app.file', 'The kit opens the repository’s own full-capture.html (not a downloaded copy)', 'pass', `${show(APP_FILE)}, ${(fs.statSync(APP_FILE).size / 1024).toFixed(0)} KB, modified ${fs.statSync(APP_FILE).mtime.toISOString()}`, { devices: 'n/a' });
  if (!env.ffmpeg || !env.ffprobe) throw new Error('ffmpeg and ffprobe are needed (Windows: winget install --id Gyan.FFmpeg -e, then open a new terminal), or pass --ffmpeg-dir');
  return env;
}

// ------------------------------------------------------------------ the report

const SECTIONS = { 1: 'Application under test', 2: 'Real screen capture', 3: 'Floating controls', 4: 'Audio and camera', 5: 'MP4 integrity', 6: 'Reliability and recovery' };

function report(env, sessions) {
  const browsers = sessions.map(s => s.name);
  const counts = results.reduce((m, r) => ((m[r.status] = (m[r.status] || 0) + 1), m), {});
  const failed = results.filter(r => r.status === 'fail');
  const verdict = OPT.selfTest ? 'Not an acceptance result (kit self-test with a synthetic microphone)'
    : failed.length ? 'Not ready to merge' : 'Ready with documented limitations';
  const cell = r => (r ? `${r.status === 'pass' ? '✅' : r.status === 'fail' ? '❌' : r.status === 'warn' ? '⚠️' : r.status === 'info' ? 'ℹ️' : '–'} ${r.status}` : '');
  const L = [];
  L.push('# Windows acceptance results', '');
  L.push(`Draft written by \`test/windows/run.mjs\` on ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC. The manual checks below still need a person, so complete this before it goes into \`docs/WINDOWS_ACCEPTANCE_RESULTS.md\`.`, '');
  L.push(`**Automated verdict:** ${verdict}. Results: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}.`, '');
  L.push('## Under test', '');
  L.push(`- Commit \`${env.commit}\` on \`${env.branch}\` (upstream \`${env.upstream || 'none'}\` at \`${env.upstreamCommit?.slice(0, 7) || '–'}\`)`);
  L.push(`- ${env.os}; ${env.cpus}; ${env.memoryGB} GB`);
  L.push(`- Node ${env.node}, Playwright ${env.playwright}; ${env.ffmpeg}`);
  for (const s of sessions) {
    L.push(`- **${s.name}**: ${s.version || 'did not start'}${s.devices ? `; microphone “${s.devices.mic}”${s.devices.camera ? `, camera “${s.devices.camera}”` : ''}` : ''}` +
      `${s.displays ? `; display ${s.displays.width}×${s.displays.height} at ${s.displays.dpr}×, ${s.displays.isExtended ? 'two or more screens' : 'one screen'}` : ''}${s.storage ? `; ${s.storage.freeGB} GB free for safety copies` : ''}`);
  }
  L.push(`- Devices: ${OPT.selfTest ? '**synthetic microphone (kit self-test)**' : 'real microphone' + (OPT.camera ? ' and webcam' : '') + ', real screen capture'}; checks marked *simulated* use a stand-in, said in each row.`);
  L.push(`- Evidence: \`${show(OUT)}\` (kept on this computer, not in the repository)`, '');
  for (const [n, title] of Object.entries(SECTIONS)) {
    const rows = results.filter(r => String(r.section) === n);
    if (!rows.length) continue;
    L.push(`## ${n}. ${title}`, '');
    const ids = [...new Set(rows.map(r => r.id))];
    const cols = n === '1' ? ['all'] : browsers;
    L.push(`| Check | ${cols.join(' | ')} | Devices | Details |`, `|---|${cols.map(() => '---').join('|')}|---|---|`);
    for (const id of ids) {
      const byBrowser = cols.map(c => rows.find(r => r.id === id && (r.browser || 'all') === c));
      const any = byBrowser.find(Boolean);
      const details = byBrowser.filter(Boolean).map((r, i) => (cols.length > 1 ? `**${r.browser}:** ` : '') + r.detail.replace(/\|/g, '\\|').replace(/\n/g, ' ')).join('<br>');
      L.push(`| ${any.title} | ${byBrowser.map(cell).join(' | ')} | ${any.devices} | ${details} |`);
    }
    L.push('');
  }
  L.push('## Sync findings', '');
  for (const r of results.filter(r => r.id.startsWith('au.sync'))) L.push(`- ${r.browser}, ${r.title.split(':')[0]}: ${r.detail}`);
  L.push('', 'The test pattern clicks through the speakers at each flash, so a measured offset includes the speakers’ and the display’s own delay; what matters most is that it stays the same at the start, after the pause, after seeking and at the end.', '');
  L.push('## Still to check by hand', '');
  L.push('From `docs/ACCEPTANCE.md`, on this computer:', '');
  for (const m of [
    'Windows Media Player / Films & TV: Take 1 opens, plays with sound, and scrubbing to a quarter, the middle and near the end jumps straight there (`start "" "<file>"` opens it).',
    'Clap test with your own microphone and camera (the first claps, with the camera bubble on).',
    'Sound check (Check my sound → Hear it back) and your voice in the saved take.',
    'Two monitors, if you have them: controls on the screen you don’t record.',
    'A 20-minute take with Full Capture in the background: the display doesn’t dim or sleep.',
    ...(['speak', 'stop-sharing', 'folder', 'unplug'].filter(g => !OPT.guided.includes(g)).length
      ? [`Guided steps not run (\`--guided\`): ${['speak', 'stop-sharing', 'folder', 'unplug'].filter(g => !OPT.guided.includes(g)).join(', ')}. Unplugging needs a microphone or headset that can be unplugged.`] : []),
  ]) L.push(`- [ ] ${m}`);
  L.push('', '## Evidence', '', `In \`${show(OUT)}\` on this computer (not in the repository):`, '');
  for (const r of results) for (const e of r.evidence) L.push(`- ${r.browser || 'all'} · ${r.title.split(':')[0]}: \`${e}\``);
  L.push('', '## Limitations of the automated run', '');
  L.push('- The browser’s microphone and camera prompts are answered by the kit, and the sharing window picks the screen by itself (`--auto-select-desktop-capture-source`); everything after that is the real device.');
  L.push('- The floating controls are painted magenta by the kit so every frame can be checked for them.');
  L.push('- Downloads are caught by the kit and copied into the evidence folder, so the browser’s own Downloads folder isn’t used; the file name is the one the browser would have used.');
  L.push('- “Simulated” rows end a track in the page (sharing, microphone) or report little free space; the guided steps do the real thing.');
  L.push('', '## Merge recommendation', '', `Automated: **${verdict}**. Final recommendation (Ready to merge / Ready with documented limitations / Not ready to merge) after the manual checks: _to be completed_.`);
  return L.join('\n') + '\n';
}

function writeResults(env, sessions) {
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ env, options: OPT, results, sessions: sessions.map(s => ({ name: s.name, version: s.version, devices: s.devices, displays: s.displays, screen: s.screenInfo, pattern: s.patternInfo, storage: s.storage, errors: s.errors.map(show) })) }, null, 1));
  fs.writeFileSync(path.join(OUT, 'WINDOWS_ACCEPTANCE_RESULTS.draft.md'), report(env, sessions));
}

// ------------------------------------------------------------------ main

log(`Full Capture acceptance kit. Evidence: ${show(OUT)}${OPT.selfTest ? ' (SELF-TEST: synthetic microphone, not an acceptance run)' : ''}`);
const env = preflight();
const sessions = [];
for (const b of OPT.browsers) {
  log(`=== ${b} ===`);
  const S = await runBrowser(b);
  sessions.push(S);
  if (!OPT.keepProfile && !results.some(r => r.browser === b && r.status === 'fail')) {
    try { fs.rmSync(S.profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch (e) { log(`The test profile ${show(S.profile)} couldn't be deleted yet (${e.code || e.message}); delete it later.`); }
  }
  writeResults(env, sessions);
}
const fails = results.filter(r => r.status === 'fail').length;
writeResults(env, sessions);
log(`Done: ${results.length} checks, ${fails} failed. Report: ${show(path.join(OUT, 'WINDOWS_ACCEPTANCE_RESULTS.draft.md'))}`);
process.exitCode = fails ? 1 : 0;
