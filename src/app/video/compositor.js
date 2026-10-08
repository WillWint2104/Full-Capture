// Puts the camera bubble onto the screen recording, live, frame by frame.
//
// Clocking is the hard part. A screen-capture track only produces frames when
// the screen changes, and timers and requestAnimationFrame are throttled when
// the tab is hidden, so none of them can pace the output. The camera can: it
// delivers frames steadily whatever the page is doing. Each camera frame
// therefore produces an output frame (up to the requested frame rate), built
// from the latest screen frame plus the bubble. When no camera frame has
// arrived for a frame interval (camera off, frozen or unplugged), screen frames
// pace the output instead.
//
// Frames are read with MediaStreamTrackProcessor, drawn on an OffscreenCanvas
// and written to a MediaStreamTrackGenerator, all on the main thread (the
// processor and generator don't exist in workers).

import { Emitter } from '../lib/emitter.js';
import { DEFAULT_SETTINGS } from '../lib/settings.js';

/** Bubble diameter as a fraction of the output height. */
export const BUBBLE_SIZES = Object.freeze({ s: 0.2, m: 0.27, l: 0.35 });

const MARGIN = 0.02;                 // gap between bubble and frame edge, fraction of output height
const CORNER_RADIUS = 0.22;          // rounded-square corner, fraction of the bubble size
const RING_COLOR = 'rgba(255, 255, 255, 0.75)';
const EARLY = 0.2;                   // a frame may come this fraction of an interval early (delivery jitters)
const FPS_WINDOW_MS = 1000;
// A screen this close to the output size (odd-sized windows, sizes rounded to
// even numbers) is drawn 1:1 rather than scaled: resampling by a fraction of a
// percent turns every line of text soft, which matters far more than a 1-2 px
// border or crop.
const SNAP_PX = 4;

const MESSAGES = {
  unsupported: 'This browser can’t add the camera bubble to recordings. Update Chrome or Edge, or record without '
    + 'the camera.',
  cameraEnded: 'Your camera stopped, so it’s no longer in the recording. Check it’s plugged in, then switch the '
    + 'camera off and on again.',
  drawFailed: 'Part of the video couldn’t be drawn. The recording carries on; if it looks wrong when you play it '
    + 'back, record that part again.',
  bubbleFailed: 'Your camera’s picture couldn’t be added to the recording, so the bubble may be missing. Your '
    + 'screen and sound are still being recorded. If the bubble doesn’t come back, switch the camera off and on again.',
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const unit = (v, fallback) => (Number.isFinite(v) ? clamp(v, 0, 1) : fallback);

/** Fill in and sanitise a bubble description on top of `base`. */
function normalizeBubble(bubble, base = DEFAULT_SETTINGS.bubble) {
  const b = bubble || {};
  return {
    shape: b.shape === 'circle' || b.shape === 'rounded' ? b.shape : base.shape,
    size: Object.hasOwn(BUBBLE_SIZES, b.size) ? b.size : base.size,
    x: unit(b.x, base.x),
    y: unit(b.y, base.y),
    mirror: typeof b.mirror === 'boolean' ? b.mirror : base.mirror,
  };
}

/** Top-left of a `size` span centred on `centre` (0..1), kept `margin` away from both ends. */
function placeAlong(centre, length, size, margin) {
  const lo = margin;
  const hi = length - margin - size;
  // A frame too small for the margins: centre the (possibly empty) bubble.
  if (hi < lo) return Math.max(0, Math.floor((length - size) / 2));
  return clamp(Math.round(centre * length - size / 2), lo, hi);
}

/**
 * Pure. Where the bubble goes, in output pixels. The bubble is a square of
 * side `size` (diameter BUBBLE_SIZES[size] × height) centred on (x, y) as
 * fractions of the frame, then moved so it sits fully inside the frame with a
 * margin of 2% of the height. Missing or invalid fields use the default bubble.
 * @param {{width: number, height: number}} frame
 * @param {{shape?: 'circle'|'rounded', size?: 's'|'m'|'l', x?: number, y?: number, mirror?: boolean}} bubble
 * @returns {{x: number, y: number, size: number}}
 */
export function bubbleRect({ width, height }, bubble) {
  const w = Math.max(0, Math.floor(width) || 0);
  const h = Math.max(0, Math.floor(height) || 0);
  const b = normalizeBubble(bubble);
  const margin = Math.round(h * MARGIN);
  const size = Math.max(0, Math.min(Math.round(h * BUBBLE_SIZES[b.size]), w - 2 * margin, h - 2 * margin));
  return { x: placeAlong(b.x, w, size, margin), y: placeAlong(b.y, h, size, margin), size };
}

/** True when this browser can composite the camera into the recording. */
export function isCompositingSupported() {
  const g = globalThis;
  return typeof g.MediaStreamTrackProcessor === 'function'
    && typeof g.MediaStreamTrackGenerator === 'function'
    && typeof g.OffscreenCanvas === 'function'
    && typeof g.VideoFrame === 'function';
}

/**
 * Where the screen goes: 1:1 and centred when it is within SNAP_PX of the
 * output size, otherwise the largest rectangle with its aspect ratio that
 * fits, centred (letterboxed).
 */
function screenRect(srcW, srcH, w, h) {
  if (Math.abs(srcW - w) <= SNAP_PX && Math.abs(srcH - h) <= SNAP_PX) {
    return { x: Math.floor((w - srcW) / 2), y: Math.floor((h - srcH) / 2), w: srcW, h: srcH };
  }
  const scale = Math.min(w / srcW, h / srcH);
  const dw = Math.round(srcW * scale);
  const dh = Math.round(srcH * scale);
  return { x: Math.floor((w - dw) / 2), y: Math.floor((h - dh) / 2), w: dw, h: dh };
}

function traceShape(ctx, shape, x, y, size) {
  ctx.beginPath();
  if (shape === 'rounded') {
    const r = size * CORNER_RADIUS;
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + size, y, x + size, y + size, r);
    ctx.arcTo(x + size, y + size, x, y + size, r);
    ctx.arcTo(x, y + size, x, y, r);
    ctx.arcTo(x, y, x + size, y, r);
    ctx.closePath();
  } else {
    ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
  }
}

/** Centre square of the camera frame, clipped to the bubble shape, with a thin ring. */
function drawBubble(ctx, frame, { x, y, size }, { shape, mirror }, ring) {
  const fw = frame.displayWidth;
  const fh = frame.displayHeight;
  const side = Math.min(fw, fh);
  ctx.save();
  try {
    traceShape(ctx, shape, x, y, size);
    ctx.clip();
    if (mirror) {
      // Reflect about the bubble's vertical centre line, like a mirror.
      ctx.translate(2 * x + size, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(frame, (fw - side) / 2, (fh - side) / 2, side, side, x, y, size, size);
  } finally {
    // A clip left behind would crop every later frame to the bubble.
    ctx.restore();
  }
  // Inset by half the line width so the ring stays inside the clipped bubble.
  ctx.lineWidth = ring;
  ctx.strokeStyle = RING_COLOR;
  traceShape(ctx, shape, x + ring / 2, y + ring / 2, size - ring);
  ctx.stroke();
}

/**
 * Reads frames from one track and hands each to `onFrame`, which then owns
 * (and must close) it. Calls `onEnd` once if the track ends or errors, but not
 * after close(). Never stops the track: the caller owns it.
 */
class FrameFeed {
  #reader = null;
  #open = true;

  constructor(track, onFrame, onEnd) {
    try {
      this.#reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    } catch {
      // Not a live video track: treat it as one that has just ended.
      Promise.resolve().then(() => this.#finish(onEnd));
      return;
    }
    this.#pump(onFrame, onEnd);
  }

  async #pump(onFrame, onEnd) {
    for (;;) {
      let result;
      try {
        result = await this.#reader.read();
      } catch {
        break;                  // the stream errored, which means the track is gone: same as ended
      }
      if (result.done) break;
      if (!this.#open) {
        result.value.close();
        break;
      }
      try {
        onFrame(result.value);
      } catch (error) {
        // A fault handling one frame is not the track ending: treating it so
        // would end the take (screen) or drop a working camera.
        console.error('[compositor] frame handler failed', error);
      }
    }
    this.#finish(onEnd);
  }

  #finish(onEnd) {
    if (!this.#open) return;
    this.#open = false;
    onEnd();
  }

  close() {
    if (!this.#open) return;
    this.#open = false;
    // Resolves the pending read with done; frames still queued are released.
    this.#reader?.cancel().catch(() => {});
  }
}

/**
 * Composites the screen and a camera bubble into one video track to record.
 * The input tracks stay owned by the caller: the compositor reads them but
 * never stops them. To replace the screen, call setScreenTrack(new) before
 * stopping the old track; if the current screen track ends (the teacher
 * pressed "Stop sharing"), the compositor stops and its output track ends with
 * an 'ended' event, just as the screen track itself would.
 *
 * Events: 'warning' { message }
 */
export class Compositor extends Emitter {
  #width;
  #height;
  #interval;                      // ms between frames at the requested fps
  #bubble;
  #rect;
  #ring;
  #cameraVisible = true;
  #state = 'idle';                // 'idle' | 'running' | 'stopped'
  #canvas = null;
  #ctx = null;
  #output = null;
  #writer = null;
  #screen = { track: null, feed: null, frame: null };
  #camera = { track: null, feed: null, frame: null };
  #lastCameraAt = -Infinity;
  #nextDue = -Infinity;           // earliest time the next output frame is wanted
  #lastTimestamp = 0;
  #framesOut = 0;
  #recentDraws = [];
  #warned = new Set();            // warnings already given: each is said once ('bubble' again per camera)

  /**
   * @param {{screenTrack: MediaStreamTrack, cameraTrack?: MediaStreamTrack|null, width: number, height: number,
   *   fps?: number, bubble?: object}} options width/height are the output size in pixels
   */
  constructor({ screenTrack = null, cameraTrack = null, width, height, fps = 30, bubble } = {}) {
    super();
    if (!(width > 0 && height > 0)) throw new TypeError('Compositor needs a positive output width and height.');
    this.#width = Math.round(width);
    this.#height = Math.round(height);
    this.#interval = 1000 / clamp(Number(fps) || 30, 1, 120);
    // About 2 px at 1080p, scaled so the ring looks the same at every output size.
    this.#ring = Math.max(2, Math.round((this.#height / 1080) * 2));
    this.#screen.track = screenTrack;
    this.#camera.track = cameraTrack;
    this.#applyBubble(normalizeBubble(bubble));
  }

  /**
   * Begin compositing.
   * @returns {MediaStreamTrack} the video track to record
   * @throws {Error} when compositing isn't supported (check isCompositingSupported() first)
   */
  start() {
    if (this.#state === 'running') return this.#output;
    if (this.#state === 'stopped') throw new Error('This compositor was stopped. Create a new one.');
    if (!isCompositingSupported()) throw new Error(MESSAGES.unsupported);
    const canvas = new OffscreenCanvas(this.#width, this.#height);
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error(MESSAGES.unsupported);
    ctx.imageSmoothingQuality = 'high';
    this.#canvas = canvas;
    this.#ctx = ctx;
    this.#output = new MediaStreamTrackGenerator({ kind: 'video' });
    this.#writer = this.#output.writable.getWriter();
    // The writable errors when the output track is stopped by whoever records
    // it (track.stop() fires no event); then there is nothing left to feed.
    this.#writer.closed.catch(() => this.stop());
    const hint = this.#screen.track?.contentHint;
    if (hint && 'contentHint' in this.#output) this.#output.contentHint = hint;
    this.#state = 'running';
    this.#attach(this.#screen, this.#screen.track);
    this.#attach(this.#camera, this.#camera.track);
    return this.#output;
  }

  /** Change shape, size, position or mirroring; takes effect from the next frame. Accepts a partial bubble. */
  setBubble(bubble) {
    this.#applyBubble(normalizeBubble(bubble, this.#bubble));
  }

  /** Hide or show the bubble without touching the camera (it keeps pacing the output). */
  setCameraVisible(on) {
    this.#cameraVisible = Boolean(on);
  }

  /** Swap the camera mid-take, or pass null when it is switched off or lost. */
  setCameraTrack(track) {
    if (this.#camera.track !== (track || null)) this.#warned.delete('bubble');
    this.#replace(this.#camera, track || null);
  }

  /** Follow a new screen track (e.g. the teacher shared a different screen). */
  setScreenTrack(track) {
    this.#replace(this.#screen, track || null);
  }

  /** Stop compositing and release every frame and reader. The output track ends; input tracks are left alone. */
  stop() {
    if (this.#state === 'stopped') return;
    this.#state = 'stopped';
    for (const slot of [this.#screen, this.#camera]) {
      this.#detach(slot);
      slot.track = null;
    }
    if (this.#writer) {
      // Closing the writable ends the output track *with* an 'ended' event, so a
      // recorder watching it notices; track.stop() would end it silently.
      const output = this.#output;
      this.#writer.close().catch(() => output.stop());
      this.#writer = null;
    }
    if (this.#canvas) {
      this.#canvas.width = 0;      // frees the backing store now rather than at GC
      this.#canvas = null;
      this.#ctx = null;
    }
  }

  /** framesOut: total frames produced; fps: frames produced in the last second. */
  get stats() {
    const now = performance.now();
    return {
      framesOut: this.#framesOut,
      fps: this.#recentDraws.filter(t => now - t <= FPS_WINDOW_MS).length,
    };
  }

  #applyBubble(bubble) {
    this.#bubble = bubble;
    this.#rect = bubbleRect({ width: this.#width, height: this.#height }, bubble);
  }

  #replace(slot, track) {
    if (this.#state === 'stopped' || slot.track === track) return;
    if (this.#state === 'idle') {
      slot.track = track;
      return;
    }
    // The old screen picture stays until the new track's first frame, so a swap
    // never flashes black. A camera swap drops the old face at once.
    this.#detach(slot, { keepFrame: slot === this.#screen && track !== null });
    this.#attach(slot, track);
  }

  #attach(slot, track) {
    slot.track = track;
    if (!track) return;
    const feed = new FrameFeed(
      track,
      frame => this.#onFrame(slot, feed, frame),
      () => this.#onEnd(slot, feed),
    );
    slot.feed = feed;
  }

  #detach(slot, { keepFrame = false } = {}) {
    slot.feed?.close();
    slot.feed = null;
    if (!keepFrame) {
      slot.frame?.close();
      slot.frame = null;
    }
  }

  #onFrame(slot, feed, frame) {
    if (slot.feed !== feed || this.#state !== 'running') {
      frame.close();
      return;
    }
    slot.frame?.close();
    slot.frame = frame;
    const now = performance.now();
    if (slot === this.#camera) {
      this.#lastCameraAt = now;
      this.#compose(now);
    } else if (now - this.#lastCameraAt >= this.#interval) {
      this.#compose(now);
    }
  }

  #onEnd(slot, feed) {
    if (slot.feed !== feed) return;      // replaced or detached on purpose
    if (slot === this.#screen) {
      this.stop();
      return;
    }
    this.#detach(slot);
    slot.track = null;
    this.emit('warning', { message: MESSAGES.cameraEnded });
  }

  #compose(now) {
    // Never faster than the requested fps on average, e.g. with a 60 fps camera.
    if (now < this.#nextDue - this.#interval * EARLY) return;
    // The generator hasn't taken the previous frame yet: drop this one rather than queue.
    if (!(this.#writer?.desiredSize > 0)) return;
    let frame;
    try {
      this.#paint();
      frame = new VideoFrame(this.#canvas, { timestamp: this.#nextTimestamp(now), alpha: 'discard' });
    } catch (error) {
      this.#warnOnce('frame', MESSAGES.drawFailed, error);
      return;
    }
    // Due times advance one interval per frame, so jitter doesn't drift the
    // rate. The floor keeps a stalled input from earning a burst of catch-up
    // frames, yet lets the next on-time frame through after a late one.
    this.#nextDue = Math.max(this.#nextDue, now - this.#interval / 2) + this.#interval;
    this.#countFrame(now);
    // The generator closes every frame handed to it, even one whose write then
    // fails because the output track was stopped by its consumer. Only a write
    // to an already-failed stream leaves the frame open (closed frames report
    // codedWidth 0).
    this.#writer.write(frame).catch(() => {
      if (frame.codedWidth > 0) frame.close();
      this.stop();
    });
  }

  #paint() {
    const ctx = this.#ctx;
    const w = this.#width;
    const h = this.#height;
    const screen = this.#screen.frame;
    if (screen) {
      const r = screenRect(screen.displayWidth, screen.displayHeight, w, h);
      const covers = r.x <= 0 && r.y <= 0 && r.x + r.w >= w && r.y + r.h >= h;
      if (!covers) this.#fillBlack();
      ctx.drawImage(screen, r.x, r.y, r.w, r.h);
    } else {
      this.#fillBlack();
    }
    const camera = this.#camera.frame;
    if (camera && this.#cameraVisible && this.#rect.size > 0) {
      try {
        drawBubble(ctx, camera, this.#rect, this.#bubble, this.#ring);
      } catch (error) {
        // A camera frame that can't be drawn must not cost the screen picture:
        // this frame goes out without the bubble (drawBubble left no clip behind).
        this.#warnOnce('bubble', MESSAGES.bubbleFailed, error);
      }
    }
  }

  #fillBlack() {
    this.#ctx.fillStyle = '#000';
    this.#ctx.fillRect(0, 0, this.#width, this.#height);
  }

  /** Microseconds on the page clock, strictly increasing whichever input clocked the frame. */
  #nextTimestamp(now) {
    this.#lastTimestamp = Math.max(Math.round(now * 1000), this.#lastTimestamp + 1);
    return this.#lastTimestamp;
  }

  #countFrame(now) {
    this.#framesOut++;
    this.#recentDraws.push(now);
    while (now - this.#recentDraws[0] > FPS_WINDOW_MS) this.#recentDraws.shift();
  }

  /** Tell the teacher once per kind; log the cause once for diagnosis. */
  #warnOnce(kind, message, error) {
    if (this.#warned.has(kind)) return;
    this.#warned.add(kind);
    console.error(`[compositor] ${kind} draw failed`, error);
    this.emit('warning', { message });
  }
}
