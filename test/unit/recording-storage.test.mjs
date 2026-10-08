// Sinks, the folder store and the takes list, run in node against an
// in-memory fake of the File System Access API (no IndexedDB in node, so
// FolderStore can't persist the handle and TakesLibrary runs in memory).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { MemorySink, FolderSink, HEADER_LIMIT_BYTES } from '../../src/app/recording/sinks.js';
import { FolderStore } from '../../src/app/recording/folder.js';
import { TakesLibrary } from '../../src/app/recording/takes.js';
import { locateInfo } from '../../src/app/media/webm.js';
import { createFakeDirectory } from '../e2e/harness/recording-fakefs.entry.js';

const fixture = name => readFile(new URL(`../fixtures/${name}`, import.meta.url)).then(b => new Uint8Array(b));
const durationOf = bytes => {
  const l = locateInfo(bytes);
  if (!l.duration) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset + l.duration.offset, l.duration.size);
  return (l.duration.size === 8 ? dv.getFloat64(0) : dv.getFloat32(0)) * l.timecodeScale / 1e6;
};
/** Split bytes like MediaRecorder does: a 1-byte first chunk, then pieces. */
const chunk = (bytes, sizes = [1, 40, 300, 5000]) => {
  const out = [];
  let p = 0;
  for (const s of sizes) { if (p >= bytes.length) break; out.push(bytes.subarray(p, p + s)); p += s; }
  while (p < bytes.length) { out.push(bytes.subarray(p, p + 16_384)); p += 16_384; }
  return out.map(b => new Blob([b]));
};

let dir;
async function readyStore(opts) {
  dir = createFakeDirectory(opts);
  globalThis.showDirectoryPicker = async () => dir;
  const store = new FolderStore();
  await store.choose();
  return store;
}

beforeEach(() => { delete globalThis.showDirectoryPicker; });

// ------------------------------------------------------------ MemorySink

test('MemorySink joins the chunks and patches the WebM duration in the header only', async () => {
  const bytes = await fixture('vp9-opus-2s.webm');
  const sink = new MemorySink();
  assert.equal(sink.kind, 'memory');
  await sink.open({ filename: 'a.webm', container: 'webm', mimeType: 'video/webm;codecs=vp9,opus' });
  for (const b of chunk(bytes)) await sink.write(b);
  await sink.write(new Blob([]));
  assert.equal(sink.size, bytes.length);
  const r = await sink.finalize({ durationMs: 2034 });
  assert.equal(r.savedTo, 'memory');
  assert.equal(r.filename, 'a.webm');
  assert.equal(r.blob.type, 'video/webm;codecs=vp9,opus');
  const out = new Uint8Array(await r.blob.arrayBuffer());
  assert.equal(out.length, bytes.length + 11);
  assert.equal(r.size, out.length);
  assert.ok(Math.abs(durationOf(out) - 2034) < 1e-6);
});

test('MemorySink leaves MP4 bytes untouched', async () => {
  const sink = new MemorySink();
  await sink.open({ filename: 'a.mp4', container: 'mp4', mimeType: '' });
  await sink.write(new Blob([new Uint8Array([1, 2, 3])]));
  const r = await sink.finalize({ durationMs: 5000 });
  assert.equal(r.blob.type, 'video/mp4');
  assert.deepEqual([...new Uint8Array(await r.blob.arrayBuffer())], [1, 2, 3]);
});

// ------------------------------------------------------------ FolderSink

test('FolderSink buffers a 1-byte first chunk, then writes the Duration in place at finalize', async () => {
  const store = await readyStore();
  const bytes = await fixture('vp9-opus-2s.webm');
  const sink = new FolderSink(store);
  assert.equal(sink.kind, 'folder');
  await sink.open({ filename: 'Lesson.webm', container: 'webm' });
  assert.equal(sink.filename, 'Lesson.webm');
  for (const b of chunk(bytes)) await sink.write(b);
  assert.equal(sink.durationPatchable, true);
  // Nothing is committed until close (Chrome's .crswap behaviour).
  assert.equal(dir.bytes('Lesson.webm').length, 0);
  const r = await sink.finalize({ durationMs: 61_500 });
  assert.deepEqual({ savedTo: r.savedTo, filename: r.filename, folderName: r.folderName }, { savedTo: 'folder', filename: 'Lesson.webm', folderName: 'Lessons' });
  const out = dir.bytes('Lesson.webm');
  assert.equal(r.size, out.length);
  assert.equal(out.length, bytes.length + 11);
  assert.ok(Math.abs(durationOf(out) - 61_500) < 1e-6);
  // The duration went in with a positioned write, not by rewriting the file.
  const positioned = dir.writes.filter(w => w.position !== null);
  assert.equal(positioned.length, 1);
  assert.equal(positioned[0].size, 8);
  // Media after the header is byte-identical.
  const infoEnd = locateInfo(bytes).info.dataEnd;
  assert.deepEqual(out.subarray(infoEnd + 11), bytes.subarray(infoEnd));
});

test('FolderSink never overwrites: a second take with the same name gets " (2)"', async () => {
  const store = await readyStore();
  const a = new FolderSink(store);
  await a.open({ filename: 'Lesson.mp4', container: 'mp4' });
  const b = new FolderSink(store);
  await b.open({ filename: 'Lesson.mp4', container: 'mp4' });
  assert.equal(b.filename, 'Lesson (2).mp4');
  await a.write(new Blob(['aaa']));
  await b.write(new Blob(['bbbb']));
  await a.finalize({ durationMs: 1 });
  const rb = await b.finalize({ durationMs: 1 });
  assert.equal(rb.filename, 'Lesson (2).mp4');
  assert.equal(new TextDecoder().decode(dir.bytes('Lesson.mp4')), 'aaa');
  assert.equal(new TextDecoder().decode(dir.bytes('Lesson (2).mp4')), 'bbbb');
});

test('FolderSink gives up on a header it cannot parse after 2 MB and writes the data unpatched', async () => {
  const store = await readyStore();
  const sink = new FolderSink(store);
  await sink.open({ filename: 'x.webm', container: 'webm' });
  // A valid EBML start whose Info claims 256 MB, so it never completes.
  const head = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x84, 0x42, 0x86, 0x81, 0x01, 0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x15, 0x49, 0xa9, 0x66, 0x01, 0x00, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00]);
  await sink.write(new Blob([head]));
  const big = new Uint8Array(512 * 1024).fill(7);
  let n = head.length;
  while (n < HEADER_LIMIT_BYTES) { await sink.write(new Blob([big])); n += big.length; }
  assert.equal(sink.durationPatchable, false);
  await sink.write(new Blob([new Uint8Array([9, 9])]));
  const r = await sink.finalize({ durationMs: 1000 });
  assert.equal(r.size, n + 2);
  assert.deepEqual([...dir.bytes('x.webm').subarray(0, head.length)], [...head]);
});

test('FolderSink finalize flushes a header that never completed', async () => {
  const store = await readyStore();
  const sink = new FolderSink(store);
  await sink.open({ filename: 'short.webm', container: 'webm' });
  await sink.write(new Blob([new Uint8Array([0x1a])]));
  const r = await sink.finalize({ durationMs: 10 });
  assert.equal(r.size, 1);
  assert.deepEqual([...dir.bytes('short.webm')], [0x1a]);
});

test('FolderSink abort removes the partial file; write errors reach the caller', async () => {
  const store = await readyStore();
  const sink = new FolderSink(store);
  await sink.open({ filename: 'gone.mp4', container: 'mp4' });
  await sink.write(new Blob(['abc']));
  dir.failAfterBytes = dir.bytesWritten + 2;
  await assert.rejects(sink.write(new Blob(['defg'])), e => e.name === 'QuotaExceededError');
  await sink.abort();
  assert.deepEqual(dir.fileNames(), []);
  await sink.abort(); // twice is fine
});

// ------------------------------------------------------------ FolderStore

test('FolderStore: unsupported without showDirectoryPicker; none -> ready after choose()', async () => {
  const unsupported = new FolderStore();
  assert.equal(FolderStore.isSupported(), false);
  assert.equal(unsupported.status, 'unsupported');
  assert.equal(await unsupported.init(), 'unsupported');

  dir = createFakeDirectory({ name: 'Lessons' });
  globalThis.showDirectoryPicker = async opts => { assert.equal(opts.mode, 'readwrite'); return dir; };
  const store = new FolderStore();
  const statuses = [];
  store.on('status', s => statuses.push(s));
  assert.equal(await store.init(), 'none', 'nothing remembered (no IndexedDB in node)');
  await store.choose();
  assert.equal(store.status, 'ready');
  assert.equal(store.name, 'Lessons');
  assert.ok(statuses.some(s => s.status === 'ready' && s.name === 'Lessons'));
  await store.forget();
  assert.equal(store.status, 'none');
  assert.equal(store.name, '');
});

test('FolderStore asks for permission when needed and reports needs-permission', async () => {
  dir = createFakeDirectory({ permission: 'prompt', grantOnRequest: false });
  globalThis.showDirectoryPicker = async () => dir;
  const store = new FolderStore();
  await store.choose();
  assert.equal(store.status, 'needs-permission');
  await assert.rejects(store.createFile('a.mp4'), /no longer allowed/);
  dir.grantOnRequest = true;
  assert.equal(await store.reconnect(), true);
  assert.equal(store.status, 'ready');
  // Permission revoked behind our back: refresh() notices.
  dir.permission = 'prompt';
  assert.equal(await store.refresh(), 'needs-permission');
});

test('FolderStore createFile / writeText / getFile / remove', async () => {
  const store = await readyStore();
  dir.seed('Lesson.mp4');
  dir.seed('lesson (2).MP4');
  const { writable, name } = await store.createFile('Lesson.mp4');
  assert.equal(name, 'Lesson (3).mp4', 'names compare case-insensitively, like Windows');
  await writable.write(new Blob(['video']));
  await writable.close();
  assert.equal(await (await store.getFile(name)).text(), 'video');
  assert.equal(await store.getFile('missing.mp4'), null);

  assert.equal(await store.writeText('Lesson.chapters.txt', 'one'), 'Lesson.chapters.txt');
  await store.writeText('Lesson.chapters.txt', '0:00 Intro');
  assert.equal(await (await store.getFile('Lesson.chapters.txt')).text(), '0:00 Intro', 'sidecars are replaced, not duplicated');

  await store.remove(name);
  await store.remove(name); // already gone: fine
  assert.equal(await store.getFile(name), null);
});

test('FolderStore rename uses move() and keeps names unique', async () => {
  const store = await readyStore();
  dir.seed('a.mp4', 'A');
  dir.seed('b.mp4', 'B');
  assert.equal(await store.rename('a.mp4', 'b.mp4'), 'b (2).mp4');
  assert.deepEqual(dir.fileNames().sort(), ['b (2).mp4', 'b.mp4']);
  assert.equal(await (await store.getFile('b (2).mp4')).text(), 'A');
  assert.equal(await store.rename('b (2).mp4', 'b (2).mp4'), 'b (2).mp4');
  // Only the letter case changes: the same file, not a collision.
  assert.equal(await store.rename('b (2).mp4', 'B (2).mp4'), 'B (2).mp4');
});

test('FolderStore rename falls back to copy + remove when move() is unavailable', async () => {
  const store = await readyStore({ supportsMove: false });
  dir.seed('Week 3.webm', 'payload');
  const final = await store.rename('Week 3.webm', 'Fractions – Week 3.webm');
  assert.equal(final, 'Fractions – Week 3.webm');
  assert.deepEqual(dir.fileNames(), ['Fractions – Week 3.webm']);
  assert.equal(await (await store.getFile(final)).text(), 'payload');
  await assert.rejects(store.rename('nope.webm', 'x.webm'), /can’t be found/);
});

// ------------------------------------------------------------ TakesLibrary

test('TakesLibrary keeps takes in memory without IndexedDB: CRUD, newest first, change events', async () => {
  const lib = await TakesLibrary.open();
  assert.equal(lib.persistent, false);
  const changes = [];
  lib.on('change', rows => changes.push(rows.map(r => r.id)));
  await lib.add({ id: 'old', lessonName: 'A', createdAt: 1000, markers: [{ id: 'm', atMs: 5, title: 'X' }] });
  await lib.add({ id: 'new', lessonName: 'B', createdAt: 2000 });
  assert.deepEqual((await lib.list()).map(t => t.id), ['new', 'old']);
  assert.deepEqual(changes, [['old'], ['new', 'old']]);

  const updated = await lib.update('old', { lessonName: 'A2', markers: [] });
  assert.equal(updated.lessonName, 'A2');
  assert.equal((await lib.get('old')).lessonName, 'A2');
  assert.equal(await lib.update('missing', { lessonName: 'x' }), null);

  // Returned rows are copies: mutating them doesn't change the library.
  const rows = await lib.list();
  rows[0].lessonName = 'mutated';
  assert.equal((await lib.get('new')).lessonName, 'B');

  await lib.remove('new');
  assert.deepEqual((await lib.list()).map(t => t.id), ['old']);
  assert.deepEqual(changes.at(-1), ['old']);
  await assert.rejects(lib.add({ lessonName: 'no id' }), /needs an id/);
});
