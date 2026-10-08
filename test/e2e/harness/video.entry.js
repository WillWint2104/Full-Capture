// Browser harness for the video subsystem. Exposes the modules on window.video
// and test helpers on window.kit: synthetic camera/screen tracks painted on
// canvases, a tap that reads output frames, pixel sampling, recording to a
// playable file, and an audit of every VideoFrame's lifetime.
import * as sources from '../../../src/app/video/sources.js';
import * as compositor from '../../../src/app/video/compositor.js';
import { QUALITY_PRESETS } from '../../../src/app/media/formats.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Records every VideoFrame the page reads from a stream or constructs, and
 * every close() of an already-closed frame. A closed frame reports codedWidth 0.
 * Must be installed before the compositor creates frames.
 */
function installFrameAudit() {
  const NativeFrame = globalThis.VideoFrame;
  const seen = [];
  let doubleCloses = 0;
  const isClosed = f => f.codedWidth === 0;

  const read = ReadableStreamDefaultReader.prototype.read;
  ReadableStreamDefaultReader.prototype.read = function (...args) {
    return read.apply(this, args).then(result => {
      if (result.value instanceof NativeFrame) seen.push(result.value);
      return result;
    });
  };
  const close = NativeFrame.prototype.close;
  NativeFrame.prototype.close = function () {
    if (isClosed(this)) doubleCloses++;
    return close.call(this);
  };
  globalThis.VideoFrame = class AuditedVideoFrame extends NativeFrame {
    constructor(...args) {
      super(...args);
      seen.push(this);
    }
  };
  return {
    reset() { seen.length = 0; doubleCloses = 0; },
    report: () => ({ total: seen.length, open: seen.filter(f => !isClosed(f)).length, doubleCloses }),
  };
}

/**
 * A video track painted on a canvas. animate: repaint at `fps` (like a camera
 * or a changing screen). Otherwise the canvas only emits a frame when poke()
 * is called (like a static screen).
 */
function paintedTrack({ width, height, fps = 30, animate = true, paint }) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const track = canvas.captureStream(animate ? fps : 0).getVideoTracks()[0];
  const poke = () => {
    paint(ctx, width, height);
    if (!animate) track.requestFrame();
  };
  poke();
  if (animate) setInterval(poke, 1000 / fps);
  return { track, poke, repaint: fn => { paint = fn; poke(); } };
}

const solid = color => (ctx, w, h) => { ctx.fillStyle = color; ctx.fillRect(0, 0, w, h); };

/** One-pixel black and white columns, like fine text: any resampling turns them grey. */
const stripes = (ctx, w, h) => {
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#000';
  for (let x = 0; x < w; x += 2) ctx.fillRect(x, 0, 1, h);
};

/** A solid-colour track. */
function colorTrack(color, width = 1280, height = 720, opts = {}) {
  return paintedTrack({ width, height, ...opts, paint: solid(color) });
}

/**
 * A 640x360 "camera" whose centre square is red on the left and green on the
 * right, with yellow outside it, so crop and mirroring show in the output.
 */
function patternCamera(opts = {}) {
  return paintedTrack({
    width: 640, height: 360, ...opts,
    paint: (ctx) => {
      ctx.fillStyle = '#ff0'; ctx.fillRect(0, 0, 640, 360);
      ctx.fillStyle = '#f00'; ctx.fillRect(140, 0, 180, 360);
      ctx.fillStyle = '#0f0'; ctx.fillRect(320, 0, 180, 360);
    },
  });
}

/** Continuously reads a clone of `track`, counting frames; next() hands out the next fresh frame. */
class FrameTap {
  constructor(track) {
    this.track = track.clone();
    this.reader = new MediaStreamTrackProcessor({ track: this.track }).readable.getReader();
    this.count = 0;
    this.timestamps = [];
    this.waiters = [];
    this.ended = false;
    this.loop();
  }

  async loop() {
    for (;;) {
      let r;
      try { r = await this.reader.read(); } catch { break; }
      if (r.done) break;
      this.count++;
      this.timestamps.push(r.value.timestamp);
      const waiter = this.waiters.shift();
      if (waiter) waiter(r.value); else r.value.close();
    }
    this.ended = true;
    for (const w of this.waiters.splice(0)) w(null);
  }

  /** The next frame to arrive; the caller closes it. Resolves null if the track ends. */
  next() {
    return new Promise(resolve => this.waiters.push(resolve));
  }

  /** Frames counted over `ms`. */
  async rate(ms) {
    const start = this.count;
    await sleep(ms);
    return (this.count - start) * 1000 / ms;
  }

  stop() {
    this.reader.cancel().catch(() => {});
    this.track.stop();
  }
}

/** RGB of each [x, y] point of a frame. */
function readPixels(frame, points) {
  const canvas = new OffscreenCanvas(frame.displayWidth, frame.displayHeight);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(frame, 0, 0);
  return points.map(([x, y]) => Array.from(ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data.slice(0, 3)));
}

/** Mean difference between neighbouring pixels along a 40 px row at each point of a fresh frame (0..255). */
async function columnContrast(tap, points) {
  const frame = await tap.next();
  if (!frame) throw new Error('output ended');
  const canvas = new OffscreenCanvas(frame.displayWidth, frame.displayHeight);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(frame, 0, 0);
  frame.close();
  let sum = 0;
  let n = 0;
  for (const [x, y] of points) {
    const row = ctx.getImageData(x, y, 40, 1).data;
    for (let i = 4; i < row.length; i += 4) {
      sum += Math.abs(row[i] - row[i - 4]);
      n++;
    }
  }
  return Math.round(sum / n);
}

/** Let a change reach the output, then sample a fresh frame. */
async function sample(tap, points, settleMs = 200) {
  await sleep(settleMs);
  const frame = await tap.next();
  if (!frame) throw new Error('output ended');
  try {
    return { size: [frame.displayWidth, frame.displayHeight], pixels: readPixels(frame, points) };
  } finally {
    frame.close();
  }
}

/**
 * Record `track` for `ms` with MediaRecorder and check the file plays. VP8 is
 * the cheapest software encoder; this machine has no hardware one.
 */
async function recordPlayable(track, ms) {
  const mimeType = ['video/webm;codecs=vp8', 'video/webm'].find(m => MediaRecorder.isTypeSupported(m));
  const recorder = new MediaRecorder(new MediaStream([track]), { mimeType, videoBitsPerSecond: 2_500_000 });
  const chunks = [];
  recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  const stopped = new Promise(r => { recorder.onstop = r; });
  recorder.start(500);
  await sleep(ms);
  recorder.stop();
  await stopped;
  const blob = new Blob(chunks, { type: mimeType });
  const url = URL.createObjectURL(blob);
  const video = document.createElement('video');
  video.muted = true;
  video.src = url;
  try {
    await new Promise((resolve, reject) => {
      video.onloadeddata = resolve;
      video.onerror = () => reject(new Error('cannot play: ' + (video.error?.message || 'unknown')));
    });
    const info = { mimeType, size: blob.size, width: video.videoWidth, height: video.videoHeight };
    await video.play();
    await sleep(400);
    info.played = video.currentTime > 0;
    video.pause();
    return info;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Build screen + camera tracks, a started compositor and a tap on its output.
 * screen: { color, width, height, animate, pattern?: 'stripes' } ; camera: { color } | { pattern: true } | null
 */
const SCENE_BUBBLE = { shape: 'circle', size: 'l', x: 0.5, y: 0.5, mirror: false };

function scenario({ screen = {}, camera = { color: '#f00' }, output = {}, bubble = SCENE_BUBBLE } = {}) {
  const { color = '#00f', width = 1280, height = 720, animate = true, pattern } = screen;
  const scr = pattern === 'stripes'
    ? paintedTrack({ width, height, animate, paint: stripes })
    : colorTrack(color, width, height, { animate });
  const cam = !camera ? null : camera.pattern ? patternCamera() : colorTrack(camera.color, 640, 360);
  const size = { width: output.width ?? 1280, height: output.height ?? 720 };
  const comp = new compositor.Compositor({
    screenTrack: scr.track, cameraTrack: cam?.track ?? null, ...size, fps: output.fps ?? 30,
    bubble,
  });
  const warnings = [];
  comp.on('warning', w => warnings.push(w.message));
  const out = comp.start();
  const scene = { screen: scr, camera: cam, comp, out, size, warnings, ended: false, tap: new FrameTap(out) };
  out.addEventListener('ended', () => { scene.ended = true; });
  return scene;
}

/** Sample points for a bubble (fields not given are the scenario's): centre, ring, across the middle row, near the top edge. */
function bubblePoints(size, bubble) {
  const r = compositor.bubbleRect(size, { ...SCENE_BUBBLE, ...bubble });
  const cy = r.y + r.size / 2;
  return {
    rect: r,
    centre: [r.x + r.size / 2, cy],
    ring: [r.x + r.size / 2, r.y + 1],
    across: f => [r.x + f * r.size, cy],
    topEdge: f => [r.x + f * r.size, r.y + 6],
  };
}

const frameAudit = installFrameAudit();

window.video = { ...sources, ...compositor, QUALITY_PRESETS };
window.kit = {
  sleep, colorTrack, patternCamera, FrameTap, readPixels, sample, columnContrast, recordPlayable, frameAudit, scenario,
  bubblePoints,
};
