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
  // Same CSS size, different scaling: different panels.
  assert.equal(controlsWouldBeRecorded(monitor(1920, 1080), display(true, 1920, 1080, 1.5)), false);
  // A portrait monitor next to a landscape one.
  assert.equal(controlsWouldBeRecorded(monitor(1920, 1080), display(true, 1080, 1920)), false);
});

test('a capture held to 3840×2160 matches a bigger display of the same shape, not a smaller or other-shaped one', () => {
  // A 5K panel (5120×2880) arrives scaled to 3840×2160.
  assert.equal(controlsWouldBeRecorded(monitor(3840, 2160), display(true, 5120, 2880)), true);
  assert.equal(controlsWouldBeRecorded(monitor(3840, 2160), display(true, 2560, 1440, 2)), true);
  // A super-ultrawide 5120×1440 arrives as 3840×1080.
  assert.equal(controlsWouldBeRecorded(monitor(3840, 1080), display(true, 5120, 1440)), true);
  // Smaller than the capture: can't be the panel it came from.
  assert.equal(controlsWouldBeRecorded(monitor(3840, 2160), display(true, 2560, 1440)), false);
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
