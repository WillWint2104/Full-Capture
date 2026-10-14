// Screen and camera capture against Chromium's fake devices (the screen picker
// auto-selects "Entire screen"; see playwright.config.mjs).
import { test, expect } from '@playwright/test';
import { openHarness, trackErrors } from './helpers.mjs';

const ENTRY = 'test/e2e/harness/video.entry.js';

let errors;
test.beforeEach(async ({ page }) => {
  errors = trackErrors(page);
  await openHarness(page, ENTRY);
});
test.afterEach(() => {
  expect(errors).toEqual([]);
});

for (const key of ['standard', 'high', 'smooth']) {
  test(`pickScreen returns the whole monitor sized for the ${key} preset`, async ({ page }) => {
    const r = await page.evaluate(async key => {
      const preset = video.QUALITY_PRESETS[key];
      const s = await video.pickScreen({ preset });
      // The size of frames actually delivered, once the resize has taken effect.
      const tap = new kit.FrameTap(s.videoTrack);
      await kit.sleep(400);
      const frame = await tap.next();
      const delivered = [frame.displayWidth, frame.displayHeight];
      frame.close();
      tap.stop();
      const settings = s.videoTrack.getSettings();
      const result = {
        preset, delivered, surface: s.surface, label: s.label, width: s.width, height: s.height,
        native: [s.nativeWidth, s.nativeHeight],
        hint: s.videoTrack.contentHint, frameRate: settings.frameRate, live: s.videoTrack.readyState,
        hasAudio: s.audioTrack?.kind === 'audio', inStream: s.stream.getVideoTracks()[0] === s.videoTrack,
      };
      s.stream.getTracks().forEach(t => t.stop());
      return result;
    }, key);
    const { preset } = r;
    expect(r.surface).toBe('monitor');
    expect(r.label).toBe('Whole screen');
    expect(r.live).toBe('live');
    expect(r.inStream).toBe(true);
    expect(r.hasAudio).toBe(true);
    expect(r.hint).toBe(preset.contentHint);
    expect(r.width).toBeGreaterThan(0);
    expect(r.height).toBeGreaterThan(0);
    expect(r.height).toBeLessThanOrEqual(preset.maxHeight);
    expect(r.width).toBeLessThanOrEqual(3840);
    expect(r.delivered[1]).toBeLessThanOrEqual(preset.maxHeight);
    expect(r.delivered[0]).toBeLessThanOrEqual(3840);
    // The reported size is the picture's, not the constraint limits.
    expect(r.delivered).toEqual([r.width, r.height]);
    expect(r.frameRate).toBeLessThanOrEqual(preset.fps);
    // Fitting never grows the picture.
    expect(r.native[0]).toBeGreaterThanOrEqual(r.width);
    expect(r.native[1]).toBeGreaterThanOrEqual(r.height);
  });
}

test('pickScreen without system audio returns no audio track', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const s = await video.pickScreen({ preset: video.QUALITY_PRESETS.standard, systemAudio: false });
    const result = { audioTrack: s.audioTrack, audioInStream: s.stream.getAudioTracks().length };
    s.stream.getTracks().forEach(t => t.stop());
    return result;
  });
  expect(r).toEqual({ audioTrack: null, audioInStream: 0 });
});

test('a page that may not capture the screen gets a "blocked" error', async ({ page }) => {
  const r = await page.evaluate(async () => {
    // Borrow the mediaDevices of a frame whose permissions policy forbids display capture.
    const frame = document.createElement('iframe');
    frame.allow = "display-capture 'none'";
    frame.srcdoc = '<p>embedded</p>';
    document.body.append(frame);
    await new Promise(resolve => { frame.onload = resolve; });
    Object.defineProperty(navigator, 'mediaDevices', { value: frame.contentWindow.navigator.mediaDevices, configurable: true });
    try {
      await video.pickScreen({ preset: video.QUALITY_PRESETS.standard });
      return null;
    } catch (e) {
      return { name: e.name, code: e.code, message: e.message, cause: e.cause?.message };
    }
  });
  expect(r.name).toBe('CaptureError');
  expect(r.code).toBe('blocked');
  expect(r.cause).toMatch(/permissions policy/);
  expect(r.message).toMatch(/double-clicking the file/);
  // Chromium logs the violation itself.
  expect(errors).toEqual([expect.stringMatching(/Permissions policy violation: display-capture/)]);
  errors.length = 0;
});

test('openCamera opens the fake camera and listDevices names it', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const stream = await video.openCamera('', { width: 1280, height: 720, fps: 30 });
    const track = stream.getVideoTracks()[0];
    const tap = new kit.FrameTap(track);
    const rate = await tap.rate(1000);
    tap.stop();
    const settings = track.getSettings();
    const devices = await video.listDevices();
    const again = await video.openCamera(settings.deviceId);
    const sameDevice = again.getVideoTracks()[0].getSettings().deviceId === settings.deviceId;
    const result = {
      tracks: stream.getTracks().map(t => t.kind), live: track.readyState, label: track.label,
      size: [settings.width, settings.height], frameRate: settings.frameRate, rate, devices, deviceId: settings.deviceId, sameDevice,
    };
    [stream, again].forEach(s => s.getTracks().forEach(t => t.stop()));
    return result;
  });
  expect(r.tracks).toEqual(['video']);
  expect(r.live).toBe('live');
  expect(r.label).not.toBe('');
  expect(r.size[0]).toBeLessThanOrEqual(1280);
  expect(r.size[1]).toBeLessThanOrEqual(720);
  expect(r.frameRate).toBeLessThanOrEqual(30);
  expect(r.rate).toBeGreaterThan(10);
  expect(r.sameDevice).toBe(true);
  const camera = r.devices.cameras.find(c => c.deviceId === r.deviceId);
  expect(camera?.label).toBe(r.label);
  expect(r.devices.mics.length).toBeGreaterThan(0);
  for (const d of [...r.devices.mics, ...r.devices.cameras]) expect(Object.keys(d).sort()).toEqual(['deviceId', 'label']);
});

test('openCamera reports a camera that is not connected', async ({ page }) => {
  const r = await page.evaluate(async () => {
    try {
      await video.openCamera('no-such-camera');
      return null;
    } catch (e) {
      return { name: e.name, code: e.code, message: e.message };
    }
  });
  expect(r).toMatchObject({ name: 'CaptureError', code: 'failed' });
  expect(r.message).toMatch(/isn’t connected/);
});

test('onDeviceChange calls back on devicechange until unsubscribed', async ({ page }) => {
  const r = await page.evaluate(async () => {
    let calls = 0;
    const off = video.onDeviceChange(() => { calls++; throw new Error('listener bug'); });
    navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
    const during = calls;
    off();
    navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
    return { during, after: calls };
  });
  expect(r).toEqual({ during: 1, after: 1 });
  // The listener's own error is logged, never thrown out of the event handler.
  expect(errors.filter(e => /listener failed/.test(e))).toHaveLength(1);
  errors.length = 0;
});
