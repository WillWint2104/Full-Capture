// Pure pieces of the recording subsystem: name collisions, the pause-aware
// clock, chunk ordering, staleness, and WebM duration from a file's tail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { uniqueName, folderErrorMessage } from '../../src/app/recording/folder.js';
import { Stopwatch, mergeChunks } from '../../src/app/recording/recorder.js';
import { isStale, blobTypeFor, takeLockName, webmEndMs, buildRecording, HEARTBEAT_STALE_MS } from '../../src/app/recording/journal.js';
import { sortTakes } from '../../src/app/recording/takes.js';
import { locateInfo } from '../../src/app/media/webm.js';

const fixture = name => readFile(new URL(`../fixtures/${name}`, import.meta.url)).then(b => new Uint8Array(b));
const durationOf = bytes => {
  const l = locateInfo(bytes);
  if (!l.duration) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset + l.duration.offset, l.duration.size);
  return (l.duration.size === 8 ? dv.getFloat64(0) : dv.getFloat32(0)) * l.timecodeScale / 1e6;
};

// ------------------------------------------------------------ uniqueName

test('uniqueName keeps a free name and numbers taken ones like Windows does', async () => {
  const taken = new Set(['Lesson.mp4', 'Lesson (2).mp4']);
  assert.equal(await uniqueName('Other.mp4', n => taken.has(n)), 'Other.mp4');
  assert.equal(await uniqueName('Lesson.mp4', n => taken.has(n)), 'Lesson (3).mp4');
  taken.delete('Lesson (2).mp4');
  assert.equal(await uniqueName('Lesson.mp4', n => taken.has(n)), 'Lesson (2).mp4');
});

test('uniqueName works with async checks, dotted names and names without an extension', async () => {
  const taken = new Set(['Fractions – Week 3 (2026-10-08 14.30).webm', 'notes']);
  const exists = async n => taken.has(n);
  assert.equal(await uniqueName('Fractions – Week 3 (2026-10-08 14.30).webm', exists), 'Fractions – Week 3 (2026-10-08 14.30) (2).webm');
  assert.equal(await uniqueName('notes', exists), 'notes (2)');
});

test('uniqueName gives up with a plain-English error after max attempts', async () => {
  await assert.rejects(uniqueName('a.mp4', () => true, { max: 5 }), /too many files/);
});

test('folderErrorMessage explains common file-system failures without jargon', () => {
  assert.match(folderErrorMessage({ name: 'QuotaExceededError' }, 'Lessons'), /disk with your “Lessons” folder is full/);
  assert.match(folderErrorMessage({ name: 'NotAllowedError' }), /no longer allowed/);
  assert.match(folderErrorMessage({ name: 'NotFoundError' }, 'Lessons'), /^Your “Lessons” folder can’t be found/);
  assert.match(folderErrorMessage({ name: 'Weird', message: 'boom' }), /\(boom\)/);
});

// ------------------------------------------------------------ Stopwatch

function fakeClock() {
  let t = 1000;
  return { now: () => t, advance: ms => { t += ms; } };
}

test('Stopwatch counts only recorded time and excludes pauses', () => {
  const c = fakeClock();
  const w = new Stopwatch(c.now);
  assert.equal(w.elapsedMs, 0);
  w.start();
  c.advance(3000);
  assert.equal(w.elapsedMs, 3000);
  w.pause();
  assert.equal(w.paused, true);
  c.advance(5000);
  assert.equal(w.elapsedMs, 3000, 'paused time is not counted');
  w.resume();
  c.advance(2000);
  assert.equal(w.elapsedMs, 5000);
  w.stop();
  c.advance(10_000);
  assert.equal(w.elapsedMs, 5000, 'frozen after stop');
});

test('Stopwatch stopped while paused does not count the pause', () => {
  const c = fakeClock();
  const w = new Stopwatch(c.now);
  w.start();
  c.advance(4000);
  w.pause();
  c.advance(7000);
  w.stop();
  c.advance(1000);
  assert.equal(w.elapsedMs, 4000);
  // A late resume after stop changes nothing.
  w.resume();
  c.advance(1000);
  assert.equal(w.elapsedMs, 4000);
});

test('Stopwatch ignores double pause / resume and pause before start', () => {
  const c = fakeClock();
  const w = new Stopwatch(c.now);
  w.pause();
  w.resume();
  w.start();
  c.advance(1000);
  w.pause();
  c.advance(1000);
  w.pause();
  c.advance(1000);
  w.resume();
  w.resume();
  c.advance(1000);
  assert.equal(w.elapsedMs, 2000);
});

// ------------------------------------------------------------ mergeChunks

test('mergeChunks orders by seq, prefers the first copy and reports gaps', () => {
  const b = s => ({ s });
  const journal = [{ seq: 2, blob: b('j2') }, { seq: 0, blob: b('j0') }];
  const memory = new Map([[1, b('m1')], [2, b('m2')], [4, b('m4')]]);
  const { parts, missing } = mergeChunks(journal, memory);
  assert.deepEqual(parts.map(p => p.s), ['j0', 'm1', 'j2', 'm4']);
  assert.deepEqual(missing, [3]);
  assert.deepEqual(mergeChunks(null, []).parts, []);
  assert.deepEqual(mergeChunks([{ seq: 1, blob: b('x') }]).missing, [0]);
});

// ------------------------------------------------------------ journal helpers

test('isStale uses the heartbeat (or the start) and the staleness window', () => {
  const now = 100_000;
  assert.equal(isStale({ heartbeatAt: now - 2000 }, now), false);
  assert.equal(isStale({ heartbeatAt: now - HEARTBEAT_STALE_MS - 1 }, now), true);
  assert.equal(isStale({ startedAt: now - 20_000 }, now), true);
  assert.equal(isStale({ heartbeatAt: now - 2000 }, now, 1000), true);
});

test('blobTypeFor uses the recorded type, v1 meta, or the container', () => {
  assert.equal(blobTypeFor({ mimeType: 'video/webm;codecs=vp9,opus' }), 'video/webm;codecs=vp9,opus');
  assert.equal(blobTypeFor({ mime: 'video/mp4' }), 'video/mp4');
  assert.equal(blobTypeFor({ container: 'mp4' }), 'video/mp4');
  assert.equal(blobTypeFor({}), 'video/webm');
  assert.equal(takeLockName('abc'), 'full-capture-take:abc');
});

test('webmEndMs reads the end time from the last cluster', async () => {
  const bytes = await fixture('vp9-opus-2s.webm');
  const end = await webmEndMs(new Blob([bytes]));
  assert.ok(end > 1800 && end <= 2100, `end ${end}`);
  // A recording cut off mid-cluster still yields a sensible end.
  const cut = await webmEndMs(new Blob([bytes.subarray(0, bytes.length - 5000)]));
  assert.ok(cut > 1000 && cut <= end, `cut ${cut}`);
  assert.equal(await webmEndMs(new Blob([new Uint8Array(100)])), null);
  assert.equal(await webmEndMs(new Blob([])), null);
});

test('buildRecording joins chunks and writes the tail-derived Duration into the header', async () => {
  const bytes = await fixture('vp9-opus-2s.webm');
  const parts = [bytes.subarray(0, 1), bytes.subarray(1, 500), bytes.subarray(500)].map(b => new Blob([b]));
  const { blob, durationMs } = await buildRecording(parts, 'video/webm', 99_999);
  assert.ok(durationMs > 1800 && durationMs <= 2100, `duration ${durationMs}`);
  const out = new Uint8Array(await blob.arrayBuffer());
  assert.ok(Math.abs(durationOf(out) - durationMs) < 1);
  assert.equal(blob.type, 'video/webm');
});

test('buildRecording falls back to elapsed time, and leaves MP4 alone', async () => {
  const junk = new Blob([new Uint8Array([1, 2, 3, 4])]);
  const mp4 = await buildRecording([junk], 'video/mp4', 1234);
  assert.equal(mp4.durationMs, 1234);
  assert.equal(mp4.blob.size, 4);
  const first = await fixture('vp8-opus-1s.first-chunk.bin'); // header + no complete cluster timestamps after it
  const r = await buildRecording([new Blob([first.subarray(0, 200)])], 'video/webm', 4321);
  assert.equal(r.durationMs, 4321);
});

// ------------------------------------------------------------ takes order

test('sortTakes lists newest first with a stable tie-break', () => {
  const rows = [{ id: 'b', createdAt: 1 }, { id: 'c', createdAt: 3 }, { id: 'a', createdAt: 1 }];
  assert.deepEqual(sortTakes(rows).map(r => r.id), ['c', 'a', 'b']);
  assert.deepEqual(rows.map(r => r.id), ['b', 'c', 'a'], 'input untouched');
});
