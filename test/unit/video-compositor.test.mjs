import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUBBLE_SIZES, bubbleRect, isCompositingSupported, Compositor } from '../../src/app/video/compositor.js';
import { DEFAULT_SETTINGS } from '../../src/app/lib/settings.js';

const CORNERS = { TL: [0, 0], TR: [1, 0], BL: [0, 1], BR: [1, 1] };
const SIZES = ['s', 'm', 'l'];

/** The invariants every placement must satisfy. */
function assertInside(frame, rect, label) {
  const margin = Math.round(frame.height * 0.02);
  for (const k of ['x', 'y', 'size']) assert.ok(Number.isInteger(rect[k]), `${label}: ${k} is an integer`);
  assert.ok(rect.size >= 0, `${label}: size >= 0`);
  assert.ok(rect.x >= 0 && rect.y >= 0, `${label}: not off the top/left`);
  assert.ok(rect.x + rect.size <= frame.width, `${label}: not off the right`);
  assert.ok(rect.y + rect.size <= frame.height, `${label}: not off the bottom`);
  if (rect.size > 0 && frame.width - 2 * margin >= rect.size) {
    assert.ok(rect.x >= margin && rect.x + rect.size <= frame.width - margin, `${label}: horizontal margin`);
    assert.ok(rect.y >= margin && rect.y + rect.size <= frame.height - margin, `${label}: vertical margin`);
  }
}

test('bubble sizes are fractions of the output height', () => {
  assert.deepEqual({ ...BUBBLE_SIZES }, { s: 0.2, m: 0.27, l: 0.35 });
  assert.ok(Object.isFrozen(BUBBLE_SIZES));
});

test('every size in every corner of a 1080p frame sits exactly at the 2% margin', () => {
  const frame = { width: 1920, height: 1080 };
  const margin = 22; // round(1080 * 0.02)
  const expectedSize = { s: 216, m: 292, l: 378 };
  for (const size of SIZES) {
    for (const [name, [x, y]] of Object.entries(CORNERS)) {
      const r = bubbleRect(frame, { shape: 'circle', size, x, y, mirror: false });
      const s = expectedSize[size];
      assert.equal(r.size, s, `${size} ${name} size`);
      assert.equal(r.x, x === 0 ? margin : 1920 - margin - s, `${size} ${name} x`);
      assert.equal(r.y, y === 0 ? margin : 1080 - margin - s, `${size} ${name} y`);
    }
  }
});

test('the bubble is centred on (x, y) when it fits there', () => {
  assert.deepEqual(bubbleRect({ width: 1920, height: 1080 }, { size: 'l', x: 0.5, y: 0.5 }), { x: 771, y: 351, size: 378 });
  // The default bubble (bottom right, medium) from settings.
  assert.deepEqual(bubbleRect({ width: 1920, height: 1080 }, DEFAULT_SETTINGS.bubble), { x: 1544, y: 740, size: 292 });
  assert.deepEqual(bubbleRect({ width: 1280, height: 720 }, { size: 'm', x: 0.25, y: 0.5 }), { x: 223, y: 263, size: 194 });
});

test('positions near or past an edge are clamped inside the margin', () => {
  const frame = { width: 1280, height: 720 };
  const margin = 14;
  const near = bubbleRect(frame, { size: 's', x: 0.99, y: 0.01 });
  assert.deepEqual(near, { x: 1280 - margin - 144, y: margin, size: 144 });
  assert.deepEqual(bubbleRect(frame, { size: 's', x: 7, y: -3 }), near, 'out-of-range fractions clamp to 0..1');
});

test('shape and mirror never change the placement', () => {
  const frame = { width: 2560, height: 1440 };
  const base = { size: 'm', x: 0.3, y: 0.7 };
  const a = bubbleRect(frame, { ...base, shape: 'circle', mirror: false });
  const b = bubbleRect(frame, { ...base, shape: 'rounded', mirror: true });
  assert.deepEqual(a, b);
});

test('odd aspect ratios keep every size and corner inside the frame', () => {
  const frames = [
    { width: 1280, height: 720 },
    { width: 1024, height: 768 },     // 4:3
    { width: 2560, height: 1600 },    // 16:10
    { width: 3440, height: 1440 },    // ultrawide
    { width: 5120, height: 1440 },    // super ultrawide
    { width: 1080, height: 1920 },    // portrait
    { width: 3840, height: 400 },     // very short
    { width: 1366, height: 768 },
    { width: 1365, height: 767 },     // odd numbers
  ];
  for (const frame of frames) {
    for (const size of SIZES) {
      for (const [name, [x, y]] of Object.entries(CORNERS)) {
        const r = bubbleRect(frame, { size, x, y });
        assertInside(frame, r, `${frame.width}x${frame.height} ${size} ${name}`);
        assert.equal(r.size, Math.round(frame.height * BUBBLE_SIZES[size]), 'height-based size when it fits');
      }
    }
  }
});

test('a frame narrower than the bubble shrinks the bubble to fit between the margins', () => {
  const frame = { width: 200, height: 2000 };
  for (const size of SIZES) {
    const r = bubbleRect(frame, { size, x: 1, y: 1 });
    assert.equal(r.size, 200 - 2 * 40, `${size} limited by width`);
    assert.equal(r.x, 40);
    assert.equal(r.y, 2000 - 40 - 120);
    assertInside(frame, r, `narrow ${size}`);
  }
});

test('degenerate frames give an empty bubble that is still inside the frame', () => {
  const tiny = bubbleRect({ width: 30, height: 1000 }, { size: 'l', x: 1, y: 1 });
  assert.equal(tiny.size, 0);
  assertInside({ width: 30, height: 1000 }, tiny, 'tiny');
  assert.deepEqual(bubbleRect({ width: 0, height: 0 }, { size: 'm' }), { x: 0, y: 0, size: 0 });
  assert.deepEqual(bubbleRect({ width: -5, height: NaN }, { size: 'm' }), { x: 0, y: 0, size: 0 });
  const small = { width: 40, height: 20 };
  assertInside(small, bubbleRect(small, { size: 'l', x: 1, y: 1 }), 'small');
});

test('fractional output sizes are floored to whole pixels', () => {
  assert.deepEqual(
    bubbleRect({ width: 1280.9, height: 720.9 }, { size: 'm', x: 0, y: 0 }),
    bubbleRect({ width: 1280, height: 720 }, { size: 'm', x: 0, y: 0 }),
  );
});

test('missing or invalid bubble fields fall back to the default bubble', () => {
  const frame = { width: 1920, height: 1080 };
  const def = bubbleRect(frame, DEFAULT_SETTINGS.bubble);
  assert.deepEqual(bubbleRect(frame, undefined), def);
  assert.deepEqual(bubbleRect(frame, null), def);
  assert.deepEqual(bubbleRect(frame, {}), def);
  assert.deepEqual(bubbleRect(frame, { size: 'xl', x: NaN, y: 'top' }), def);
  assert.deepEqual(bubbleRect(frame, { size: 'toString' }), def, 'inherited keys are not sizes');
});

test('compositing is reported unsupported without the browser APIs', () => {
  assert.equal(isCompositingSupported(), false);
  const names = ['MediaStreamTrackProcessor', 'MediaStreamTrackGenerator', 'OffscreenCanvas', 'VideoFrame'];
  try {
    for (const n of names) globalThis[n] = function Fake() {};
    assert.equal(isCompositingSupported(), true);
    delete globalThis.MediaStreamTrackGenerator;
    assert.equal(isCompositingSupported(), false);
  } finally {
    for (const n of names) delete globalThis[n];
  }
});

test('Compositor validates its size and explains when it cannot start', () => {
  assert.throws(() => new Compositor({ width: 0, height: 720 }), TypeError);
  assert.throws(() => new Compositor({}), TypeError);
  const c = new Compositor({ width: 1280, height: 720, fps: 30 });
  assert.deepEqual(c.stats, { framesOut: 0, fps: 0 });
  // Setters before start() only record the wish.
  c.setBubble({ size: 'l' });
  c.setCameraVisible(false);
  c.setCameraTrack(null);
  assert.throws(() => c.start(), /can’t add the camera bubble/);
  c.stop();
  c.stop();
  assert.throws(() => c.start(), /stopped/);
});
