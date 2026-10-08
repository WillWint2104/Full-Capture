import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CaptureError, pickScreen, openCamera, listDevices, onDeviceChange } from '../../src/app/video/sources.js';
import { QUALITY_PRESETS } from '../../src/app/media/formats.js';

// sources.js only touches globalThis.navigator and globalThis.performance, so
// tests swap in fakes for the duration of one call.
async function withGlobals(globals, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(globals)) {
    saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
  try {
    return await fn();
  } finally {
    for (const [k, d] of Object.entries(saved)) {
      if (d) Object.defineProperty(globalThis, k, d);
      else delete globalThis[k];
    }
  }
}

/** A fake clock that getDisplayMedia can advance to simulate how long the picker was open. */
function fakeClock() {
  const clock = { t: 1000, now: () => clock.t };
  return clock;
}

/** A display track that, like Chrome, shrinks (never grows) to fit max constraints. */
function fakeVideoTrack({ label = 'screen:0:0', width = 3840, height = 2160, displaySurface = 'monitor', failApply = false } = {}) {
  return {
    kind: 'video', label, contentHint: '', stopped: false, applied: [],
    settings: { width, height, displaySurface, frameRate: 30 },
    getSettings() { return { ...this.settings }; },
    async applyConstraints(c) {
      this.applied.push(c);
      if (failApply) throw Object.assign(new Error('nope'), { name: 'OverconstrainedError' });
      const s = this.settings;
      const scale = Math.min(1, c.width.max / s.width, c.height.max / s.height);
      this.settings = { ...s, width: Math.round(s.width * scale), height: Math.round(s.height * scale) };
    },
    stop() { this.stopped = true; },
  };
}

function fakeStream(video, audio = null) {
  const tracks = [video, audio].filter(Boolean);
  return {
    getVideoTracks: () => tracks.filter(t => t.kind === 'video'),
    getAudioTracks: () => tracks.filter(t => t.kind === 'audio'),
    getTracks: () => tracks,
  };
}

const domError = (name, message = '') => new DOMException(message, name);

/** Run pickScreen against a getDisplayMedia fake; returns { result, error, calls }. */
async function runPick(getDisplayMedia, options) {
  const clock = fakeClock();
  const calls = [];
  const md = { getDisplayMedia: async opts => { calls.push(opts); return getDisplayMedia(opts, clock); } };
  return withGlobals({ navigator: { mediaDevices: md }, performance: clock }, async () => {
    try {
      return { result: await pickScreen(options), calls };
    } catch (error) {
      return { error, calls };
    }
  });
}

test('pickScreen asks for the whole monitor with the documented options', async () => {
  const video = fakeVideoTrack();
  const { calls } = await runPick(() => fakeStream(video), { preset: QUALITY_PRESETS.smooth, systemAudio: true });
  assert.deepEqual(calls[0], {
    video: { displaySurface: 'monitor', frameRate: { ideal: 60, max: 60 }, width: { max: 3840 }, height: { max: 2160 }, cursor: 'always' },
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false },
    systemAudio: 'include', selfBrowserSurface: 'exclude', surfaceSwitching: 'include', monitorTypeSurfaces: 'include',
  });
  const quiet = await runPick(() => fakeStream(fakeVideoTrack()), { preset: QUALITY_PRESETS.standard, systemAudio: false });
  assert.equal(quiet.calls[0].audio, false);
  assert.equal(quiet.calls[0].systemAudio, 'exclude');
  assert.deepEqual(quiet.calls[0].video.frameRate, { ideal: 30, max: 30 });
});

test('pickScreen sets the content hint and scales the capture to the preset', async () => {
  const video = fakeVideoTrack({ width: 3840, height: 2160 });
  const audio = { kind: 'audio', stop() {} };
  const { result } = await runPick(() => fakeStream(video, audio), { preset: QUALITY_PRESETS.standard });
  assert.equal(video.contentHint, 'detail');
  // The preset's own limits, so the capture follows a shared window that is resized later.
  assert.deepEqual(video.applied, [{ width: { max: 3840 }, height: { max: 1080 }, frameRate: { ideal: 30, max: 30 } }]);
  assert.equal(result.videoTrack, video);
  assert.equal(result.audioTrack, audio);
  assert.deepEqual(
    { surface: result.surface, label: result.label, width: result.width, height: result.height },
    { surface: 'monitor', label: 'Whole screen', width: 1920, height: 1080 },
  );
  assert.deepEqual([result.nativeWidth, result.nativeHeight], [3840, 2160], 'the size before fitting');

  const smooth = fakeVideoTrack({ width: 2560, height: 1440 });
  await runPick(() => fakeStream(smooth), { preset: QUALITY_PRESETS.smooth });
  assert.equal(smooth.contentHint, 'motion');
  assert.deepEqual(smooth.applied[0].height, { max: 1080 });

  const high = fakeVideoTrack({ width: 2560, height: 1440 });
  const r = await runPick(() => fakeStream(high), { preset: QUALITY_PRESETS.high });
  assert.deepEqual([r.result.width, r.result.height], [2560, 1440], 'never upscaled');
  assert.deepEqual([r.result.nativeWidth, r.result.nativeHeight], [2560, 1440]);
});

test('pickScreen defaults to the standard preset and tolerates a refused resize', async () => {
  const video = fakeVideoTrack({ width: 3840, height: 2160, failApply: true });
  const { result } = await runPick(() => fakeStream(video));
  assert.equal(video.applied.length, 1);
  assert.equal(video.contentHint, 'detail');
  assert.deepEqual([result.width, result.height], [3840, 2160], 'still usable at native size');
  assert.equal(result.audioTrack, null);
});

test('pickScreen names windows and tabs in plain words', async () => {
  const label = async (displaySurface, trackLabel) =>
    (await runPick(() => fakeStream(fakeVideoTrack({ displaySurface, label: trackLabel })))).result.label;
  assert.equal(await label('monitor', 'screen:2528732444:0'), 'Whole screen');
  assert.equal(await label('window', 'Fractions.pptx - PowerPoint'), 'Window: Fractions.pptx - PowerPoint');
  assert.equal(await label('window', 'window:1234:0'), 'One window');
  assert.equal(await label('browser', 'Khan Academy'), 'Tab: Khan Academy');
  assert.equal(await label('browser', 'web-contents-media-stream://12:3'), 'One browser tab');
  assert.equal(await label('browser', 'current-web-contents-media-stream://C1ADCD3F238C'), 'One browser tab');
  assert.equal(await label('browser', 'Screen: a lesson about monitors'), 'Tab: Screen: a lesson about monitors');
  const result = (await runPick(() => fakeStream(fakeVideoTrack({ displaySurface: 'window' })))).result;
  assert.equal(result.surface, 'window');
});

/**
 * A display track whose picture is `picture` (scaled down, never up, by max
 * constraints) but which, like Chrome before its first frame arrives, reports
 * the getDisplayMedia limits as its size. clone() shares the picture.
 */
function lyingDisplayTrack(picture, { readyState = 'live' } = {}) {
  const state = { picture, delivered: { ...picture } };
  const track = {
    kind: 'video', label: 'screen:1:0', contentHint: '', readyState, applied: [], clones: [],
    getSettings: () => ({ width: 3840, height: 2160, displaySurface: 'monitor' }),
    async applyConstraints(c) {
      this.applied.push(c);
      const scale = Math.min(1, c.width.max / picture.width, c.height.max / picture.height);
      state.delivered = { width: Math.round(picture.width * scale), height: Math.round(picture.height * scale) };
    },
    clone() {
      const clone = { stopped: false, source: state, stop() { this.stopped = true; } };
      track.clones.push(clone);
      return clone;
    },
    stop() {},
  };
  return track;
}

/**
 * A MediaStreamTrackProcessor stand-in: each read delivers one frame of the
 * clone's current picture after `delayMs`, even if the reader is cancelled
 * meanwhile (a frame already on its way). Records every frame and reader.
 */
function fakeProcessor({ delayMs = 0 } = {}) {
  const frames = [];
  const readers = [];
  class Processor {
    constructor({ track }) {
      this.readable = {
        getReader() {
          const reader = {
            cancelled: false,
            read: () => new Promise(resolve => {
              setTimeout(() => {
                const frame = {
                  displayWidth: track.source.delivered.width, displayHeight: track.source.delivered.height,
                  closed: false, close() { this.closed = true; },
                };
                frames.push(frame);
                resolve({ done: false, value: frame });
              }, delayMs);
            }),
            async cancel() { reader.cancelled = true; },
          };
          readers.push(reader);
          return reader;
        },
      };
    }
  }
  return { Processor, frames, readers };
}

test('pickScreen measures the real picture: wide screens keep their width at the preset height', async () => {
  const video = lyingDisplayTrack({ width: 3440, height: 1440 });   // ultrawide
  const { Processor, frames, readers } = fakeProcessor();
  const { result } = await withGlobals({ MediaStreamTrackProcessor: Processor },
    () => runPick(() => fakeStream(video), { preset: QUALITY_PRESETS.standard }));
  assert.deepEqual(video.applied[0].width, { max: 3840 });
  assert.deepEqual(video.applied[0].height, { max: 1080 });
  assert.deepEqual([result.nativeWidth, result.nativeHeight], [3440, 1440], 'not the 3840×2160 Chrome reports');
  assert.deepEqual([result.width, result.height], [2580, 1080], 'fitted by height only, not into a 16:9 box');
  assert.ok(frames.length >= 2 && frames.every(f => f.closed), 'every measured frame is closed');
  assert.ok(readers.every(r => r.cancelled), 'every reader is released');
  assert.ok(video.clones.length >= 2 && video.clones.every(c => c.stopped), 'every clone is stopped');
});

test('pickScreen falls back to the reported size when no frame comes, and releases a late frame', async () => {
  const video = lyingDisplayTrack({ width: 1920, height: 1080 });
  const { Processor, frames } = fakeProcessor({ delayMs: 520 });
  const started = Date.now();
  const { result } = await withGlobals({ MediaStreamTrackProcessor: Processor },
    () => runPick(() => fakeStream(video), { preset: QUALITY_PRESETS.standard }));
  assert.ok(Date.now() - started < 2000, 'gives up waiting');
  assert.deepEqual([result.nativeWidth, result.nativeHeight], [3840, 2160]);
  await new Promise(r => setTimeout(r, 100));
  assert.ok(frames.every(f => f.closed), 'a frame that arrives after giving up is closed');
});

test('pickScreen reports sharing stopped while it was being prepared', async () => {
  const video = lyingDisplayTrack({ width: 1920, height: 1080 }, { readyState: 'ended' });
  video.stopped = false;
  video.stop = function () { this.stopped = true; };
  const { error } = await runPick(() => fakeStream(video));
  assert.ok(error instanceof CaptureError);
  assert.equal(error.code, 'cancelled');
  assert.match(error.message, /sharing was stopped/);
  assert.equal(video.stopped, true);
});

test('pickScreen releases a stream that has no picture', async () => {
  const audio = { kind: 'audio', stopped: false, stop() { this.stopped = true; } };
  const { error } = await runPick(() => fakeStream(null, audio));
  assert.ok(error instanceof CaptureError);
  assert.equal(error.code, 'failed');
  assert.equal(audio.stopped, true);
});

test('pickScreen stops the shared screen if preparing it fails', async () => {
  const video = fakeVideoTrack();
  video.getSettings = () => { throw new Error('settings broke'); };
  const audio = { kind: 'audio', stopped: false, stop() { this.stopped = true; } };
  const { error } = await runPick(() => fakeStream(video, audio));
  assert.ok(error instanceof CaptureError);
  assert.equal(error.code, 'failed');
  assert.equal(error.cause.message, 'settings broke');
  assert.deepEqual([video.stopped, audio.stopped], [true, true]);
});

test('closing the picker is "cancelled"; an instant refusal is "blocked"', async () => {
  const slow = await runPick((_, clock) => { clock.t += 2500; throw domError('NotAllowedError', 'Permission denied'); });
  assert.equal(slow.error.code, 'cancelled');
  assert.match(slow.error.message, /Choose screen/);
  assert.equal(slow.error.cause.name, 'NotAllowedError');

  const instant = await runPick((_, clock) => { clock.t += 3; throw domError('NotAllowedError', 'Permission denied'); });
  assert.equal(instant.error.code, 'blocked');
  assert.match(instant.error.message, /IT settings/);
});

test('policy, system and security refusals are "blocked" however long they took', async () => {
  const cases = [
    domError('NotAllowedError', 'Failed to execute \'getDisplayMedia\' on \'MediaDevices\': Access to the feature "display-capture" is disallowed by permissions policy.'),
    domError('NotAllowedError', 'Access to the feature "display-capture" is disallowed by permission policy.'),
    domError('SecurityError', 'Not allowed in this context'),
  ];
  for (const e of cases) {
    const { error } = await runPick((_, clock) => { clock.t += 5000; throw e; });
    assert.equal(error.code, 'blocked', e.message);
    assert.match(error.message, /double-clicking the file/);
  }
  const system = await runPick((_, clock) => { clock.t += 5000; throw domError('NotAllowedError', 'Permission denied by system'); });
  assert.equal(system.error.code, 'blocked');
  assert.match(system.error.message, /privacy settings/);
});

test('other screen failures are "unsupported" or "failed" with advice', async () => {
  const code = async e => (await runPick(() => { throw e; })).error.code;
  assert.equal(await code(domError('NotSupportedError', 'Not supported')), 'unsupported');
  assert.equal(await code(domError('NotReadableError', 'Could not start video source')), 'failed');
  assert.equal(await code(domError('AbortError', 'Timeout starting video source')), 'failed');
  assert.equal(await code(new TypeError('bad constraints')), 'failed');
  const { error } = await runPick(() => { throw domError('InvalidStateError', 'x'); });
  assert.match(error.message, /try again/);
});

test('pickScreen without screen capture support says so', async () => {
  for (const navigator of [{}, { mediaDevices: {} }, undefined]) {
    await withGlobals({ navigator }, async () => {
      await assert.rejects(pickScreen({ preset: QUALITY_PRESETS.standard }), e => e instanceof CaptureError && e.code === 'unsupported');
    });
  }
});

/** Run openCamera against a getUserMedia fake. */
async function runCamera(getUserMedia, deviceId, options) {
  const calls = [];
  const md = { getUserMedia: async c => { calls.push(c); return getUserMedia(c); } };
  return withGlobals({ navigator: { mediaDevices: md } }, async () => {
    try {
      return { stream: await openCamera(deviceId, options), calls };
    } catch (error) {
      return { error, calls };
    }
  });
}

test('openCamera asks for an exact device only when one is chosen', async () => {
  const stream = { id: 'cam' };
  const chosen = await runCamera(() => stream, 'abc', { width: 640, height: 480, fps: 15 });
  assert.equal(chosen.stream, stream);
  assert.deepEqual(chosen.calls[0], {
    video: { deviceId: { exact: 'abc' }, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 15, max: 15 } },
    audio: false,
  });
  for (const any of ['', null, undefined, 'default']) {
    const { calls } = await runCamera(() => stream, any);
    assert.deepEqual(calls[0].video, { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } });
  }
});

test('camera failures map to codes with advice', async () => {
  const fail = async (e, deviceId = 'abc') => (await runCamera(() => { throw e; }, deviceId)).error;
  const blocked = await fail(domError('NotAllowedError', 'Permission denied'));
  assert.equal(blocked.code, 'blocked');
  assert.match(blocked.message, /address bar/);
  assert.equal((await fail(domError('NotAllowedError', 'Permission dismissed'))).code, 'cancelled');
  const system = await fail(domError('NotAllowedError', 'Permission denied by system'));
  assert.equal(system.code, 'blocked');
  assert.match(system.message, /Privacy/);
  assert.equal((await fail(domError('SecurityError'))).code, 'blocked');
  const missing = await fail(Object.assign(new Error(''), { name: 'OverconstrainedError', constraint: 'deviceId' }));
  assert.equal(missing.code, 'failed');
  assert.match(missing.message, /isn’t connected/);
  assert.match((await fail(domError('NotFoundError', 'Requested device not found'), '')).message, /No camera was found/);
  assert.match((await fail(domError('NotReadableError', 'Could not start video source'))).message, /busy/);
  assert.equal((await fail(new Error('weird'))).code, 'failed');
  await withGlobals({ navigator: { mediaDevices: {} } }, async () => {
    await assert.rejects(openCamera('x'), e => e.code === 'unsupported');
  });
});

test('listDevices sorts mics and cameras and copes without permission or support', async () => {
  const devices = [
    { kind: 'audioinput', deviceId: 'default', label: 'Default - Headset', groupId: 'g1' },
    { kind: 'audioinput', deviceId: 'm2', label: 'Headset', groupId: 'g1' },
    { kind: 'videoinput', deviceId: 'c1', label: 'HD Webcam', groupId: 'g2' },
    { kind: 'audiooutput', deviceId: 'o1', label: 'Speakers', groupId: 'g3' },
  ];
  await withGlobals({ navigator: { mediaDevices: { enumerateDevices: async () => devices } } }, async () => {
    assert.deepEqual(await listDevices(), {
      mics: [{ deviceId: 'default', label: 'Default - Headset' }, { deviceId: 'm2', label: 'Headset' }],
      cameras: [{ deviceId: 'c1', label: 'HD Webcam' }],
    });
  });
  const unlabeled = [{ kind: 'videoinput', deviceId: '', label: '' }];
  await withGlobals({ navigator: { mediaDevices: { enumerateDevices: async () => unlabeled } } }, async () => {
    assert.deepEqual((await listDevices()).cameras, [{ deviceId: '', label: '' }], 'a camera exists even before permission');
  });
  await withGlobals({ navigator: { mediaDevices: { enumerateDevices: async () => { throw new Error('x'); } } } }, async () => {
    assert.deepEqual(await listDevices(), { mics: [], cameras: [] });
  });
  await withGlobals({ navigator: {} }, async () => {
    assert.deepEqual(await listDevices(), { mics: [], cameras: [] });
  });
});

test('onDeviceChange subscribes, isolates listener errors and unsubscribes', async () => {
  const md = new EventTarget();
  const logged = [];
  const origError = console.error;
  console.error = (...args) => logged.push(args);
  try {
    await withGlobals({ navigator: { mediaDevices: md } }, async () => {
      let calls = 0;
      const off = onDeviceChange(() => { calls++; });
      const offThrow = onDeviceChange(() => { throw new Error('sync boom'); });
      const offReject = onDeviceChange(async () => { throw new Error('async boom'); });
      md.dispatchEvent(new Event('devicechange'));
      await new Promise(r => setTimeout(r, 0));
      assert.equal(calls, 1);
      assert.equal(logged.length, 2, 'both failures were reported, none escaped');
      off(); offThrow(); offReject();
      md.dispatchEvent(new Event('devicechange'));
      await new Promise(r => setTimeout(r, 0));
      assert.equal(calls, 1);
      assert.equal(logged.length, 2);
    });
  } finally {
    console.error = origError;
  }
  await withGlobals({ navigator: {} }, async () => {
    const off = onDeviceChange(() => {});
    assert.equal(typeof off, 'function');
    off();
  });
});

test('CaptureError carries a code, a message and the cause', () => {
  const cause = new Error('root');
  const e = new CaptureError('failed', 'Try again.', { cause });
  assert.ok(e instanceof Error);
  assert.equal(e.name, 'CaptureError');
  assert.equal(e.code, 'failed');
  assert.equal(e.message, 'Try again.');
  assert.equal(e.cause, cause);
});
