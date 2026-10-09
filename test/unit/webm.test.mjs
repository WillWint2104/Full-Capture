import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  locateInfo, prepareStreamingHeader, injectDuration, patchWebmBlob, encodeDurationPayload,
  encodeSize, readSize, NeedMoreData, lastTimestampMs, readTimecodeScale,
} from '../../src/app/media/webm.js';

const fixture = name => readFile(new URL(`../fixtures/${name}`, import.meta.url)).then(b => new Uint8Array(b));
const durationOf = bytes => {
  const l = locateInfo(bytes);
  assert.ok(l.duration, 'Duration element present');
  const dv = new DataView(bytes.buffer, bytes.byteOffset + l.duration.offset, l.duration.size);
  return (l.duration.size === 8 ? dv.getFloat64(0) : dv.getFloat32(0)) * l.timecodeScale / 1e6;
};

test('MediaRecorder output has no Duration and an unknown-size Segment', async () => {
  const bytes = await fixture('vp9-opus-2s.webm');
  const l = locateInfo(bytes);
  assert.equal(l.duration, null);
  assert.equal(l.segment.size.unknown, true);
  assert.equal(l.timecodeScale, 1_000_000);
});

test('injectDuration adds a readable Duration without touching media bytes', async () => {
  const bytes = await fixture('vp9-opus-2s.webm');
  const out = injectDuration(bytes, 2034.5);
  assert.equal(out.length, bytes.length + 11);
  assert.ok(Math.abs(durationOf(out) - 2034.5) < 1e-6);
  // Everything after Info is byte-identical, just shifted.
  const before = locateInfo(bytes).info.dataEnd;
  assert.deepEqual(out.subarray(before + 11), bytes.subarray(before));
  // Input is not modified.
  assert.equal(locateInfo(bytes).duration, null);
});

test('injectDuration overwrites an existing Duration in place', async () => {
  const once = injectDuration(await fixture('vp8-opus-1s.webm'), 1000);
  const twice = injectDuration(once, 4321);
  assert.equal(twice.length, once.length);
  assert.ok(Math.abs(durationOf(twice) - 4321) < 1e-6);
});

test('prepareStreamingHeader reports where to write the final duration', async () => {
  const first = await fixture('vp8-opus-1s.first-chunk.bin');
  const p = prepareStreamingHeader(first);
  assert.equal(p.durationSize, 8);
  p.bytes.set(encodeDurationPayload(61_000, p.timecodeScale), p.durationOffset);
  assert.ok(Math.abs(durationOf(p.bytes) - 61_000) < 1e-6);
});

test('a header split across tiny chunks asks for more data', async () => {
  const bytes = await fixture('vp9-opus-2s.webm');
  assert.throws(() => locateInfo(bytes.subarray(0, 1)), NeedMoreData);
  assert.throws(() => locateInfo(bytes.subarray(0, 60)), NeedMoreData);
  // As soon as Info is complete it succeeds.
  const end = locateInfo(bytes).info.dataEnd;
  assert.doesNotThrow(() => prepareStreamingHeader(bytes.subarray(0, end)));
});

test('patchWebmBlob reads only the head and keeps the rest of the file', async () => {
  const bytes = await fixture('vp9-opus-2s.webm');
  const blob = new Blob([bytes], { type: 'video/webm' });
  let readBytes = 0;
  const spy = new Proxy(blob, {
    get(target, prop) {
      if (prop === 'slice') return (...a) => { const s = target.slice(...a); const ab = s.arrayBuffer.bind(s); s.arrayBuffer = async () => { const r = await ab(); readBytes += r.byteLength; return r; }; return s; };
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  const out = await patchWebmBlob(spy, 2000, { initialBytes: 1024 });
  assert.equal(out.type, 'video/webm');
  assert.equal(out.size, bytes.length + 11);
  assert.ok(readBytes <= 4096, `read ${readBytes} bytes`);
  const outBytes = new Uint8Array(await out.arrayBuffer());
  assert.ok(Math.abs(durationOf(outBytes) - 2000) < 1e-6);
});

test('patchWebmBlob grows its read window when Info is past the first read', async () => {
  const bytes = await fixture('vp9-opus-2s.webm');
  const out = await patchWebmBlob(new Blob([bytes]), 1500, { initialBytes: 8 });
  assert.equal(out.size, bytes.length + 11);
});

test('patchWebmBlob returns non-WebM input unchanged', async () => {
  const blob = new Blob([new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70])], { type: 'video/mp4' });
  assert.equal(await patchWebmBlob(blob, 1000), blob);
});

test('encodeSize round-trips and never emits the reserved all-ones value', () => {
  for (const v of [0, 1, 126, 127, 128, 16382, 16383, 2 ** 20, 2 ** 35]) {
    const enc = encodeSize(v);
    const dec = readSize(enc, 0);
    assert.equal(dec.value, v);
    assert.equal(dec.unknown, false, `value ${v}`);
  }
  assert.equal(encodeSize(5, 4).length, 4);
  assert.throws(() => encodeSize(300, 1));
});

test('a sized Segment grows by the inserted bytes', async () => {
  const bytes = await fixture('vp8-opus-1s.webm');
  const l = locateInfo(bytes);
  // Rewrite the unknown 8-byte Segment size as a real size of the same width.
  const sized = bytes.slice();
  const segLen = bytes.length - l.segment.dataStart;
  sized.set(encodeSize(segLen, l.segment.size.length), l.segment.sizePos);
  const out = injectDuration(sized, 1000);
  const after = locateInfo(out);
  assert.equal(after.segment.size.value, segLen + 11);
});

test('lastTimestampMs finds the end of a recording from its tail', async () => {
  const bytes = await fixture('vp9-opus-2s.webm');
  const scale = readTimecodeScale(bytes);
  const ms = lastTimestampMs(bytes.subarray(bytes.length - 40_000), scale);
  assert.ok(ms > 1500 && ms < 2600, `got ${ms}`);
  // A truncated tail (crash mid-write) still gives an answer.
  const cut = lastTimestampMs(bytes.subarray(0, bytes.length - 777), scale);
  assert.ok(cut > 1000 && cut < 2600, `got ${cut}`);
  assert.equal(lastTimestampMs(new Uint8Array(100)), null);
});
