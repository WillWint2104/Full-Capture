// The compositor in a real browser: frame rate, recording, pixels, live
// changes, clock fallbacks and cleanup. Synthetic camera/screen tracks are
// painted canvases (see harness/video.entry.js), so colours are known.
import { test, expect } from '@playwright/test';
import { openHarness, trackErrors } from './helpers.mjs';

const ENTRY = 'test/e2e/harness/video.entry.js';

const COLORS = {
  red: [255, 0, 0], green: [0, 255, 0], blue: [0, 0, 255], black: [0, 0, 0], magenta: [255, 0, 255],
};

/** Assert a sampled pixel is close to a named colour (video paths may shift values slightly). */
function expectColor(pixel, name, where) {
  const want = COLORS[name];
  const distance = Math.hypot(...pixel.map((v, i) => v - want[i]));
  expect(distance, `${where}: expected ${name}, got rgb(${pixel})`).toBeLessThan(90);
}

let errors;
test.beforeEach(async ({ page }) => {
  errors = trackErrors(page);
  await openHarness(page, ENTRY);
  expect(await page.evaluate(() => video.isCompositingSupported())).toBe(true);
});
test.afterEach(async ({ page }) => {
  await page.evaluate(() => window.scene?.comp.stop());
  expect(errors).toEqual([]);
});

test('output runs at the requested fps with rising timestamps and records a playable WebM of the output size', async ({ page }) => {
  const r = await page.evaluate(async () => {
    // Output smaller than the screen, so the size comes from the compositor, not the source.
    const scene = window.scene = kit.scenario({ output: { width: 960, height: 540, fps: 30 } });
    await kit.sleep(300);
    const [rate, recording] = await Promise.all([scene.tap.rate(2000), kit.recordPlayable(scene.out, 2000)]);
    const ts = scene.tap.timestamps;
    const rising = ts.every((t, i) => i === 0 || t > ts[i - 1]);
    const frame = await scene.tap.next();
    const size = [frame.displayWidth, frame.displayHeight];
    frame.close();
    return { rate, recording, rising, frames: ts.length, size, stats: scene.comp.stats, kind: scene.out.kind };
  });
  expect(r.kind).toBe('video');
  expect(r.rate).toBeGreaterThan(22);
  expect(r.rate).toBeLessThan(33);
  expect(r.rising).toBe(true);
  expect(r.size).toEqual([960, 540]);
  expect(r.stats.fps).toBeGreaterThan(20);
  expect(r.stats.fps).toBeLessThanOrEqual(33);
  expect(r.stats.framesOut).toBeGreaterThanOrEqual(r.frames - 2);
  expect(r.recording.size).toBeGreaterThan(1000);
  expect([r.recording.width, r.recording.height]).toEqual([960, 540]);
  expect(r.recording.played).toBe(true);
});

test('the fake camera and fake screen composite into a recording at the screen size', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const screen = await video.pickScreen({ preset: video.QUALITY_PRESETS.standard, systemAudio: false });
    const camera = await video.openCamera('', { fps: 30 });
    const comp = new video.Compositor({
      screenTrack: screen.videoTrack, cameraTrack: camera.getVideoTracks()[0],
      width: screen.width, height: screen.height, fps: 30, bubble: { size: 'm', x: 1, y: 1 },
    });
    window.scene = { comp };
    const out = comp.start();
    const tap = new kit.FrameTap(out);
    await kit.sleep(300);
    // Measured apart from recording: software encoding at 1080p competes with the fake devices for this CPU.
    const rate = await tap.rate(2000);
    const recording = await kit.recordPlayable(out, 2000);
    comp.stop();
    tap.stop();
    screen.stream.getTracks().forEach(t => t.stop());
    camera.getTracks().forEach(t => t.stop());
    return { rate, recording, width: screen.width, height: screen.height };
  });
  // The fake camera and screen both run at ~20 fps, which caps the output. The
  // bound leaves room for a busy machine; the canvas tests check the clock itself.
  expect(r.rate).toBeGreaterThan(12);
  expect(r.rate).toBeLessThan(33);
  expect([r.recording.width, r.recording.height]).toEqual([r.width, r.height]);
  expect(r.recording.played).toBe(true);
});

test('pixels: camera bubble over a letterboxed screen, cropped, mirrored, circle and rounded', async ({ page }) => {
  const r = await page.evaluate(async () => {
    // 4:3 blue screen in a 16:9 output: black bars left and right of x 160..1120.
    const scene = window.scene = kit.scenario({ screen: { width: 960, height: 720 }, camera: { pattern: true } });
    const out = {};
    const shot = async (bubble, extra = []) => {
      scene.comp.setBubble(bubble);
      const p = kit.bubblePoints(scene.size, { shape: 'circle', size: 'l', x: 0.5, y: 0.5, mirror: false, ...bubble });
      const points = [p.across(0.08), p.across(0.3), p.across(0.7), p.across(0.92), p.ring, p.topEdge(0.15), ...extra];
      const { pixels, size } = await kit.sample(scene.tap, points);
      const [edgeL, left, right, edgeR, ring, corner, ...rest] = pixels;
      return { edgeL, left, right, edgeR, ring, corner, rest, size };
    };
    out.plain = await shot({ shape: 'circle', mirror: false }, [[50, 360], [1230, 360], [640, 60]]);
    out.mirrored = await shot({ shape: 'circle', mirror: true });
    out.rounded = await shot({ shape: 'rounded', mirror: false });
    out.roundedMirrored = await shot({ shape: 'rounded', mirror: true });
    return out;
  });
  const { plain, mirrored, rounded, roundedMirrored } = r;
  expect(plain.size).toEqual([1280, 720]);
  // Screen: letterboxed on black.
  expectColor(plain.rest[0], 'black', 'left bar');
  expectColor(plain.rest[1], 'black', 'right bar');
  expectColor(plain.rest[2], 'blue', 'screen far from the bubble');
  // Camera: only the centre square is used (its yellow sides never show).
  expectColor(plain.edgeL, 'red', 'left edge of bubble');
  expectColor(plain.left, 'red', 'left of bubble');
  expectColor(plain.right, 'green', 'right of bubble');
  expectColor(plain.edgeR, 'green', 'right edge of bubble');
  expectColor(mirrored.edgeL, 'green', 'mirrored left edge');
  expectColor(mirrored.left, 'green', 'mirrored left');
  expectColor(mirrored.right, 'red', 'mirrored right');
  expectColor(mirrored.edgeR, 'red', 'mirrored right edge');
  expectColor(roundedMirrored.left, 'green', 'rounded mirrored left');
  expectColor(roundedMirrored.right, 'red', 'rounded mirrored right');
  // Shape: near the top-left corner of the square is outside a circle but inside a rounded square.
  expectColor(plain.corner, 'blue', 'circle corner');
  expectColor(rounded.corner, 'red', 'rounded corner');
  // A subtle light ring at the edge.
  for (const ring of [plain.ring, rounded.ring]) {
    expect(Math.min(...ring), `ring rgb(${ring})`).toBeGreaterThan(130);
  }
});

test('pixels: solid red camera on solid blue screen; hiding and moving the bubble live', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const scene = window.scene = kit.scenario({ camera: { color: '#f00' } });
    const centre = kit.bubblePoints(scene.size, { size: 'l', x: 0.5, y: 0.5 }).centre;
    const topLeft = kit.bubblePoints(scene.size, { size: 's', x: 0, y: 0 });
    const far = [1200, 80];
    const points = [centre, far, topLeft.centre, [topLeft.rect.x + topLeft.rect.size + 30, topLeft.rect.y + 30]];
    const shown = (await kit.sample(scene.tap, points)).pixels;
    scene.comp.setCameraVisible(false);
    const hidden = (await kit.sample(scene.tap, points)).pixels;
    scene.comp.setCameraVisible(true);
    scene.comp.setBubble({ size: 's', x: 0, y: 0 });
    const moved = (await kit.sample(scene.tap, points)).pixels;
    return { shown, hidden, moved, warnings: scene.warnings };
  });
  expectColor(r.shown[0], 'red', 'bubble centre');
  expectColor(r.shown[1], 'blue', 'far from the bubble');
  expectColor(r.hidden[0], 'blue', 'hidden bubble centre');
  expectColor(r.moved[0], 'blue', 'old place after moving');
  expectColor(r.moved[2], 'red', 'new place in the top-left corner');
  expectColor(r.moved[3], 'blue', 'just outside the small bubble');
  expect(r.warnings).toEqual([]);
});

test('a frame that cannot be made is skipped with one warning, and later frames are whole', async ({ page }) => {
  const r = await page.evaluate(async () => {
    // Make the next two output frames fail to be created from the canvas.
    const Frame = globalThis.VideoFrame;
    let failures = 2;
    globalThis.VideoFrame = class FlakyVideoFrame extends Frame {
      constructor(source, init) {
        if (failures > 0 && source instanceof OffscreenCanvas) {
          failures--;
          throw new DOMException('broken frame', 'InvalidStateError');
        }
        super(source, init);
      }
    };
    try {
      const scene = window.scene = kit.scenario();
      await kit.sleep(300);
      const failed = 2 - failures;
      scene.comp.setScreenTrack(kit.colorTrack('#f0f', 1280, 720).track);
      const { pixels } = await kit.sample(scene.tap, [[1200, 80], [80, 640], kit.bubblePoints(scene.size, {}).centre]);
      return { pixels, failed, warnings: scene.warnings, rate: await scene.tap.rate(1000) };
    } finally {
      globalThis.VideoFrame = Frame;
    }
  });
  expect(r.failed).toBe(2);
  expectColor(r.pixels[0], 'magenta', 'screen top right');
  expectColor(r.pixels[1], 'magenta', 'screen bottom left');
  expectColor(r.pixels[2], 'red', 'bubble');
  expect(r.rate).toBeGreaterThan(20);
  expect(r.warnings).toHaveLength(1);
  expect(r.warnings[0]).toMatch(/couldn’t be drawn/);
  expect(errors.filter(e => /draw failed/.test(e))).toHaveLength(1);
  errors.length = 0;
});

test('a camera frame that cannot be drawn costs only the bubble: the screen keeps recording', async ({ page }) => {
  const r = await page.evaluate(async () => {
    // Every camera draw throws (and leaves no clip behind), as a broken camera would, until `broken` is cleared.
    const proto = OffscreenCanvasRenderingContext2D.prototype;
    const drawImage = proto.drawImage;
    let broken = true;
    let failed = 0;
    proto.drawImage = function (image, ...rest) {
      if (broken && image.displayWidth === 640) {
        failed++;
        throw new DOMException('broken frame', 'InvalidStateError');
      }
      return drawImage.call(this, image, ...rest);
    };
    try {
      const scene = window.scene = kit.scenario();
      const points = [[1200, 80], kit.bubblePoints(scene.size, {}).centre];
      await kit.sleep(300);
      const rate = await scene.tap.rate(1000);
      const during = (await kit.sample(scene.tap, points, 0)).pixels;
      broken = false;
      const after = (await kit.sample(scene.tap, points)).pixels;
      return { rate, during, after, failed, warnings: scene.warnings, ended: scene.ended };
    } finally {
      proto.drawImage = drawImage;
    }
  });
  expect(r.failed).toBeGreaterThan(20);
  expect(r.rate).toBeGreaterThan(20);
  expectColor(r.during[0], 'blue', 'screen while the camera is broken');
  expectColor(r.during[1], 'blue', 'no bubble while the camera is broken');
  expectColor(r.after[1], 'red', 'the bubble returns with the camera');
  expect(r.ended).toBe(false);
  expect(r.warnings).toHaveLength(1);
  expect(r.warnings[0]).toMatch(/camera/i);
  expect(r.warnings[0]).toMatch(/screen and sound are still being recorded/);
  expect(errors.filter(e => /bubble draw failed/.test(e))).toHaveLength(1);
  errors.length = 0;
});

test('an unexpected error while handling one frame neither ends the take nor drops the camera', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const scene = window.scene = kit.scenario();
    const centre = kit.bubblePoints(scene.size, {}).centre;
    await kit.sleep(300);
    // One write to the output throws outright: a stand-in for any bug in the frame handler.
    const proto = WritableStreamDefaultWriter.prototype;
    const write = proto.write;
    let thrown = 0;
    proto.write = function (chunk) {
      if (thrown === 0 && chunk instanceof VideoFrame) {
        thrown++;
        chunk.close();
        throw new TypeError('unexpected bug');
      }
      return write.call(this, chunk);
    };
    try {
      await kit.sleep(300);
    } finally {
      proto.write = write;
    }
    const rate = await scene.tap.rate(1000);
    const { pixels } = await kit.sample(scene.tap, [centre], 0);
    return { thrown, rate, bubble: pixels[0], warnings: scene.warnings, ended: scene.ended };
  });
  expect(r.thrown).toBe(1);
  expect(r.ended).toBe(false);
  expect(r.rate).toBeGreaterThan(20);
  expectColor(r.bubble, 'red', 'the camera is still in the bubble');
  expect(r.warnings).toEqual([]);
  expect(errors.filter(e => /frame handler failed/.test(e))).toHaveLength(1);
  errors.length = 0;
});

test('a screen within a few pixels of the output size is drawn 1:1, so text stays sharp', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const contrast = {};
    // Sizes off by the odd pixel (odd-sized windows, even rounding), smaller and larger than the output.
    for (const [w, h] of [[1280, 720], [1279, 719], [1278, 717], [1283, 722]]) {
      const scene = window.scene = kit.scenario({
        screen: { pattern: 'stripes', width: w, height: h }, output: { width: 1280, height: 720 },
        bubble: { size: 's', x: 0, y: 0 },
      });
      await kit.sleep(300);
      // One-pixel black/white columns survive only if no pixel was resampled
      // (luma keeps full resolution through the video path).
      contrast[`${w}x${h}`] = await kit.columnContrast(scene.tap, [[600, 360], [1200, 650], [300, 200]]);
      scene.comp.stop();
      scene.tap.stop();
    }
    return contrast;
  });
  for (const [size, c] of Object.entries(r)) expect(c, `${size}: neighbouring columns differ`).toBeGreaterThan(200);
});

test('frames keep flowing on the camera clock while the screen is static', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const scene = window.scene = kit.scenario({ screen: { animate: false } });
    const screenTap = new kit.FrameTap(scene.screen.track);
    scene.screen.poke();                      // the only screen frame, after the compositor is listening
    await kit.sleep(300);
    const rate = await scene.tap.rate(1500);
    const { pixels } = await kit.sample(scene.tap, [[1200, 80], kit.bubblePoints(scene.size, { size: 'l' }).centre], 0);
    screenTap.stop();
    return { rate, pixels, screenFrames: screenTap.count };
  });
  expect(r.screenFrames).toBeLessThanOrEqual(2);
  expect(r.rate).toBeGreaterThan(20);
  expectColor(r.pixels[0], 'blue', 'the held screen frame');
  expectColor(r.pixels[1], 'red', 'bubble');
});

test('compositing needs no timers or animation frames, which stop or slow down in a hidden tab', async ({ page }) => {
  const r = await page.evaluate(async () => {
    // The synthetic sources paint on their own interval, so they start before the clocks are taken away.
    const screen = kit.colorTrack('#00f', 1280, 720);
    const camera = kit.colorTrack('#f00', 640, 360);
    const realSetTimeout = setTimeout;
    const wait = ms => new Promise(resolve => realSetTimeout(resolve, ms));
    const names = ['setTimeout', 'setInterval', 'requestAnimationFrame', 'requestIdleCallback'];
    const saved = Object.fromEntries(names.map(n => [n, window[n]]));
    const calls = [];
    for (const n of names) window[n] = () => { calls.push(n); return 0; };
    try {
      const comp = new video.Compositor({
        screenTrack: screen.track, cameraTrack: camera.track, width: 1280, height: 720, fps: 30,
      });
      window.scene = { comp };
      const tap = new kit.FrameTap(comp.start());
      await wait(300);
      const before = tap.count;
      await wait(1000);
      const rate = tap.count - before;
      comp.stop();
      tap.stop();
      return { calls, rate };
    } finally {
      Object.assign(window, saved);
    }
  });
  expect(r.calls).toEqual([]);
  expect(r.rate).toBeGreaterThan(20);
});

test('a camera faster than the requested fps does not raise the output rate', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const scene = window.scene = kit.scenario({ camera: null, screen: { animate: false } });
    const fast = kit.colorTrack('#f00', 640, 360, { fps: 60 });
    scene.comp.setCameraTrack(fast.track);
    const cameraTap = new kit.FrameTap(fast.track);
    scene.screen.poke();
    await kit.sleep(300);
    const [rate, cameraRate] = await Promise.all([scene.tap.rate(2000), cameraTap.rate(2000)]);
    cameraTap.stop();
    return { rate, cameraRate };
  });
  expect(r.cameraRate).toBeGreaterThan(45);
  expect(r.rate).toBeGreaterThan(20);
  expect(r.rate).toBeLessThan(32);
});

test('screen frames fill the gaps between frames of a slow camera', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const scene = window.scene = kit.scenario({ camera: null });
    const slow = kit.colorTrack('#f00', 640, 360, { fps: 10 });
    scene.comp.setCameraTrack(slow.track);
    const cameraTap = new kit.FrameTap(slow.track);
    await kit.sleep(300);
    const [rate, cameraRate] = await Promise.all([scene.tap.rate(2000), cameraTap.rate(2000)]);
    const { pixels } = await kit.sample(scene.tap, [kit.bubblePoints(scene.size, {}).centre], 0);
    cameraTap.stop();
    return { rate, cameraRate, bubble: pixels[0] };
  });
  expect(r.cameraRate).toBeLessThan(12);
  expect(r.rate).toBeGreaterThan(18);
  expect(r.rate).toBeLessThan(32);
  expectColor(r.bubble, 'red', 'the slow camera still shows');
});

test('frames keep flowing on the screen clock when the camera track stops', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const scene = window.scene = kit.scenario();
    const centre = kit.bubblePoints(scene.size, { size: 'l' }).centre;
    const before = (await kit.sample(scene.tap, [centre], 300)).pixels[0];
    scene.camera.track.stop();
    await kit.sleep(300);
    const rate = await scene.tap.rate(1500);
    const after = (await kit.sample(scene.tap, [centre], 0)).pixels[0];
    return { before, rate, after, warnings: scene.warnings, ended: scene.ended, stats: scene.comp.stats };
  });
  expectColor(r.before, 'red', 'bubble before');
  expectColor(r.after, 'blue', 'no bubble after the camera stopped');
  expect(r.rate).toBeGreaterThan(20);
  expect(r.stats.fps).toBeGreaterThan(18);
  expect(r.ended).toBe(false);
  expect(r.warnings).toHaveLength(1);
  expect(r.warnings[0]).toMatch(/camera stopped/i);
});

test('camera and screen can be switched off and swapped mid-take without touching the old tracks', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const scene = window.scene = kit.scenario();
    const points = [kit.bubblePoints(scene.size, { size: 'l' }).centre, [1200, 80]];
    const oldCamera = scene.camera.track;
    const oldScreen = scene.screen.track;
    await kit.sleep(300);

    scene.comp.setCameraTrack(null);
    const off = (await kit.sample(scene.tap, points)).pixels;
    const offRate = await scene.tap.rate(1000);

    const green = kit.colorTrack('#0f0', 640, 360);
    scene.comp.setCameraTrack(green.track);
    const swapped = (await kit.sample(scene.tap, points)).pixels;

    const magenta = kit.colorTrack('#f0f', 1280, 720);
    scene.comp.setScreenTrack(magenta.track);
    oldScreen.stop();                         // after the swap, so the compositor carries on
    const newScreen = (await kit.sample(scene.tap, points)).pixels;
    return {
      off, offRate, swapped, newScreen, warnings: scene.warnings, ended: scene.ended,
      oldCamera: oldCamera.readyState, live: [green.track.readyState, magenta.track.readyState],
    };
  });
  expectColor(r.off[0], 'blue', 'camera off: no bubble');
  expect(r.offRate).toBeGreaterThan(20);
  expectColor(r.swapped[0], 'green', 'new camera in the bubble');
  expectColor(r.newScreen[1], 'magenta', 'new screen');
  expectColor(r.newScreen[0], 'green', 'bubble kept over the new screen');
  expect(r.oldCamera).toBe('live');
  expect(r.live).toEqual(['live', 'live']);
  expect(r.ended).toBe(false);
  expect(r.warnings).toEqual([]);
});

test('stop() ends the output track and every VideoFrame is closed exactly once', async ({ page }) => {
  const r = await page.evaluate(async () => {
    kit.frameAudit.reset();
    const scene = window.scene = kit.scenario({ camera: { pattern: true } });
    await kit.sleep(500);
    scene.comp.setScreenTrack(kit.colorTrack('#f0f', 800, 600).track);
    scene.comp.setCameraTrack(kit.colorTrack('#0f0', 640, 480).track);
    await kit.sleep(500);
    scene.comp.setBubble({ shape: 'rounded', mirror: true });
    await kit.sample(scene.tap, [[10, 10]]);
    const framesOut = scene.comp.stats.framesOut;
    scene.comp.stop();
    scene.comp.stop();                        // idempotent
    scene.tap.stop();
    await kit.sleep(300);
    return {
      framesOut, ended: scene.ended, state: scene.out.readyState, audit: kit.frameAudit.report(),
      inputs: [scene.screen.track.readyState, scene.camera.track.readyState], stats: scene.comp.stats,
    };
  });
  expect(r.framesOut).toBeGreaterThan(20);
  expect(r.state).toBe('ended');
  expect(r.ended).toBe(true);
  expect(r.inputs).toEqual(['live', 'live']);
  expect(r.audit.total).toBeGreaterThan(40);
  expect(r.audit.open).toBe(0);
  expect(r.audit.doubleCloses).toBe(0);
  expect(r.stats.framesOut).toBe(r.framesOut);
});

test('the output ends, like the screen track, when screen sharing stops', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const scene = window.scene = kit.scenario();
    await kit.sleep(300);
    scene.screen.track.stop();
    await kit.sleep(300);
    const framesOut = scene.comp.stats.framesOut;
    await kit.sleep(300);
    return {
      ended: scene.ended, state: scene.out.readyState, camera: scene.camera.track.readyState,
      grew: scene.comp.stats.framesOut !== framesOut, warnings: scene.warnings,
    };
  });
  expect(r.ended).toBe(true);
  expect(r.state).toBe('ended');
  expect(r.camera).toBe('live');
  expect(r.grew).toBe(false);
  expect(r.warnings).toEqual([]);
});

test('stopping the output track from outside releases the compositor', async ({ page }) => {
  const r = await page.evaluate(async () => {
    kit.frameAudit.reset();
    const scene = window.scene = kit.scenario();
    await kit.sleep(300);
    // The tap's clone would keep the output's source alive, so it goes first.
    scene.tap.stop();
    scene.out.stop();
    await kit.sleep(300);
    const framesOut = scene.comp.stats.framesOut;
    await kit.sleep(300);
    return {
      grew: scene.comp.stats.framesOut !== framesOut, audit: kit.frameAudit.report(),
      inputs: [scene.screen.track.readyState, scene.camera.track.readyState],
    };
  });
  expect(r.inputs).toEqual(['live', 'live']);
  expect(r.grew).toBe(false);
  expect(r.audit.open).toBe(0);
  expect(r.audit.doubleCloses).toBe(0);
});
