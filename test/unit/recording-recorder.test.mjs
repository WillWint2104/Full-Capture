// TakeRecorder orchestration in node with a scripted MediaRecorder, an
// in-memory journal and the fake folder: chunk order, fallbacks when the
// folder or the journal fails, pause/stop clock, markers, graceful ends,
// idempotent stop/cancel, locks.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { TakeRecorder } from '../../src/app/recording/recorder.js';
import { MemorySink, FolderSink } from '../../src/app/recording/sinks.js';
import { FolderStore } from '../../src/app/recording/folder.js';
import { locateInfo } from '../../src/app/media/webm.js';
import { createFakeDirectory } from '../e2e/harness/recording-fakefs.entry.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const fixture = name => readFile(new URL(`../fixtures/${name}`, import.meta.url)).then(b => new Uint8Array(b));
const text = async blob => new TextDecoder().decode(new Uint8Array(await blob.arrayBuffer()));
const durationOf = bytes => {
  const l = locateInfo(bytes);
  if (!l.duration) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset + l.duration.offset, l.duration.size);
  return (l.duration.size === 8 ? dv.getFloat64(0) : dv.getFloat32(0)) * l.timecodeScale / 1e6;
};

// ------------------------------------------------------------ fakes

class FakeMediaRecorder extends EventTarget {
  static last = null;
  static failConstruct = 0;
  constructor(stream, options = {}) {
    super();
    if (FakeMediaRecorder.failConstruct > 0) {
      FakeMediaRecorder.failConstruct--;
      throw Object.assign(new Error('bad option'), { name: 'NotSupportedError' });
    }
    this.stream = stream;
    this.options = options;
    this.state = 'inactive';
    this.mimeType = options.mimeType || '';
    this.calls = [];
    this.finalChunk = null;
    FakeMediaRecorder.last = this;
  }
  start(timeslice) {
    this.calls.push(['start', timeslice]);
    this.state = 'recording';
    this.mimeType = this.options.mimeType ? `${this.options.mimeType}` : 'video/webm;codecs=vp8,opus';
  }
  pause() { this.calls.push(['pause']); this.state = 'paused'; }
  resume() { this.calls.push(['resume']); this.state = 'recording'; }
  requestData() { this.calls.push(['requestData']); }
  stop() {
    this.calls.push(['stop']);
    this.state = 'inactive';
    setTimeout(() => {
      if (this.finalChunk) this.data(this.finalChunk);
      this.dispatchEvent(new Event('stop'));
    }, 5);
  }
  data(bytes) {
    const e = new Event('dataavailable');
    e.data = bytes instanceof Blob ? bytes : new Blob([bytes]);
    this.dispatchEvent(e);
  }
  fail(message = 'encoder died') {
    const e = new Event('error');
    e.error = Object.assign(new Error(message), { name: 'UnknownError' });
    this.dispatchEvent(e);
    this.state = 'inactive';
    setTimeout(() => this.dispatchEvent(new Event('stop')), 5);
  }
}

class FakeTrack extends EventTarget {
  constructor(kind) { super(); this.kind = kind; this.readyState = 'live'; }
  end() { this.readyState = 'ended'; this.dispatchEvent(new Event('ended')); }
}

class MemJournal {
  metas = new Map();
  rows = new Map();     // id -> Map(seq -> blob)
  log = [];
  failAppendFrom = Infinity;
  appendDelayMs = 0;
  #appends = 0;
  async begin(meta) { this.log.push(['begin', meta.id]); this.metas.set(meta.id, { ...meta, status: 'recording' }); this.rows.set(meta.id, new Map()); }
  async append(id, seq, blob) {
    if (this.appendDelayMs) await sleep(this.appendDelayMs);
    if (this.#appends++ >= this.failAppendFrom) throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
    this.log.push(['append', seq]);
    this.rows.get(id).set(seq, blob);
  }
  async update(id, patch) { this.log.push(['update', patch]); const m = this.metas.get(id); if (m) Object.assign(m, patch); }
  async complete(id, { keep = false } = {}) {
    this.log.push(['complete', id, keep]);
    if (!keep) return this.discard(id);
    this.metas.get(id).status = 'downloaded';
  }
  async prune({ exceptId } = {}) {
    this.log.push(['prune', exceptId]);
    for (const [id, m] of this.metas) if (m.status === 'downloaded' && id !== exceptId) await this.discard(id);
  }
  async chunks(id) { return [...(this.rows.get(id) || new Map())].map(([seq, blob]) => ({ seq, blob })).sort((a, b) => a.seq - b.seq); }
  async discard(id) { this.log.push(['discard', id]); this.metas.delete(id); this.rows.delete(id); }
}

/** Fake Web Locks: exclusive, with ifAvailable. */
function fakeLocks() {
  const held = new Map();
  return {
    held,
    async request(name, opts, cb) {
      if (typeof opts === 'function') { cb = opts; opts = {}; }
      if (held.has(name)) {
        if (opts.ifAvailable) return cb(null);
        await held.get(name);
      }
      let release;
      held.set(name, new Promise(r => { release = r; }));
      try { return await cb({ name }); } finally { held.delete(name); release(); }
    },
  };
}

function clock() {
  let t = 0;
  return { now: () => t, advance: ms => { t += ms; } };
}

const OPTS = { mimeType: 'video/webm;codecs=vp8,opus', container: 'webm', ext: 'webm', videoBitsPerSecond: 2_000_000, audioBitsPerSecond: 128_000, videoKeyFrameIntervalDuration: 2000 };
const MP4 = { ...OPTS, mimeType: 'video/mp4;codecs=avc1,mp4a.40.2', container: 'mp4', ext: 'mp4' };

let dir;
async function folderStore(opts) {
  dir = createFakeDirectory(opts);
  globalThis.showDirectoryPicker = async () => dir;
  const s = new FolderStore();
  await s.choose();
  return s;
}

function make({ sink = new MemorySink(), journal = new MemJournal(), options = MP4, c = clock(), ...rest } = {}) {
  const video = new FakeTrack('video');
  const audio = new FakeTrack('audio');
  const rec = new TakeRecorder({
    id: rest.id || 'take-1', videoTrack: video, audioTrack: audio, options, sink, journal,
    meta: { lessonName: 'Fractions', filename: `Fractions.${options.ext}`, startedAt: 1234 }, now: c.now, ...rest,
  });
  const events = [];
  for (const type of ['state', 'tick', 'warning', 'error']) rec.on(type, d => events.push([type, d]));
  return { rec, video, audio, journal, sink, c, events, mr: () => FakeMediaRecorder.last };
}

let savedLocks;
beforeEach(() => {
  globalThis.MediaRecorder = FakeMediaRecorder;
  globalThis.MediaStream = class { constructor(tracks) { this.tracks = tracks; } getTracks() { return this.tracks; } };
  FakeMediaRecorder.failConstruct = 0;
  savedLocks = Object.getOwnPropertyDescriptor(globalThis.navigator, 'locks');
});
afterEach(() => {
  delete globalThis.showDirectoryPicker;
  if (savedLocks) Object.defineProperty(globalThis.navigator, 'locks', savedLocks);
  else delete globalThis.navigator.locks;
});

// ------------------------------------------------------------ tests

test('start() passes the recorder options (incl. keyframe interval) and a 1 s timeslice', async () => {
  const { rec, mr, journal, events } = make();
  await rec.start();
  assert.equal(rec.state, 'recording');
  assert.deepEqual(mr().calls[0], ['start', 1000]);
  assert.equal(mr().options.videoKeyFrameIntervalDuration, 2000);
  assert.equal(mr().options.mimeType, MP4.mimeType);
  assert.equal(mr().options.videoBitsPerSecond, 2_000_000);
  assert.equal(mr().stream.tracks.length, 2);
  assert.equal(rec.mimeType, MP4.mimeType);
  assert.deepEqual(journal.log[0], ['begin', 'take-1']);
  assert.equal(journal.metas.get('take-1').container, 'mp4');
  assert.ok(events.some(([t, d]) => t === 'state' && d.state === 'recording'));
  await rec.cancel();
});

test('if the full options are refused, recording starts with just the type', async () => {
  FakeMediaRecorder.failConstruct = 1;
  const { rec, mr } = make();
  await rec.start();
  assert.deepEqual(mr().options, { mimeType: MP4.mimeType });
  await rec.cancel();
});

test('chunks are journaled first and reach the sink in order, even when the disk is slow', async () => {
  const store = await folderStore();
  const sink = new FolderSink(store);
  const slowWrite = sink.write.bind(sink);
  const order = [];
  sink.write = async blob => { await sleep(15); order.push(await text(blob)); return slowWrite(blob); };
  const journal = new MemJournal();
  journal.appendDelayMs = 3;
  const { rec, mr, c } = make({ sink, journal });
  await rec.start();
  for (let i = 0; i < 6; i++) { c.advance(1000); mr().data(`<${i}>`); }
  mr().finalChunk = '<end>';
  const result = await rec.stop();
  assert.deepEqual(order, ['<0>', '<1>', '<2>', '<3>', '<4>', '<5>', '<end>']);
  assert.deepEqual(journal.log.filter(l => l[0] === 'append').map(l => l[1]), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(result.savedTo, 'folder');
  assert.equal(result.filename, 'Fractions.mp4');
  assert.equal(result.folderName, 'Lessons');
  assert.equal(new TextDecoder().decode(dir.bytes('Fractions.mp4')), '<0><1><2><3><4><5><end>');
  assert.equal(result.size, '<0><1><2><3><4><5><end>'.length);
  assert.equal(result.durationMs, 6000);
  // Saved into the folder: the journal entry goes away, nothing is kept.
  assert.deepEqual(journal.log.at(-1), ['discard', 'take-1']);
  assert.ok(journal.log.some(l => l[0] === 'complete' && l[2] === false));
  assert.equal(rec.state, 'stopped');
});

test('a download keeps its journal copy (keep: true) and prunes older ones', async () => {
  const journal = new MemJournal();
  journal.metas.set('older', { id: 'older', status: 'downloaded' });
  const { rec, mr, c } = make({ journal });
  await rec.start();
  c.advance(2500);
  mr().data('abc');
  const r = await rec.stop();
  assert.equal(r.savedTo, 'memory');
  assert.equal(await text(r.blob), 'abc');
  assert.equal(r.blob.type, MP4.mimeType);
  assert.deepEqual(journal.log.filter(l => l[0] === 'complete'), [['complete', 'take-1', true]]);
  assert.deepEqual(journal.log.filter(l => l[0] === 'prune'), [['prune', 'take-1']]);
  assert.equal(journal.metas.get('take-1').status, 'downloaded');
  assert.equal(journal.metas.get('take-1').elapsedMs, 2500, 'final progress written before completing');
  assert.equal(journal.metas.has('older'), false);
  assert.equal(r.warning, '');
  assert.equal(r.endedBy, null);
  assert.equal(r.startedAt, 1234);
});

test('WebM in memory gets a Duration equal to the recorded time', async () => {
  const bytes = await fixture('vp8-opus-1s.webm');
  const { rec, mr, c } = make({ options: OPTS });
  await rec.start();
  mr().data(bytes.subarray(0, 1));
  mr().data(bytes.subarray(1, 30_000));
  c.advance(1500);
  mr().finalChunk = bytes.subarray(30_000);
  const r = await rec.stop();
  assert.equal(r.container, 'webm');
  assert.equal(r.durationMs, 1500);
  assert.ok(Math.abs(durationOf(new Uint8Array(await r.blob.arrayBuffer())) - 1500) < 1e-6);
});

test('the folder failing mid-take still saves the take, from the journal, as a download', async () => {
  const store = await folderStore();
  const journal = new MemJournal();
  const { rec, mr, events, c } = make({ sink: new FolderSink(store), journal });
  await rec.start();
  assert.equal(rec.savingTo, 'folder');
  mr().data('one-');
  mr().data('two-');
  await sleep(10);
  dir.failAfterBytes = dir.bytesWritten + 2; // disk full
  mr().data('three-');
  await sleep(10);
  const err = events.find(([t]) => t === 'error')?.[1];
  assert.ok(err, 'error event emitted');
  assert.equal(err.fatal, false);
  assert.equal(err.code, 'folder-failed');
  assert.match(err.message, /disk .* is full.*Keep recording/s);
  assert.equal(rec.savingTo, 'memory');
  assert.equal(rec.state, 'recording', 'the take carries on');
  mr().data('four');
  c.advance(4000);
  const r = await rec.stop();
  assert.equal(r.savedTo, 'memory');
  assert.equal(await text(r.blob), 'one-two-three-four');
  assert.match(r.warning, /Downloads folder/);
  assert.ok(events.some(([t, d]) => t === 'warning' && /Downloads/.test(d.message)));
  assert.deepEqual(dir.fileNames(), [], 'the partial file is removed');
  assert.deepEqual(journal.log.filter(l => l[0] === 'complete'), [['complete', 'take-1', true]]);
});

test('without a journal, a folder take keeps its own copy so a failing folder loses nothing', async () => {
  const store = await folderStore();
  const { rec, mr, events } = make({ sink: new FolderSink(store), journal: null });
  await rec.start();
  await sleep(5);
  assert.ok(events.some(([t, d]) => t === 'warning' && d.code === 'no-journal'), 'early warning delivered after start()');
  mr().data('aa');
  await sleep(5);
  dir.permission = 'denied'; // permission revoked
  mr().data('bb');
  mr().finalChunk = 'cc';
  const r = await rec.stop();
  assert.equal(r.savedTo, 'memory');
  assert.equal(await text(r.blob), 'aabbcc');
});

test('the folder failing at finalize still saves the take, and says why', async () => {
  const store = await folderStore();
  const sink = new FolderSink(store);
  sink.finalize = async () => { throw Object.assign(new Error('close failed'), { name: 'InvalidStateError' }); };
  const { rec, mr, events } = make({ sink });
  await rec.start();
  mr().data('xyz');
  const r = await rec.stop();
  assert.equal(r.savedTo, 'memory');
  assert.equal(await text(r.blob), 'xyz');
  assert.match(r.warning, /Another program is using a file in your “Lessons” folder.*Downloads folder instead/);
  // Not "keep recording": the take is already over.
  assert.equal(events.some(([t]) => t === 'error'), false);
  assert.deepEqual(dir.fileNames(), []);
});

test('the journal failing mid-take: crash protection warning, folder still saves, no incomplete safety copy is kept', async () => {
  const store = await folderStore();
  const journal = new MemJournal();
  journal.failAppendFrom = 1;
  const { rec, mr, events } = make({ sink: new FolderSink(store), journal });
  await rec.start();
  mr().data('a');
  mr().data('b');
  mr().data('c');
  const r = await rec.stop();
  assert.ok(events.some(([t, d]) => t === 'warning' && d.code === 'journal-failed' && /storage is full/.test(d.message)));
  assert.equal(r.savedTo, 'folder');
  assert.equal(new TextDecoder().decode(dir.bytes('Fractions.mp4')), 'abc');
  assert.equal(rec.safetyCopy, false);
});

test('journal and folder both failing: the in-memory copy covers the rest', async () => {
  const store = await folderStore();
  const journal = new MemJournal();
  journal.failAppendFrom = 2;
  const { rec, mr } = make({ sink: new FolderSink(store), journal });
  await rec.start();
  mr().data('1');
  mr().data('2');
  mr().data('3');
  await sleep(10);
  dir.failAfterBytes = 0;
  mr().data('4');
  const r = await rec.stop();
  assert.equal(r.savedTo, 'memory');
  assert.equal(await text(r.blob), '1234');
  // The journal is incomplete, so it must not pose as a safety copy.
  assert.ok(journal.log.some(l => l[0] === 'complete' && l[2] === false));
});

test('journal failing with a memory sink: saved, and the partial journal copy is dropped', async () => {
  const journal = new MemJournal();
  journal.failAppendFrom = 0;
  const { rec, mr } = make({ journal });
  await rec.start();
  mr().data('m1');
  mr().data('m2');
  const r = await rec.stop();
  assert.equal(await text(r.blob), 'm1m2');
  assert.equal(journal.metas.size, 0);
});

test('pause excludes time; stopping while paused freezes the clock at the pause', async () => {
  const { rec, mr, c, journal } = make({ options: OPTS });
  await rec.start();
  c.advance(2000);
  mr().data('x');
  assert.equal(rec.pause(), true);
  assert.equal(rec.state, 'paused');
  assert.deepEqual(mr().calls.slice(-2), [['requestData'], ['pause']], 'WebM flushes before pausing');
  assert.ok(journal.log.some(l => l[0] === 'update' && l[1].elapsedMs === 2000), 'journal updated on pause');
  c.advance(5000);
  assert.equal(rec.elapsedMs, 2000);
  assert.equal(rec.pause(), false);
  assert.equal(rec.resume(), true);
  c.advance(1000);
  assert.equal(rec.elapsedMs, 3000);
  rec.pause();
  c.advance(9000);
  const r = await rec.stop();
  c.advance(9000);
  assert.equal(r.durationMs, 3000);
  assert.equal(rec.elapsedMs, 3000);
});

test('markers use recorded time, default to "Chapter n" and are journaled', async () => {
  const { rec, mr, c, journal } = make();
  assert.equal(rec.addMarker('too early'), null);
  await rec.start();
  c.advance(1200);
  const m1 = rec.addMarker();
  rec.pause();
  c.advance(60_000);
  const m2 = rec.addMarker('  Worked example  ');
  rec.resume();
  c.advance(800);
  const m3 = rec.addMarker('');
  assert.deepEqual([m1.atMs, m2.atMs, m3.atMs], [1200, 1200, 2000]);
  assert.deepEqual([m1.title, m2.title, m3.title], ['Chapter 1', 'Worked example', 'Chapter 3']);
  assert.ok(m1.id && m1.id !== m2.id);
  assert.deepEqual(journal.metas.get('take-1').markers.map(m => m.title), ['Chapter 1', 'Worked example', 'Chapter 3']);
  mr().data('d');
  const r = await rec.stop();
  assert.equal(r.markers.length, 3);
  assert.equal(rec.addMarker('late'), null);
  // The copy handed out can't change the recorder's list.
  r.markers.pop();
  assert.equal(rec.markers.length, 3);
});

test('stop() and cancel() are idempotent and share one promise', async () => {
  const { rec, mr } = make();
  await rec.start();
  mr().data('q');
  const p1 = rec.stop();
  const p2 = rec.stop();
  const p3 = rec.cancel();
  assert.equal(p1, p2);
  assert.equal(p1, p3);
  const r = await p1;
  assert.equal(r.size, 1);
  assert.equal(await rec.stop(), r);
});

test('cancel() discards the file, the journal entry and late data', async () => {
  const store = await folderStore();
  const journal = new MemJournal();
  const { rec, mr } = make({ sink: new FolderSink(store), journal });
  await rec.start();
  mr().data('keep?');
  mr().finalChunk = 'late';
  const p = rec.cancel();
  assert.equal(rec.cancel(), p);
  assert.equal(await p, null);
  assert.equal(rec.state, 'stopped');
  assert.deepEqual(dir.fileNames(), []);
  assert.equal(journal.metas.size, 0);
  assert.equal(journal.rows.size, 0);
  assert.equal(await rec.stop(), null);
});

test('screen sharing ending stops the take gracefully and keeps the data', async () => {
  const { rec, mr, video, events, c } = make();
  await rec.start();
  c.advance(83_000);
  mr().data('lesson');
  video.end();
  const err = events.find(([t]) => t === 'error')[1];
  assert.equal(err.fatal, true);
  assert.equal(err.code, 'share-ended');
  assert.match(err.message, /Screen sharing ended.*1:23/);
  const r = await rec.stop(); // what the session does on a fatal error: same promise
  assert.equal(r.endedBy, 'share-ended');
  assert.equal(await text(r.blob), 'lesson');
  assert.equal(r.durationMs, 83_000);
});

test('repeated end events report once, and data arriving after the stop is ignored', async () => {
  const { rec, mr, video, events } = make();
  await rec.start();
  mr().data('a');
  video.end();
  video.dispatchEvent(new Event('ended'));
  mr().fail();
  const r = await rec.stop();
  assert.equal(events.filter(([t]) => t === 'error').length, 1);
  mr().data('late');
  await new Promise(res => setTimeout(res, 10));
  assert.equal(await text(r.blob), 'a');
  assert.equal(rec.bytes, 1);
});

test('nobody awaiting an event-driven stop that fails does not leave an unhandled rejection', async () => {
  const unhandled = [];
  const onUnhandled = e => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    const { rec, video } = make();
    await rec.start();
    video.end(); // no data at all: the internal stop rejects with 'empty'
    await new Promise(res => setTimeout(res, 50));
    assert.equal(rec.state, 'failed');
    await assert.rejects(rec.stop(), e => e.code === 'empty');
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('a MediaRecorder error stops the take gracefully and keeps the data', async () => {
  const { rec, mr, events } = make();
  await rec.start();
  mr().data('before');
  mr().fail();
  const err = events.find(([t]) => t === 'error')[1];
  assert.equal(err.fatal, true);
  assert.equal(err.code, 'recorder-error');
  assert.match(err.message, /encoder died/);
  const r = await rec.stop();
  assert.equal(r.endedBy, 'error');
  assert.equal(await text(r.blob), 'before');
});

test('the first-chunk watchdog warns when no data arrives', async () => {
  const { rec, events } = make({ firstChunkTimeoutMs: 20 });
  await rec.start();
  await sleep(60);
  assert.ok(events.some(([t, d]) => t === 'warning' && d.code === 'no-data' && /Crash protection isn’t working/.test(d.message)));
  await rec.cancel();
});

test('no watchdog warning when data arrives in time', async () => {
  const { rec, mr, events } = make({ firstChunkTimeoutMs: 30 });
  await rec.start();
  mr().data('ok');
  await sleep(60);
  assert.equal(events.some(([t, d]) => t === 'warning' && d.code === 'no-data'), false);
  await rec.cancel();
});

test('ticks report elapsed time and bytes', async () => {
  const { rec, mr, c, events } = make();
  await rec.start();
  c.advance(700);
  mr().data('12345');
  const tick = events.filter(([t]) => t === 'tick').at(-1)[1];
  assert.deepEqual(tick, { elapsedMs: 700, bytes: 5 });
  assert.equal(rec.bytes, 5);
  await rec.cancel();
});

test('a failed start cleans up so the same id can be retried with another sink', async () => {
  const store = await folderStore();
  const journal = new MemJournal();
  dir.permission = 'denied';
  store.refresh();
  await sleep(1);
  const first = make({ sink: new FolderSink(store), journal });
  // code 'sink': the folder was the problem, so retrying with a MemorySink makes sense.
  await assert.rejects(first.rec.start(), e => /no longer allowed/.test(e.message) && e.code === 'sink');
  assert.equal(first.rec.state, 'failed');
  assert.equal(journal.metas.size, 0, 'journal entry removed');
  assert.equal(await first.rec.stop(), null);
  const second = make({ journal });
  await second.rec.start();
  second.mr().data('ok');
  const r = await second.rec.stop();
  assert.equal(await text(r.blob), 'ok');
});

test('start() refuses an ended screen track with a plain message', async () => {
  const { rec, video } = make();
  video.readyState = 'ended';
  await assert.rejects(rec.start(), e => /shared screen has gone/.test(e.message) && e.code === 'screen-gone');
});

test('sharing that ends while start() is still setting up fails the start cleanly (no picture-less take)', async () => {
  const store = await folderStore();
  const sink = new FolderSink(store);
  const journal = new MemJournal();
  const { rec, video, mr } = make({ sink, journal });
  // "Stop sharing" clicked while the file is being created: 'ended' fires before
  // the recorder is listening for it.
  const open = sink.open.bind(sink);
  sink.open = async o => { await open(o); video.end(); };
  await assert.rejects(rec.start(), e => /shared screen has gone/.test(e.message) && e.code === 'screen-gone');
  assert.equal(rec.state, 'failed');
  assert.equal(mr().state, 'inactive', 'MediaRecorder never started');
  assert.equal(mr().calls.some(c => c[0] === 'start'), false);
  assert.deepEqual(dir.fileNames(), [], 'the new file is removed');
  assert.equal(journal.metas.size, 0, 'the journal entry is removed');
});

test('stop() or cancel() before start() ends the take for good: a later start() is refused', async () => {
  for (const end of ['stop', 'cancel']) {
    FakeMediaRecorder.last = null;
    const { rec, journal } = make();
    assert.equal(await rec[end](), null);
    await assert.rejects(rec.start(), /already ended/);
    assert.equal(FakeMediaRecorder.last, null, `${end}: no MediaRecorder was created`);
    assert.notEqual(rec.state, 'recording');
    assert.equal(journal.metas.size, 0);
    assert.equal(await rec.stop(), null);
  }
});

test('the folder failing after Stop was pressed: no "keep recording" error, the saved take explains', async () => {
  const store = await folderStore();
  const { rec, mr, events } = make({ sink: new FolderSink(store) });
  await rec.start();
  mr().data('one-');
  await sleep(5);
  dir.failAfterBytes = dir.bytesWritten; // the final chunk can't be written
  mr().finalChunk = 'last';
  const r = await rec.stop();
  assert.equal(events.some(([t]) => t === 'error'), false, 'no live folder-failed error once stopping');
  assert.equal(r.savedTo, 'memory');
  assert.equal(await text(r.blob), 'one-last');
  assert.match(r.warning, /disk .* is full.*Downloads folder instead/s);
  assert.deepEqual(dir.fileNames(), []);
});

test('when nothing can be rebuilt, stop() rejects, keeps the journal entry, releases the lock and leaves no empty file', async () => {
  const locks = fakeLocks();
  Object.defineProperty(globalThis.navigator, 'locks', { value: locks, configurable: true });
  const store = await folderStore();
  const journal = new MemJournal();
  journal.chunks = async () => { throw new Error('IndexedDB read failed'); };
  const { rec, mr } = make({ sink: new FolderSink(store), journal });
  await rec.start();
  mr().data('aa');
  await sleep(5);
  dir.failAfterBytes = dir.bytesWritten; // the folder fails mid-take
  mr().data('bb');
  await sleep(5);
  await assert.rejects(rec.stop(), /couldn’t be saved.*Reload the page/);
  assert.equal(rec.state, 'failed');
  assert.ok(journal.metas.has('take-1'), 'kept, so a reload offers it for recovery');
  assert.equal(journal.metas.get('take-1').status, 'recording');
  assert.deepEqual(dir.fileNames(), [], 'no empty file left in the folder');
  assert.equal(locks.held.has('full-capture-take:take-1'), false);
});

test('a take with no data at all reports it instead of saving an empty file', async () => {
  const journal = new MemJournal();
  const { rec } = make({ journal });
  await rec.start();
  await assert.rejects(rec.stop(), e => e.code === 'empty' && /Nothing was recorded/.test(e.message));
  assert.equal(journal.metas.size, 0);
  assert.equal(rec.state, 'failed');
});

test('the take holds its Web Lock while recording and releases it afterwards', async () => {
  const locks = fakeLocks();
  Object.defineProperty(globalThis.navigator, 'locks', { value: locks, configurable: true });
  const { rec, mr } = make();
  await rec.start();
  assert.ok(locks.held.has('full-capture-take:take-1'));
  const free = await locks.request('full-capture-take:take-1', { ifAvailable: true }, l => !!l);
  assert.equal(free, false);
  mr().data('z');
  await rec.stop();
  assert.equal(locks.held.has('full-capture-take:take-1'), false);
});
