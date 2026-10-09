import { test } from 'node:test';
import assert from 'node:assert/strict';
import { controlsWouldBeRecorded } from '../../src/app/ui/popout.js';
import { topAlert } from '../../src/app/ui/notices.js';

const monitor = (w, h) => ({ surface: 'monitor', nativeWidth: w, nativeHeight: h });
const display = (isExtended, width, height, dpr = 1) => ({ isExtended, width, height, dpr });

test('window and tab captures never contain the floating controls', () => {
  for (const surface of ['window', 'browser']) {
    assert.equal(controlsWouldBeRecorded({ surface, nativeWidth: 1920, nativeHeight: 1080 }, display(false, 1920, 1080)), false);
  }
  assert.equal(controlsWouldBeRecorded(null, display(false, 1920, 1080)), false);
});

test('a whole-screen capture on a single display contains them', () => {
  assert.equal(controlsWouldBeRecorded(monitor(1920, 1080), display(false, 1920, 1080)), true);
  // Whatever the sizes say: there is only one screen.
  assert.equal(controlsWouldBeRecorded(monitor(1920, 1080), display(false, 1280, 720)), true);
});

test('without isExtended (or a size) it plays safe and counts them as recorded', () => {
  assert.equal(controlsWouldBeRecorded(monitor(1920, 1080), { width: 1920, height: 1080, dpr: 1 }), true);
  assert.equal(controlsWouldBeRecorded(monitor(1920, 1080), null), true);
  assert.equal(controlsWouldBeRecorded(monitor(0, 0), display(true, 2560, 1440)), true);
  assert.equal(controlsWouldBeRecorded(monitor(1920, 1080), display(true, 0, 0)), true);
});

test('on an extended desktop, a display the size of the recorded monitor counts (in device pixels, within 2 %)', () => {
  assert.equal(controlsWouldBeRecorded(monitor(1920, 1080), display(true, 1920, 1080)), true);
  // 2560×1440 at 150 % is a 3840×2160 panel.
  assert.equal(controlsWouldBeRecorded(monitor(3840, 2160), display(true, 2560, 1440, 1.5)), true);
  // 1536×864 CSS px at 125 % is 1920×1080.
  assert.equal(controlsWouldBeRecorded(monitor(1920, 1080), display(true, 1536, 864, 1.25)), true);
  // Rounding: 1366×768 reported, 1360×768 captured.
  assert.equal(controlsWouldBeRecorded(monitor(1360, 768), display(true, 1366, 768)), true);
});

test('on an extended desktop, a display of another size is not the recorded monitor', () => {
  assert.equal(controlsWouldBeRecorded(monitor(1920, 1080), display(true, 2560, 1440)), false);
  assert.equal(controlsWouldBeRecorded(monitor(2560, 1440), display(true, 1920, 1080)), false);
  assert.equal(controlsWouldBeRecorded(monitor(1920, 1080), display(true, 1280, 1024)), false);
  // A portrait monitor next to a landscape one.
  assert.equal(controlsWouldBeRecorded(monitor(1920, 1080), display(true, 1080, 1920)), false);
});

test('page zoom can’t hide the recorded monitor: devicePixelRatio includes it, so every common scale is tried', () => {
  // A 1080p monitor at 100 % scaling, with Chrome's page zoom at 110 %, 125 %, 90 % or 150 %.
  for (const zoom of [1.1, 1.25, 0.9, 1.5]) assert.equal(controlsWouldBeRecorded(monitor(1920, 1080), display(true, 1920, 1080, zoom)), true, `zoom ${zoom}`);
  // A 1440p panel at 125 % scaling (2048×1152 CSS px) with 110 % zoom.
  assert.equal(controlsWouldBeRecorded(monitor(2560, 1440), display(true, 2048, 1152, 1.25 * 1.1)), true);
  // A 4K panel at 150 % with 90 % zoom.
  assert.equal(controlsWouldBeRecorded(monitor(3840, 2160), display(true, 2560, 1440, 1.5 * 0.9)), true);
  // A display that can't be the recorded monitor at any common scale still keeps its controls, zoomed or not.
  for (const dpr of [1, 1.1, 1.25]) {
    assert.equal(controlsWouldBeRecorded(monitor(1920, 1080), display(true, 2560, 1440, dpr)), false);
    assert.equal(controlsWouldBeRecorded(monitor(2560, 1440), display(true, 1920, 1080, dpr)), false);
    assert.equal(controlsWouldBeRecorded(monitor(1920, 1080), display(true, 1920, 1200, dpr)), false);
  }
});

test('only scales a page zoom could explain are tried, so screens next to a 4K monitor keep their controls', () => {
  // A 4K monitor is recorded; the controls are on a 1080p or 1440p screen at 100 % (no zoom).
  assert.equal(controlsWouldBeRecorded(monitor(3840, 2160), display(true, 1920, 1080, 1)), false);
  assert.equal(controlsWouldBeRecorded(monitor(3840, 2160), display(true, 1366, 768, 1)), false);
  // The 4K monitor itself at 150 % and 110 % zoom, or at 200 % and 90 % zoom, is still found.
  assert.equal(controlsWouldBeRecorded(monitor(3840, 2160), display(true, 2560, 1440, 1.5 * 1.1)), true);
  assert.equal(controlsWouldBeRecorded(monitor(3840, 2160), display(true, 1920, 1080, 2 * 0.9)), true);
});

test('a capture held to 3840×2160 matches a bigger display of the same shape, not a smaller or other-shaped one', () => {
  // A 5K panel (5120×2880) arrives scaled to 3840×2160.
  assert.equal(controlsWouldBeRecorded(monitor(3840, 2160), display(true, 5120, 2880)), true);
  assert.equal(controlsWouldBeRecorded(monitor(3840, 2160), display(true, 2560, 1440, 2)), true);
  // A super-ultrawide 5120×1440 arrives as 3840×1080.
  assert.equal(controlsWouldBeRecorded(monitor(3840, 1080), display(true, 5120, 1440)), true);
  // 2560×1440 CSS px could be a 4K panel at 150 % (zoom hides the scale): it counts.
  assert.equal(controlsWouldBeRecorded(monitor(3840, 2160), display(true, 2560, 1440)), true);
  // Bigger but another shape (16:10).
  assert.equal(controlsWouldBeRecorded(monitor(3840, 2160), display(true, 5120, 3200)), false);
  // An unclamped capture never matches by shape alone.
  assert.equal(controlsWouldBeRecorded(monitor(1920, 1080), display(true, 3840, 2160)), false);
});

test('topAlert: no sound first, then errors, then warnings, oldest first; info and nothing give null', () => {
  const storage = { id: 'storage-low', kind: 'warning', title: 'Storage is nearly full' };
  const camera = { id: 'camera-lost', kind: 'warning', title: 'Camera disconnected' };
  const failed = { id: 'other', kind: 'error', title: 'Something failed' };
  const noAudio = { id: 'no-audio', kind: 'error', title: 'No sound from your microphone' };
  const micLost = { id: 'mic-lost', kind: 'error', title: 'Microphone disconnected' };
  assert.equal(topAlert([]), null);
  assert.equal(topAlert(), null);
  assert.equal(topAlert([{ id: 'x', kind: 'info', title: 'FYI' }]), null);
  assert.equal(topAlert([storage, camera]), storage);
  assert.equal(topAlert([camera, storage]), camera);
  assert.equal(topAlert([storage, failed]), failed);
  assert.equal(topAlert([storage, failed, noAudio]), noAudio);
  assert.equal(topAlert([micLost, noAudio]), micLost);
});
