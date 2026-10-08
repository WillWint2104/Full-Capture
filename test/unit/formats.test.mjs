import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectFormats, recorderOptions, outputSize, videoBitrate, codecFromMime, QUALITY_PRESETS, bytesPerHour } from '../../src/app/media/formats.js';

const chrome = new Set(['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/webm;codecs=vp9,opus', 'video/webm', 'audio/webm;codecs=opus']);
const chromium = new Set(['video/webm;codecs=vp9,opus', 'video/webm', 'audio/webm;codecs=opus']);

test('detectFormats picks the first supported candidate of each kind', () => {
  assert.deepEqual(detectFormats(m => chrome.has(m)), {
    mp4: 'video/mp4;codecs=avc1.640028,mp4a.40.2', webm: 'video/webm;codecs=vp9,opus', audio: 'audio/webm;codecs=opus',
  });
  assert.equal(detectFormats(m => chromium.has(m)).mp4, null);
  assert.equal(detectFormats(() => { throw new Error('boom'); }).webm, null);
});

test('auto prefers MP4 and falls back to WebM with no note', () => {
  const size = { width: 1920, height: 1080, fps: 30 };
  assert.equal(recorderOptions({ format: 'auto', ...size, supported: detectFormats(m => chrome.has(m)) }).container, 'mp4');
  const fb = recorderOptions({ format: 'auto', ...size, supported: detectFormats(m => chromium.has(m)) });
  assert.equal(fb.container, 'webm');
  assert.equal(fb.note, '');
});

test('an explicit MP4 request that cannot be met says so', () => {
  const o = recorderOptions({ format: 'mp4', width: 1920, height: 1080, supported: detectFormats(m => chromium.has(m)) });
  assert.equal(o.container, 'webm');
  assert.match(o.note, /MP4/);
});

test('AAC gets a higher audio bitrate than Opus', () => {
  const s = detectFormats(m => chrome.has(m));
  assert.equal(recorderOptions({ format: 'mp4', width: 1920, height: 1080, supported: s }).audioBitsPerSecond, 160_000);
  assert.equal(recorderOptions({ format: 'webm', width: 1920, height: 1080, supported: s }).audioBitsPerSecond, 128_000);
});

test('outputSize keeps aspect, stays even, and caps width', () => {
  assert.deepEqual(outputSize(1920, 1080, 1080), { width: 1920, height: 1080 });
  assert.deepEqual(outputSize(3840, 2160, 1080), { width: 1920, height: 1080 });
  assert.deepEqual(outputSize(2560, 1600, 1080), { width: 1728, height: 1080 });
  assert.deepEqual(outputSize(1366, 768, 1080), { width: 1366, height: 768 });
  assert.deepEqual(outputSize(5120, 1440, 2160), { width: 3840, height: 1080 });
  const odd = outputSize(1365, 767, 1080);
  assert.equal(odd.width % 2, 0); assert.equal(odd.height % 2, 0);
});

test('bitrates scale with pixels and stay within bounds', () => {
  const hd = videoBitrate({ width: 1920, height: 1080, fps: 30, codec: 'h264' });
  const uhd = videoBitrate({ width: 3840, height: 2160, fps: 30, codec: 'h264' });
  const hd60 = videoBitrate({ width: 1920, height: 1080, fps: 60, codec: 'h264' });
  assert.ok(hd >= 4_000_000 && hd <= 6_000_000, String(hd));
  assert.ok(uhd > hd && uhd <= 16_000_000);
  assert.ok(hd60 > hd && hd60 < 2 * hd);
  assert.ok(videoBitrate({ width: 1920, height: 1080, codec: 'vp9' }) < hd);
  assert.equal(videoBitrate({ width: 320, height: 180 }), 1_500_000);
});

test('codecFromMime and presets', () => {
  assert.equal(codecFromMime('video/mp4;codecs=avc1.640028,mp4a.40.2'), 'h264');
  assert.equal(codecFromMime('video/webm;codecs=vp9,opus'), 'vp9');
  assert.equal(codecFromMime('video/webm'), 'unknown');
  for (const p of Object.values(QUALITY_PRESETS)) assert.ok(p.label && p.maxHeight && p.fps && p.contentHint);
});

test('options set a keyframe interval and estimate size per hour', () => {
  const o = recorderOptions({ format: 'auto', width: 1920, height: 1080, fps: 30, supported: detectFormats(m => chrome.has(m)) });
  assert.equal(o.videoKeyFrameIntervalDuration, 2000);
  const gb = bytesPerHour(o) / 1024 ** 3;
  assert.ok(gb > 1.5 && gb < 3.5, `${gb} GB/h`);
});
