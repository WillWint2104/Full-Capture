// MP4 finalisation (src/app/media/mp4.js). Chrome's and Edge's MediaRecorder
// write fragmented MP4 with no duration and no seek index; these tests check
// the finalised file with tools that share no code with the app: ffprobe and
// ffmpeg (every packet's time, size and keyframe flag), GStreamer (what a
// player sees: length, seekability, where seeks land) and a small box reader.
//
// Fixtures (test/fixtures/): two seconds, a one-second pause, two seconds,
// recorded with MediaRecorder at 320x180 with 1 s keyframes:
//   mediarecorder-h264-opus.mp4  Microsoft Edge 155 (Linux), H.264 + Opus
//   mediarecorder-vp9-opus.mp4   Chromium 141, VP9 + Opus
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { Mp4Indexer, finalizeMp4Blob, applyPlanToBlob, mdatHeader, parseMoov, buildMoov } from '../../src/app/media/mp4.js';
import { MemorySink, FolderSink } from '../../src/app/recording/sinks.js';
import { FolderStore } from '../../src/app/recording/folder.js';
import { buildRecording } from '../../src/app/recording/journal.js';
import { createFakeDirectory } from '../e2e/harness/recording-fakefs.entry.js';
import {
  hasFfmpeg, gstPython, ffprobePackets, ffprobeInfo, decodeErrors, gstProbe,
  boxes, child, durationOf, timescaleOf, chunkOffsets, sampleCount,
} from '../tools/media.mjs';

const FIXTURES = ['mediarecorder-h264-opus.mp4', 'mediarecorder-vp9-opus.mp4'];
const fixture = name => readFile(new URL(`../fixtures/${name}`, import.meta.url)).then(b => new Uint8Array(b));
// Locally the tools may be missing; in CI they are installed and these checks must run.
const needFfmpeg = { skip: !hasFfmpeg && !process.env.CI && 'ffmpeg/ffprobe not installed' };
const needGst = { skip: !gstPython && !process.env.CI && 'GStreamer Python bindings not installed' };

let tmp;
before(async () => { tmp = await mkdtemp(path.join(os.tmpdir(), 'fc-mp4-')); });
let fileNo = 0;
const saveTmp = async (bytes, name = 'take') => {
  const file = path.join(tmp, `${name}-${fileNo++}.mp4`);
  await writeFile(file, bytes);
  return file;
};
const bytesOf = async blob => new Uint8Array(await blob.arrayBuffer());
const finalize = async (bytes, opts) => {
  const r = await finalizeMp4Blob(new Blob([bytes], { type: 'video/mp4' }), opts);
  return { ...r, bytes: await bytesOf(r.blob) };
};
const top = bytes => boxes(bytes).map(b => b.type);
/** Packets as "stream,pts,dts,size,keyframe" (the discard flag is left out: see the edit-list test). */
const packets = file => ffprobePackets(file).map(l => l.replace(/,([K_])[D_][_C]?,?$/, ',$1'));
/** Split bytes into pieces of the given sizes (cycled). */
const pieces = (bytes, sizes) => {
  const out = [];
  for (let p = 0, i = 0; p < bytes.length; i++) { const n = sizes[i % sizes.length]; out.push(new Blob([bytes.subarray(p, p + n)])); p += n; }
  return out;
};

// ------------------------------------------------------------ the defect

test('the defect: MediaRecorder MP4 is fragmented, with no duration and no seek index', async () => {
  for (const name of FIXTURES) {
    const bytes = await fixture(name);
    const t = top(bytes);
    assert.deepEqual(t.slice(0, 3), ['ftyp', 'moov', 'moof'], name);
    assert.ok(!t.includes('sidx') && !t.includes('mfra'), `${name}: no index`);
    const moov = boxes(bytes).find(b => b.type === 'moov');
    assert.ok(child(moov, 'mvex'), `${name}: fragmented`);
    assert.equal(durationOf(bytes, child(moov, 'mvhd')), 0, `${name}: no duration`);
  }
});

test('the defect, as a player sees it: GStreamer reports a fraction of the real length', needGst, async () => {
  for (const name of FIXTURES) {
    const file = await saveTmp(await fixture(name), 'raw');
    const real = hasFfmpeg ? ffprobeInfo(file).duration : 4;
    const seen = gstProbe(file).duration;
    assert.ok(seen < real * 0.6, `${name}: GStreamer says ${seen}s for ${real}s`);
  }
});

// ------------------------------------------------------------ the fix

test('finalised: ftyp | mdat | moov, the real duration, and only 8 header bytes changed', async () => {
  for (const name of FIXTURES) {
    const bytes = await fixture(name);
    const moovAt = boxes(bytes).find(b => b.type === 'moov').start;
    const r = await finalize(bytes);
    assert.equal(r.finalized, true, name);
    const out = r.bytes;
    const list = boxes(out);
    assert.deepEqual(list.map(b => b.type), ['ftyp', 'mdat', 'moov'], name);
    assert.equal(list[1].start, moovAt);
    assert.equal(list[1].start + list[1].size, bytes.length, `${name}: one mdat up to the new moov`);
    const moov = list[2];
    assert.equal(child(moov, 'mvex'), null);
    // Nothing but the 8-byte mdat header over the old moov's first bytes changed.
    assert.deepEqual(out.subarray(0, moovAt), bytes.subarray(0, moovAt));
    assert.deepEqual(out.subarray(moovAt + 8, bytes.length), bytes.subarray(moovAt + 8));
    // About 4 s were recorded (pause excluded).
    const ms = durationOf(out, child(moov, 'mvhd')) * 1000 / timescaleOf(out, child(moov, 'mvhd'));
    assert.ok(ms > 3800 && ms < 4200, `${name}: ${ms} ms`);
    assert.equal(r.durationMs, Math.round(ms));
    for (const trak of moov.children.filter(c => c.type === 'trak')) {
      const stbl = child(trak, 'mdia', 'minf', 'stbl');
      assert.ok(sampleCount(out, stbl) > 0);
      for (const off of chunkOffsets(out, stbl)) assert.ok(off > moovAt + 8 && off < bytes.length);
    }
  }
});

test('finalised: ffmpeg reads exactly the same packets (times, sizes, keyframes) and decodes them cleanly', needFfmpeg, async () => {
  for (const name of FIXTURES) {
    const bytes = await fixture(name);
    const before = await saveTmp(bytes, 'raw');
    const after = await saveTmp((await finalize(bytes)).bytes, 'fixed');
    const a = packets(before), b = packets(after);
    assert.ok(a.length > 100, `${name}: ${a.length} packets`);
    assert.deepEqual(b, a, name);
    assert.equal(decodeErrors(after), '', name);
    assert.ok(Math.abs(ffprobeInfo(after).duration - ffprobeInfo(before).duration) < 0.03);
  }
});

test('finalised: a player (GStreamer) sees the real length and seeks exactly, with a decoded frame', needGst, async () => {
  for (const name of FIXTURES) {
    const out = (await finalize(await fixture(name))).bytes;
    const file = await saveTmp(out, 'fixed');
    const g = gstProbe(file, [0.5, 1.7, 2.9, 3.6]);
    assert.ok(Math.abs(g.duration - 4) < 0.1, `${name}: duration ${g.duration}`);
    assert.equal(g.seekable, true);
    for (const s of g.seeks) {
      assert.equal(s.accepted, true);
      assert.ok(Math.abs(s.pts - s.target) < 0.05, `${name}: seek to ${s.target} landed at ${s.pts}`);
      assert.ok(s.bytes > 0, 'a decoded frame');
    }
  }
});

test('finalised: ffmpeg seeks to several points and decodes from each without errors', needFfmpeg, async () => {
  const file = await saveTmp((await finalize(await fixture('mediarecorder-h264-opus.mp4'))).bytes, 'fixed');
  for (const at of [0.4, 1.3, 2.2, 3.1, 3.7]) {
    assert.equal(decodeErrors(file, ['-ss', String(at)]), '', `from ${at}s`);
    const first = execFileSync('ffprobe', ['-v', 'error', '-read_intervals', `${at}%+0.3`, '-select_streams', 'v', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', file]).toString().trim().split('\n')[0];
    assert.ok(Number(first) <= at + 0.05 && Number(first) >= at - 1.05, `frame at ${first}s after seeking to ${at}s (keyframes every 1 s)`);
  }
});

test('any split of the bytes into pushes gives the same index', async () => {
  for (const name of FIXTURES) {
    const bytes = await fixture(name);
    const whole = new Mp4Indexer();
    await whole.push(new Blob([bytes]));
    const expected = whole.plan();
    // Byte by byte through the header and the first fragments, then MediaRecorder-like pieces.
    const byteByByte = [...Array(4000).fill(1), ...Array(400).fill(4093)];
    for (const sizes of [byteByByte, [5, 333, 7, 2017], [1, 40, 300, 5000], [16_384], [13, 1021, 8, 4093]]) {
      const ix = new Mp4Indexer();
      for (const p of pieces(bytes, sizes)) await ix.push(p);
      const plan = ix.plan();
      assert.equal(ix.error, null);
      assert.deepEqual([plan.headerAt, plan.moovAt], [expected.headerAt, expected.moovAt]);
      assert.deepEqual(plan.moov, expected.moov, `${name} split ${sizes.slice(0, 4)}…`);
      assert.deepEqual(plan.header, expected.header);
    }
  }
});

// ------------------------------------------------------------ the sinks

test('MemorySink indexes an MP4 as it is written', async () => {
  const bytes = await fixture('mediarecorder-h264-opus.mp4');
  const sink = new MemorySink();
  await sink.open({ filename: 'Lesson.mp4', container: 'mp4', mimeType: 'video/mp4;codecs=avc1,opus' });
  for (const b of pieces(bytes, [1200, 30_000])) await sink.write(b);
  const r = await sink.finalize({ durationMs: 4000 });
  assert.equal(r.blob.type, 'video/mp4;codecs=avc1,opus');
  assert.deepEqual(await bytesOf(r.blob), (await finalize(bytes)).bytes);
  assert.equal(r.size, r.blob.size);
});

async function folderSink(opts) {
  const dir = createFakeDirectory(opts);
  globalThis.showDirectoryPicker = async () => dir;
  const store = new FolderStore();
  await store.choose();
  delete globalThis.showDirectoryPicker;
  return { dir, sink: new FolderSink(store) };
}

test('FolderSink indexes an MP4 with two positioned writes: the index at the end, the mdat header in front', async () => {
  const bytes = await fixture('mediarecorder-vp9-opus.mp4');
  const { dir, sink } = await folderSink();
  await sink.open({ filename: 'Lesson.mp4', container: 'mp4' });
  for (const b of pieces(bytes, [1200, 30_000])) await sink.write(b);
  const r = await sink.finalize({ durationMs: 4000 });
  const expected = (await finalize(bytes)).bytes;
  const out = dir.bytes('Lesson.mp4');
  assert.deepEqual(out, expected);
  assert.equal(r.size, out.length);
  const positioned = dir.writes.filter(w => w.position !== null);
  const moovAt = boxes(bytes).find(b => b.type === 'moov').start;
  assert.deepEqual(positioned.map(w => [w.position, w.size]), [[bytes.length, expected.length - bytes.length], [moovAt, 8]]);
});

test('FolderSink: when the index can’t be written, finalize fails (the recorder then uses its safety copy)', async () => {
  const bytes = await fixture('mediarecorder-vp9-opus.mp4');
  const { dir, sink } = await folderSink();
  await sink.open({ filename: 'Lesson.mp4', container: 'mp4' });
  for (const b of pieces(bytes, [30_000])) await sink.write(b);
  dir.failAfterBytes = dir.bytesWritten;   // the disk is full after the last chunk
  await assert.rejects(sink.finalize({ durationMs: 4000 }), /full/);
  await sink.abort();
  assert.equal(dir.bytes('Lesson.mp4'), null, 'no half-written file is left');
});

test('an index whose length disagrees with the take’s clock is not trusted: both sinks save as recorded', async () => {
  const bytes = await fixture('mediarecorder-vp9-opus.mp4');
  const memory = new MemorySink();
  await memory.open({ filename: 'Lesson.mp4', container: 'mp4' });
  for (const b of pieces(bytes, [30_000])) await memory.write(b);
  assert.deepEqual(await bytesOf((await memory.finalize({ durationMs: 60_000 })).blob), bytes);
  const { dir, sink } = await folderSink();
  await sink.open({ filename: 'Lesson.mp4', container: 'mp4' });
  for (const b of pieces(bytes, [30_000])) await sink.write(b);
  await sink.finalize({ durationMs: 60_000 });
  assert.deepEqual(dir.bytes('Lesson.mp4'), bytes);
  // Within 5 s (or a tenth) of the clock, the index is used.
  const { dir: dir2, sink: sink2 } = await folderSink();
  await sink2.open({ filename: 'Lesson.mp4', container: 'mp4' });
  for (const b of pieces(bytes, [30_000])) await sink2.write(b);
  await sink2.finalize({ durationMs: 8000 });
  assert.deepEqual(top(dir2.bytes('Lesson.mp4')), ['ftyp', 'mdat', 'moov']);
});

// ------------------------------------------------------------ left alone

test('anything that isn’t a MediaRecorder-style fragmented MP4 is saved exactly as recorded', async () => {
  const fixed = (await finalize(await fixture('mediarecorder-vp9-opus.mp4'))).bytes;
  const webm = await fixture('vp9-opus-2s.webm');
  const noise = new Uint8Array(5000).map((_, i) => (i * 7919) % 251);
  const truncatedHeader = (await fixture('mediarecorder-vp9-opus.mp4')).subarray(0, 600);   // ends inside the moov
  for (const [what, bytes] of [['already indexed', fixed], ['WebM', webm], ['noise', noise], ['header only', truncatedHeader]]) {
    for (const partial of [false, true]) {
      const r = await finalize(bytes, { partial });
      assert.equal(r.finalized, false, what);
      assert.deepEqual(r.bytes, bytes, what);
    }
  }
});

// ------------------------------------------------------------ recovered takes

test('a take cut off mid-way (crash recovery) is indexed up to its last whole sample', async () => {
  const bytes = await fixture('mediarecorder-h264-opus.mp4');
  const list = boxes(bytes);
  const lastMoof = list.filter(b => b.type === 'moof').at(-1);
  const lastMdat = list.at(-1);
  const cuts = {
    'inside the last mdat': lastMdat.start + Math.floor(lastMdat.size / 2),
    'inside the last moof': lastMoof.start + 40,
    'inside a box header': lastMoof.start + 3,
  };
  for (const [where, at] of Object.entries(cuts)) {
    const cut = bytes.slice(0, at);
    // Without `partial` (a normal stop) a file that ends mid-box is left alone.
    assert.equal((await finalize(cut)).finalized, false, where);
    const r = await finalize(cut, { partial: true });
    assert.equal(r.finalized, true, where);
    assert.ok(r.durationMs > 2000 && r.durationMs < 4000, `${where}: ${r.durationMs} ms`);
    assert.deepEqual(top(r.bytes), ['ftyp', 'mdat', 'moov'], where);
    if (hasFfmpeg) {
      const file = await saveTmp(r.bytes, 'cut');
      assert.equal(decodeErrors(file), '', where);
      const full = packets(await saveTmp(bytes, 'raw'));
      const got = packets(file);
      assert.ok(got.length < full.length && got.length > full.length / 2, `${where}: ${got.length}/${full.length}`);
      for (const p of got) assert.ok(full.includes(p), `${where}: ${p} is a packet of the original`);
    }
  }
});

test('the journal rebuilds an MP4 take as an indexed file, with its duration', async () => {
  const bytes = await fixture('mediarecorder-vp9-opus.mp4');
  const chunks = pieces(bytes, [1200, 25_000]);
  const { blob, durationMs } = await buildRecording(chunks.slice(0, -1), 'video/mp4', 9999);
  const out = await bytesOf(blob);
  assert.deepEqual(top(out), ['ftyp', 'mdat', 'moov']);
  assert.ok(durationMs > 2000 && durationMs < 4000, `${durationMs} ms`);
  assert.equal(blob.type, 'video/mp4');
});

test('a fragment lost from the middle keeps the timing of everything after it', needFfmpeg, async () => {
  const bytes = await fixture('mediarecorder-h264-opus.mp4');
  const list = boxes(bytes);
  const moofs = list.filter(b => b.type === 'moof');
  const gone = moofs[3];
  const next = moofs[4];
  const gapped = new Uint8Array([...bytes.subarray(0, gone.start), ...bytes.subarray(next.start)]);
  const r = await finalize(gapped, { partial: true });
  assert.equal(r.finalized, true);
  const before = packets(await saveTmp(gapped, 'gapped'));
  const after = packets(await saveTmp(r.bytes, 'gapped-fixed'));
  assert.deepEqual(after, before);
});

// ------------------------------------------------------------ other fragmented MP4s

test('other fragmented MP4s: B-frames, AAC, explicit offsets, several runs, edit lists', needFfmpeg, async () => {
  const base = ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '3', '-c:v', 'libx264', '-bf', '2', '-g', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac'];
  const variants = {
    'base is moof': ['-movflags', 'frag_keyframe+empty_moov+default_base_moof'],
    'explicit base offsets': ['-movflags', 'frag_keyframe+empty_moov'],
    'short fragments': ['-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-frag_duration', '200000'],
    'edit lists': ['-use_editlist', '1', '-movflags', 'frag_keyframe+empty_moov+default_base_moof+delay_moov'],
  };
  for (const [what, args] of Object.entries(variants)) {
    const src = path.join(tmp, `ff-${fileNo++}.mp4`);
    execFileSync('ffmpeg', [...base, ...args, src]);
    const bytes = new Uint8Array(await readFile(src));
    const r = await finalize(bytes);
    assert.equal(r.finalized, true, what);
    const file = await saveTmp(r.bytes, 'ff-fixed');
    assert.deepEqual(packets(file), packets(src), what);
    assert.equal(decodeErrors(file), '', what);
    assert.ok(r.durationMs > 2900 && r.durationMs < 3200, `${what}: ${r.durationMs}`);
  }
});

test('a track whose first fragment starts later keeps its place (edit list)', needFfmpeg, async () => {
  // Move every audio fragment 0.5 s later, as a recorder whose audio starts late would.
  const bytes = (await fixture('mediarecorder-vp9-opus.mp4')).slice();
  const dv = new DataView(bytes.buffer);
  for (const moof of boxes(bytes).filter(b => b.type === 'moof')) {
    for (const traf of moof.children.filter(c => c.type === 'traf')) {
      if (dv.getUint32(child(traf, 'tfhd').body + 4) !== 2) continue;
      const tfdt = child(traf, 'tfdt');
      if (bytes[tfdt.body] === 1) dv.setBigUint64(tfdt.body + 4, dv.getBigUint64(tfdt.body + 4) + 24_000n);
      else dv.setUint32(tfdt.body + 4, dv.getUint32(tfdt.body + 4) + 24_000);
    }
  }
  const src = await saveTmp(bytes, 'late-audio');
  const r = await finalize(bytes);
  const file = await saveTmp(r.bytes, 'late-audio-fixed');
  const firstAudioPts = list => Math.min(...list.filter(l => l.startsWith('1,')).map(l => Number(l.split(',')[1])));
  assert.ok(firstAudioPts(packets(src)) >= 24_000, 'the fragmented file starts its audio 0.5 s in');
  assert.ok(boxes(r.bytes).find(b => b.type === 'moov').children.filter(c => c.type === 'trak').some(t => child(t, 'edts')), 'an edit list keeps it there');
  assert.deepEqual(packets(file), packets(src));
});

// ------------------------------------------------------------ big files

test('past 4 GB: 64-bit chunk offsets and mdat size, and 64-bit durations when needed', async () => {
  const head = mdatHeader(5_000_000_000);
  assert.equal(head.length, 16);
  const dv = new DataView(head.buffer);
  assert.equal(dv.getUint32(0), 1);
  assert.equal(String.fromCharCode(...head.subarray(4, 8)), 'mdat');
  assert.equal(Number(dv.getBigUint64(8)), 5_000_000_000);
  assert.equal(mdatHeader(1000).length, 8);

  const bytes = await fixture('mediarecorder-vp9-opus.mp4');
  const m = boxes(bytes).find(b => b.type === 'moov');
  const moovBytes = bytes.slice(m.start, m.start + m.size);
  const header = parseMoov(moovBytes);
  const [video] = header.tracks;
  const offsets = [4_294_967_000, 5_000_000_000, 9_000_000_123];
  offsets.forEach((offset, i) => {
    video.chunks.push({ offset, first: video.sizes.length, count: 1, sdi: 1 });
    video.sizes.push(100);
    video.dts.push(i * 2 ** 31);
    video.durations.push(2 ** 31);
    video.sync.push(1);
    video.cto.push(0);
  });
  const { moov } = buildMoov(moovBytes, header, Infinity);
  const out = boxes(moov)[0];
  const stbl = child(out.children.find(c => c.type === 'trak'), 'mdia', 'minf', 'stbl');
  assert.ok(child(stbl, 'co64'));
  assert.deepEqual(chunkOffsets(moov, stbl), offsets);
  const mdhd = child(out.children.find(c => c.type === 'trak'), 'mdia', 'mdhd');
  assert.equal(moov[mdhd.body], 1, 'mdhd version 1');
  assert.equal(durationOf(moov, mdhd), 3 * 2 ** 31);
});

test('past 4 GB, through the indexer: a 64-bit mdat in the stream, 64-bit chunk offsets and mdat header', async () => {
  // The recording as the indexer sees it: header and first fragments, then 4.3 GB of media the
  // indexer never reads (a stand-in Blob that refuses to be read), then the last fragments.
  const bytes = await fixture('mediarecorder-h264-opus.mp4');
  const list = boxes(bytes);
  const split = list.filter(b => b.type === 'moof')[4].start;
  const PAD = 4_300_000_000;
  const padHead = new Uint8Array(16);
  const dv = new DataView(padHead.buffer);
  dv.setUint32(0, 1);
  padHead.set([0x66, 0x72, 0x65, 0x65], 4);   // 'free': a 64-bit box of filler
  dv.setBigUint64(8, BigInt(PAD));
  const unread = { size: PAD - 16, slice() { throw new Error('the indexer read the media'); } };
  const ix = new Mp4Indexer();
  for (const piece of [new Blob([bytes.subarray(0, split)]), new Blob([padHead]), unread, new Blob([bytes.subarray(split)])]) await ix.push(piece);
  assert.equal(ix.error, null);
  const plan = ix.plan();
  assert.equal(plan.moovAt, bytes.length + PAD);
  // A 16-byte mdat header over the old moov, spanning everything to the new moov.
  assert.equal(plan.header.length, 16);
  const h = new DataView(plan.header.buffer, plan.header.byteOffset);
  assert.equal(h.getUint32(0), 1);
  assert.equal(Number(h.getBigUint64(8)), plan.moovAt - plan.headerAt);
  // Fragments after the filler are indexed with 64-bit offsets, exactly where they are.
  const moov = boxes(plan.moov)[0];
  const offsetsAfter = [];
  for (const trak of moov.children.filter(c => c.type === 'trak')) {
    const stbl = child(trak, 'mdia', 'minf', 'stbl');
    assert.ok(child(stbl, 'co64'), 'co64');
    offsetsAfter.push(...chunkOffsets(plan.moov, stbl).filter(o => o > 2 ** 32));
  }
  const expected = boxes(bytes).filter(b => b.type === 'mdat' && b.start > split).map(b => b.start + 8 + PAD);
  for (const o of expected) assert.ok(offsetsAfter.includes(o), `a chunk at ${o}`);
  assert.ok(plan.durationMs > 3800 && plan.durationMs < 4200, `${plan.durationMs} ms`);
});

test('track and edit lengths follow the new sample timeline, even if a fragment’s start time steps back', async () => {
  const bytes = await fixture('mediarecorder-vp9-opus.mp4');
  const m = boxes(bytes).find(b => b.type === 'moov');
  const moovBytes = bytes.slice(m.start, m.start + m.size);
  const header = parseMoov(moovBytes);
  const [video] = header.tracks;   // timescale 30000
  // Samples at 0, 1000, 2000, then a fragment restarting at 1500 (back by 500), the last one shown
  // 2000 ticks after it is decoded. Each lasts 1000.
  [[0, 0], [1000, 0], [2000, 0], [1500, 0], [2500, 2000]].forEach(([dts, cto], i) => {
    video.chunks.push({ offset: 10_000 + i * 100, first: video.sizes.length, count: 1, sdi: 1 });
    video.sizes.push(100); video.dts.push(dts); video.durations.push(1000); video.sync.push(1); video.cto.push(cto);
    if (cto) video.anyCto = true;
  });
  header.tracks = [video];
  header.top = header.top.filter(c => c.type !== 'trak' || c === header.top.find(t => t.type === 'trak'));
  const { moov, durationMs } = buildMoov(moovBytes, header, Infinity);
  // New timeline: 0, 1000, 2000, 3000 (the step back can't be kept), 4000; shown until 4000 + 2000 + 1000.
  const trak = boxes(moov)[0].children.find(c => c.type === 'trak');
  assert.equal(durationOf(moov, child(trak, 'tkhd')), Math.round(7000 / 30));
  assert.equal(durationMs, Math.round(7000 / 30));
});

test('indexing reads ahead: about one read per fragment, not one per box', async () => {
  const bytes = await fixture('mediarecorder-h264-opus.mp4');
  const real = new Blob([bytes]);
  let reads = 0;
  const counted = { size: real.size, slice(a, b) { reads++; return real.slice(a, b); } };
  const ix = new Mp4Indexer();
  await ix.push(counted);
  const fragments = boxes(bytes).filter(b => b.type === 'moof').length;
  assert.ok(ix.plan(), 'indexed');
  assert.ok(reads <= fragments + 2, `${reads} reads for ${fragments} fragments`);
});

test('applyPlanToBlob refuses a plan made for other bytes', async () => {
  const bytes = await fixture('mediarecorder-vp9-opus.mp4');
  const ix = new Mp4Indexer();
  await ix.push(new Blob([bytes]));
  assert.throws(() => applyPlanToBlob(new Blob([bytes.subarray(1)]), ix.plan()));
});
