// MP4 finalisation. Chrome's MediaRecorder writes *fragmented* MP4, a layout
// made for live streaming: a header ("moov") with no total duration and no
// sample index, then a "moof" (sample list) and "mdat" (sample data) pair for
// every couple of seconds. Players that trust the header (Windows Media
// Player and Films & TV, GStreamer) show the wrong length and can't scrub;
// players that scan the whole file (VLC, ffmpeg) look fine.
//
// Mp4Indexer reads only the small boxes as the recording is written. When it
// stops, plan() describes an ordinary indexed MP4 made from the same bytes:
//   * a complete moov (every sample's time, size, position and keyframe flag,
//     and the real duration) is appended at the end;
//   * the first 8 or 16 bytes of the old moov become an "mdat" header that
//     spans everything from there to the new moov.
// The file then reads ftyp | mdat | moov, the usual layout of a finished MP4.
// No sample moves: the index points at the positions the samples already
// have, so finalising costs two small writes, never a copy of the recording.
//
// Timing is kept exactly as the fragments give it. (Chrome's MP4 muxer starts
// each track at 0, so if the first video frame reached MediaRecorder later
// than the first sound, that delay is already a constant offset in the
// fragments; WebM keeps the gap instead. It can't be recovered from the file.)

const MAX_BOX_BYTES = 16 * 1024 * 1024;   // a moov or moof bigger than this isn't MediaRecorder's
const READ_AHEAD = 16 * 1024;              // one read covers a box header, a moof (1–2 KB) and the next header
const U32 = 0x1_0000_0000;

// tfhd flags
const TF_BASE_DATA_OFFSET = 0x000001;
const TF_SAMPLE_DESCRIPTION = 0x000002;
const TF_DEFAULT_DURATION = 0x000008;
const TF_DEFAULT_SIZE = 0x000010;
const TF_DEFAULT_FLAGS = 0x000020;
const TF_DEFAULT_BASE_IS_MOOF = 0x020000;
// trun flags
const TR_DATA_OFFSET = 0x001;
const TR_FIRST_FLAGS = 0x004;
const TR_DURATION = 0x100;
const TR_SIZE = 0x200;
const TR_FLAGS = 0x400;
const TR_CTO = 0x800;
// sample_flags: sample_is_non_sync_sample
const NON_SYNC = 0x10000;

/** The bytes aren't the fragmented MP4 we expected; indexing stops here. */
export class Mp4Error extends Error {
  constructor(message, at = null) { super(message); this.name = 'Mp4Error'; this.at = at; }
}

// ------------------------------------------------------------ byte helpers

const u16 = (b, p) => (b[p] << 8) | b[p + 1];
const u32 = (b, p) => ((b[p] << 24) >>> 0) + (b[p + 1] << 16) + (b[p + 2] << 8) + b[p + 3];
const i32 = (b, p) => u32(b, p) | 0;
const u64 = (b, p) => u32(b, p) * U32 + u32(b, p + 4);
const i64 = (b, p) => i32(b, p) * U32 + u32(b, p + 4);
const fourcc = (b, p) => String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
const PRINTABLE = /^[\x20-\x7e]{4}$/;

/** A growable list of numbers in a typed array. */
class Grow {
  constructor(Type, capacity = 256) { this.Type = Type; this.a = new Type(capacity); this.length = 0; }
  push(v) {
    if (this.length === this.a.length) { const b = new this.Type(this.a.length * 2); b.set(this.a); this.a = b; }
    this.a[this.length++] = v;
  }
  at(i) { return this.a[i]; }
}

/** Writes big-endian fields into a growing buffer. */
class Out {
  constructor() { this.b = new Uint8Array(1024); this.n = 0; }
  #room(k) {
    if (this.n + k <= this.b.length) return;
    let cap = this.b.length * 2;
    while (cap < this.n + k) cap *= 2;
    const b = new Uint8Array(cap); b.set(this.b.subarray(0, this.n)); this.b = b;
  }
  u8(v) { this.#room(1); this.b[this.n++] = v & 0xff; return this; }
  u16(v) { return this.u8(v >>> 8).u8(v); }
  u32(v) { this.#room(4); const x = v >>> 0; this.b[this.n++] = x >>> 24; this.b[this.n++] = (x >>> 16) & 0xff; this.b[this.n++] = (x >>> 8) & 0xff; this.b[this.n++] = x & 0xff; return this; }
  u64(v) { return this.u32(Math.floor(v / U32)).u32(v % U32); }
  i64(v) { const hi = Math.floor(v / U32); return this.u32(hi).u32(v - hi * U32); }
  bytes(a) { this.#room(a.length); this.b.set(a, this.n); this.n += a.length; return this; }
  done() { return this.b.slice(0, this.n); }
}

/** A box: 32-bit size (64-bit when needed), type, payload parts. */
function box(type, ...parts) {
  const len = parts.reduce((s, p) => s + p.length, 0);
  const big = len + 8 > 0xffffffff;
  const o = new Out();
  if (big) o.u32(1); else o.u32(len + 8);
  for (let i = 0; i < 4; i++) o.u8(type.charCodeAt(i));
  if (big) o.u64(len + 16);
  for (const p of parts) o.bytes(p);
  return o.done();
}

/** Child boxes of bytes[start..end). */
function children(b, start, end) {
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    let size = u32(b, p);
    const type = fourcc(b, p + 4);
    let hl = 8;
    if (size === 1) { size = u64(b, p + 8); hl = 16; } else if (size === 0) size = end - p;
    if (size < hl || p + size > end || !PRINTABLE.test(type)) throw new Mp4Error(`bad ${type} box at ${p}`);
    out.push({ type, start: p, end: p + size, body: p + hl });
    p += size;
  }
  return out;
}

const find = (list, type) => list.find(c => c.type === type) || null;

// ------------------------------------------------------------ moov parsing

/** Where a box's payload starts (after an 8- or 16-byte header). */
const payload = b => (u32(b, 0) === 1 ? 16 : 8);

/** What the fragmented header says about each track. */
function parseMoov(b) {
  const top = children(b, payload(b), b.length);
  const mvhd = find(top, 'mvhd');
  if (!mvhd) throw new Mp4Error('moov has no mvhd');
  const mvhdV = b[mvhd.body];
  const movieTimescale = u32(b, mvhd.body + (mvhdV === 1 ? 20 : 12));
  const mvex = find(top, 'mvex');
  const trex = new Map();
  if (mvex) {
    for (const t of children(b, mvex.body, mvex.end)) {
      if (t.type !== 'trex') continue;
      const p = t.body + 4;
      trex.set(u32(b, p), { sdi: u32(b, p + 4), duration: u32(b, p + 8), size: u32(b, p + 12), flags: u32(b, p + 16) });
    }
  }
  const tracks = [];
  for (const trak of top.filter(c => c.type === 'trak')) {
    const tk = children(b, trak.body, trak.end);
    const tkhd = find(tk, 'tkhd');
    const mdia = find(tk, 'mdia');
    if (!tkhd || !mdia) throw new Mp4Error('trak without tkhd or mdia');
    const id = u32(b, tkhd.body + (b[tkhd.body] === 1 ? 20 : 12));
    const md = children(b, mdia.body, mdia.end);
    const mdhd = find(md, 'mdhd');
    const hdlr = find(md, 'hdlr');
    const minf = find(md, 'minf');
    if (!mdhd || !minf) throw new Mp4Error('mdia without mdhd or minf');
    const timescale = u32(b, mdhd.body + (b[mdhd.body] === 1 ? 20 : 12));
    const mi = children(b, minf.body, minf.end);
    const stbl = find(mi, 'stbl');
    const st = stbl ? children(b, stbl.body, stbl.end) : [];
    const stsd = find(st, 'stsd');
    if (!stsd || !timescale) throw new Mp4Error('track without sample description or timescale');
    // MediaRecorder's header lists no samples; one that does isn't what this indexes.
    const stsz = find(st, 'stsz') || find(st, 'stz2');
    if (stsz && u32(b, stsz.body + 8) > 0) throw new Mp4Error('the header already lists samples');
    let edits = null;
    const edts = find(tk, 'edts');
    const elst = edts ? find(children(b, edts.body, edts.end), 'elst') : null;
    if (elst) {
      const v = b[elst.body];
      const n = u32(b, elst.body + 4);
      edits = [];
      for (let i = 0, p = elst.body + 8; i < n; i++) {
        if (v === 1) { edits.push({ duration: u64(b, p), mediaTime: i64(b, p + 8), rate: b.subarray(p + 16, p + 20) }); p += 20; }
        else { edits.push({ duration: u32(b, p), mediaTime: i32(b, p + 4), rate: b.subarray(p + 8, p + 12) }); p += 12; }
      }
    }
    tracks.push({
      id, timescale, handler: hdlr ? fourcc(b, hdlr.body + 8) : '', edits,
      trex: trex.get(id) || { sdi: 1, duration: 0, size: 0, flags: 0 },
      raw: { trak, tk, tkhd, mdia, md, mdhd, minf, mi, stsd },
      sizes: new Grow(Uint32Array), dts: new Grow(Float64Array), durations: new Grow(Uint32Array),
      sync: new Grow(Uint8Array), cto: new Grow(Int32Array), anyCto: false,
      chunks: [], nextDts: 0,
    });
  }
  if (!tracks.length) throw new Mp4Error('moov has no tracks');
  return { movieTimescale, fragmented: !!mvex, top, tracks };
}

// ------------------------------------------------------------ moof parsing

/** Add one movie fragment's samples to the tracks. */
function addFragment(b, moofStart, header) {
  let prevDataEnd = moofStart;
  for (const traf of children(b, payload(b), b.length)) {
    if (traf.type !== 'traf') continue;
    const parts = children(b, traf.body, traf.end);
    const tfhd = find(parts, 'tfhd');
    if (!tfhd) throw new Mp4Error('traf without tfhd');
    const flags = u32(b, tfhd.body) & 0xffffff;
    const track = header.tracks.find(t => t.id === u32(b, tfhd.body + 4));
    if (!track) throw new Mp4Error('fragment for an unknown track');
    let p = tfhd.body + 8;
    let base;
    if (flags & TF_BASE_DATA_OFFSET) { base = u64(b, p); p += 8; }
    else base = flags & TF_DEFAULT_BASE_IS_MOOF ? moofStart : prevDataEnd;
    const sdi = flags & TF_SAMPLE_DESCRIPTION ? u32(b, (p += 4) - 4) : track.trex.sdi;
    const defDuration = flags & TF_DEFAULT_DURATION ? u32(b, (p += 4) - 4) : track.trex.duration;
    const defSize = flags & TF_DEFAULT_SIZE ? u32(b, (p += 4) - 4) : track.trex.size;
    const defFlags = flags & TF_DEFAULT_FLAGS ? u32(b, (p += 4) - 4) : track.trex.flags;

    const tfdt = find(parts, 'tfdt');
    let dts = tfdt ? (b[tfdt.body] === 1 ? u64(b, tfdt.body + 4) : u32(b, tfdt.body + 4)) : track.nextDts;
    let dataPos = base;
    let first = true;
    for (const trun of parts) {
      if (trun.type !== 'trun') continue;
      const version = b[trun.body];
      const tf = u32(b, trun.body) & 0xffffff;
      const count = u32(b, trun.body + 4);
      let q = trun.body + 8;
      if (tf & TR_DATA_OFFSET) { dataPos = base + i32(b, q); q += 4; }
      else if (first) dataPos = base;
      const firstFlags = tf & TR_FIRST_FLAGS ? u32(b, (q += 4) - 4) : null;
      const per = [TR_DURATION, TR_SIZE, TR_FLAGS, TR_CTO].filter(f => tf & f).length * 4;
      if (q + count * per > trun.end) throw new Mp4Error('trun runs past its box');
      if (count) track.chunks.push({ offset: dataPos, first: track.sizes.length, count, sdi });
      for (let i = 0; i < count; i++) {
        const duration = tf & TR_DURATION ? u32(b, (q += 4) - 4) : defDuration;
        const size = tf & TR_SIZE ? u32(b, (q += 4) - 4) : defSize;
        let sflags = tf & TR_FLAGS ? u32(b, (q += 4) - 4) : defFlags;
        if (i === 0 && firstFlags !== null) sflags = firstFlags;
        let cto = 0;
        if (tf & TR_CTO) { cto = version === 0 ? u32(b, q) : i32(b, q); q += 4; }
        track.sizes.push(size);
        track.dts.push(dts);
        track.durations.push(duration);
        track.sync.push(sflags & NON_SYNC ? 0 : 1);
        track.cto.push(cto);
        if (cto) track.anyCto = true;
        dts += duration;
        dataPos += size;
      }
      first = false;
    }
    track.nextDts = dts;
    prevDataEnd = dataPos;
  }
}

// ------------------------------------------------------------ moov writing

/** A full box (mvhd/tkhd/mdhd) with its duration replaced; version 1 when it doesn't fit 32 bits. */
function withDuration(b, node, durationAt0, durationAt1, value) {
  const version = b[node.body];
  const body = b.subarray(node.body, node.end);
  if (version === 1) {
    const out = body.slice();
    new DataView(out.buffer).setBigUint64(durationAt1, BigInt(Math.round(value)));
    return box(fourcc(b, node.start + 4), out);
  }
  if (value <= 0xffffffff) {
    const out = body.slice();
    new DataView(out.buffer).setUint32(durationAt0, Math.round(value));
    return box(fourcc(b, node.start + 4), out);
  }
  // Version 0 -> 1: the two times and the duration grow to 64 bits.
  const o = new Out().u8(1).bytes(body.subarray(1, 4)).u64(u32(body, 4)).u64(u32(body, 8));
  if (durationAt0 === 16) o.bytes(body.subarray(12, 16)).u64(value).bytes(body.subarray(20));           // mvhd, mdhd: timescale, duration
  else o.bytes(body.subarray(12, 20)).u64(value).bytes(body.subarray(24));                                 // tkhd: track_ID, reserved, duration
  return box(fourcc(b, node.start + 4), o.done());
}

/** Run-length entries [count, value] of a list. */
function runs(n, valueAt) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const v = valueAt(i);
    if (out.length && out[out.length - 1][1] === v) out[out.length - 1][0]++;
    else out.push([1, v]);
  }
  return out;
}

function sampleTables(b, t, n, deltas) {
  const parts = [b.subarray(t.raw.stsd.start, t.raw.stsd.end)];
  const stts = runs(n, i => deltas[i]);
  const o = new Out().u32(0).u32(stts.length);
  for (const [c, d] of stts) o.u32(c).u32(d);
  parts.push(box('stts', o.done()));
  if (t.anyCto) {
    const ctts = runs(n, i => t.cto.at(i));
    const signed = ctts.some(([, v]) => v < 0);
    const c = new Out().u32(signed ? 0x01000000 : 0).u32(ctts.length);
    for (const [k, v] of ctts) c.u32(k).u32(v);
    parts.push(box('ctts', c.done()));
  }
  const syncs = [];
  for (let i = 0; i < n; i++) if (t.sync.at(i)) syncs.push(i + 1);
  if (syncs.length < n) {
    const s = new Out().u32(0).u32(syncs.length);
    for (const k of syncs) s.u32(k);
    parts.push(box('stss', s.done()));
  }
  // One chunk per run of samples (the samples of a trun sit back to back).
  const chunks = [];
  for (const c of t.chunks) {
    const count = Math.min(c.count, n - c.first);
    if (count > 0) chunks.push({ offset: c.offset, count, sdi: c.sdi });
  }
  const stsc = [];
  chunks.forEach((c, i) => {
    const last = stsc[stsc.length - 1];
    if (!last || last.count !== c.count || last.sdi !== c.sdi) stsc.push({ first: i + 1, count: c.count, sdi: c.sdi });
  });
  const sc = new Out().u32(0).u32(stsc.length);
  for (const e of stsc) sc.u32(e.first).u32(e.count).u32(e.sdi);
  parts.push(box('stsc', sc.done()));
  const sz = new Out().u32(0);
  const same = n > 0 && t.sizes.a.subarray(0, n).every(v => v === t.sizes.at(0));
  if (same) sz.u32(t.sizes.at(0)).u32(n);
  else { sz.u32(0).u32(n); for (let i = 0; i < n; i++) sz.u32(t.sizes.at(i)); }
  parts.push(box('stsz', sz.done()));
  const wide = chunks.some(c => c.offset > 0xffffffff);
  const co = new Out().u32(0).u32(chunks.length);
  for (const c of chunks) { if (wide) co.u64(c.offset); else co.u32(c.offset); }
  parts.push(box(wide ? 'co64' : 'stco', co.done()));
  return box('stbl', ...parts);
}

/**
 * The edit list that keeps each track where the fragmented file presented it:
 * sample times now start at 0, so a track whose first fragment started later
 * (or an edit that pointed at fragment times) is shifted back into place.
 * `end` is where the last sample's presentation ends, in fragment media time.
 * An edit "to the end" (duration 0 in a fragmented file) gets its real length.
 */
function editsFor(t, firstDts, end, toMovie) {
  if (!t.edits) {
    if (firstDts <= 0) return null;
    return [{ duration: toMovie(firstDts), mediaTime: -1 }, { duration: toMovie(end - firstDts), mediaTime: 0 }];
  }
  const out = [];
  const media = t.edits.filter(e => e.mediaTime >= 0);
  for (const e of t.edits) {
    if (e.mediaTime < 0) { out.push({ duration: e.duration, mediaTime: -1, rate: e.rate }); continue; }
    let mediaTime = e.mediaTime - firstDts;
    if (mediaTime < 0) { out.push({ duration: toMovie(-mediaTime), mediaTime: -1 }); mediaTime = 0; }
    const last = e === media[media.length - 1];
    const duration = e.duration === 0 || last ? toMovie(Math.max(0, end - Math.max(e.mediaTime, firstDts))) : e.duration;
    out.push({ duration, mediaTime, rate: e.rate });
  }
  return out;
}

function elstBox(edits) {
  const wide = edits.some(e => e.duration > 0xffffffff || e.mediaTime > 0x7fffffff);
  const o = new Out().u32(wide ? 0x01000000 : 0).u32(edits.length);
  for (const e of edits) {
    if (wide) o.u64(e.duration).i64(e.mediaTime); else o.u32(e.duration).u32(e.mediaTime);
    o.bytes(e.rate || new Uint8Array([0, 1, 0, 0]));
  }
  return box('edts', box('elst', o.done()));
}

/** The new, complete moov. Samples whose bytes end after `limit` are left out. */
function buildMoov(b, header, limit) {
  const { movieTimescale } = header;
  let movieDuration = 0;
  const summary = [];
  const traks = new Map();
  for (const t of header.tracks) {
    // Only whole samples that are in the file.
    let n = 0;
    for (const c of t.chunks) {
      let end = c.offset;
      let k = 0;
      while (k < c.count && (end += t.sizes.at(c.first + k)) <= limit) k++;
      if (c.first + k > n) n = c.first + k;
      if (k < c.count) break;
    }
    const deltas = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      const d = i + 1 < n ? t.dts.at(i + 1) - t.dts.at(i) : t.durations.at(i);
      // The next fragment's start time is authoritative (Chrome writes a
      // placeholder duration for the last sample of each fragment); fall back
      // to the stated duration if the times ever go backwards.
      deltas[i] = d > 0 && d <= 0xffffffff ? d : t.durations.at(i);
    }
    const mediaDuration = deltas.reduce((s, d) => s + d, 0);
    const firstDts = n ? t.dts.at(0) : 0;
    // Where presentation ends on the new timeline (with reordered frames the last frame shown
    // isn't the last decoded).
    let end = firstDts + mediaDuration;
    for (let i = 0, at = firstDts; i < n; at += deltas[i], i++) end = Math.max(end, at + t.cto.at(i) + deltas[i]);
    const toMovie = v => Math.round((v * movieTimescale) / t.timescale);
    const edits = n ? editsFor(t, firstDts, end, toMovie) : null;
    const trackDuration = edits ? edits.reduce((s, e) => s + e.duration, 0) : toMovie(end - firstDts);
    movieDuration = Math.max(movieDuration, trackDuration);
    summary.push({ id: t.id, handler: t.handler, samples: n, seconds: mediaDuration / t.timescale });

    const r = t.raw;
    const stbl = sampleTables(b, t, n, deltas);
    const minf = box('minf', ...r.mi.map(c => (c.type === 'stbl' ? stbl : b.subarray(c.start, c.end))));
    const mdhd = withDuration(b, r.mdhd, 16, 24, mediaDuration);
    const mdia = box('mdia', ...r.md.map(c => (c.type === 'mdhd' ? mdhd : c.type === 'minf' ? minf : b.subarray(c.start, c.end))));
    const tkhd = withDuration(b, r.tkhd, 20, 28, trackDuration);
    const parts = [];
    for (const c of r.tk) {
      if (c.type === 'tkhd') { parts.push(tkhd); if (edits) parts.push(elstBox(edits)); }
      else if (c.type === 'mdia') parts.push(mdia);
      else if (c.type !== 'edts') parts.push(b.subarray(c.start, c.end));
    }
    traks.set(t, box('trak', ...parts));
  }
  const mvhd = find(header.top, 'mvhd');
  const parts = [];
  let i = 0;
  for (const c of header.top) {
    if (c.type === 'mvhd') parts.push(withDuration(b, mvhd, 16, 24, movieDuration));
    else if (c.type === 'trak') parts.push(traks.get(header.tracks[i++]));
    else if (c.type !== 'mvex') parts.push(b.subarray(c.start, c.end));
  }
  return { moov: box('moov', ...parts), durationMs: Math.round((movieDuration * 1000) / movieTimescale), tracks: summary };
}

/** An mdat header for a box of `size` bytes (header included): 8 bytes, or 16 past 4 GB. */
export function mdatHeader(size) {
  const type = new Uint8Array([0x6d, 0x64, 0x61, 0x74]);
  return size > 0xffffffff ? new Out().u32(1).bytes(type).u64(size).done() : new Out().u32(size).bytes(type).done();
}

// Exported for tests.
export { parseMoov, buildMoov };

// ------------------------------------------------------------ the indexer

/**
 * Feed a recording in order with push(); plan() then describes the indexed
 * file. push() never throws: anything unexpected just stops the indexing, and
 * plan() returns null so the recording is saved exactly as it was written.
 */
export class Mp4Indexer {
  #size = 0;          // bytes pushed
  #next = 0;          // where the next top-level box starts
  #carry = null;      // { blob, need }: bytes from #next on, held while a box straddles pushes
  #cache = null;      // { blob, from, bytes }: the last read-ahead
  #moovBytes = null;
  #moovAt = -1;
  #header = null;
  #fragments = 0;
  #error = null;

  get size() { return this.#size; }
  /** Why indexing stopped early, or null. */
  get error() { return this.#error; }

  async push(blob) {
    const start = this.#size;
    this.#size += blob?.size || 0;
    if (this.#error || !blob?.size) return;
    try {
      await this.#scan(blob, start);
    } catch (e) {
      this.#error = e instanceof Mp4Error ? e : new Mp4Error(e?.message || String(e));
      if (this.#error.at === null) this.#error.at = this.#next;
      this.#carry = null;
    }
  }

  async #read(blob, blobStart, n) {
    if (this.#carry) return new Uint8Array(await new Blob([this.#carry.blob, blob]).slice(0, n).arrayBuffer());
    // Reads are few and small but each one is a round trip (to disk, for a recovered take), so read ahead.
    const from = this.#next - blobStart;
    const c = this.#cache;
    if (!c || c.blob !== blob || from < c.from || from + n > c.from + c.bytes.length) {
      const bytes = new Uint8Array(await blob.slice(from, Math.max(from + n, Math.min(blob.size, from + READ_AHEAD))).arrayBuffer());
      this.#cache = { blob, from, bytes };
    }
    const { bytes, from: start } = this.#cache;
    return bytes.subarray(from - start, from - start + n);
  }

  /** Hold the bytes from #next on until `need` (an absolute offset) has arrived. */
  #keep(blob, blobStart, need) {
    const rest = blob.slice(Math.max(0, this.#next - blobStart));
    const blobOut = this.#carry ? new Blob([this.#carry.blob, rest]) : rest;
    if (blobOut.size > MAX_BOX_BYTES) throw new Mp4Error('box too large');
    this.#carry = { blob: blobOut, need };
  }

  async #scan(blob, blobStart) {
    const blobEnd = blobStart + blob.size;
    // Still short of what the held-back box needs: just hold this piece too.
    if (this.#carry && blobEnd < this.#carry.need) { this.#keep(blob, blobStart, this.#carry.need); return; }
    while (this.#next < blobEnd) {
      const at = this.#next;
      const have = blobEnd - at;
      // A header is 8 bytes, or 16 with a 64-bit size: wait for the rest if it straddles pushes.
      if (have < 8) { this.#keep(blob, blobStart, at + 8); return; }
      const head = await this.#read(blob, blobStart, Math.min(16, have));
      let size = u32(head, 0);
      const type = fourcc(head, 4);
      let hl = 8;
      if (!PRINTABLE.test(type)) throw new Mp4Error(`unexpected bytes at ${at}`, at);
      if (size === 1) {
        if (have < 16) { this.#keep(blob, blobStart, at + 16); return; }
        size = u64(head, 8);
        hl = 16;
      } else if (size === 0) size = Infinity;          // runs to the end of the file
      if (size < hl) throw new Mp4Error(`bad ${type} size at ${at}`, at);

      if (type === 'moov' || type === 'moof') {
        if (!Number.isFinite(size) || size > MAX_BOX_BYTES) throw new Mp4Error(`${type} too large`, at);
        if (have < size) { this.#keep(blob, blobStart, at + size); return; }
        const bytes = await this.#read(blob, blobStart, size);
        if (type === 'moov') this.#onMoov(bytes, at);
        else this.#onMoof(bytes, at);
      } else if (type === 'mdat' && !this.#header) {
        throw new Mp4Error('media data before the header', at);
      }
      this.#carry = null;
      this.#next = at + size;
    }
  }

  #onMoov(bytes, at) {
    if (this.#header) throw new Mp4Error('a second moov', at);
    const header = parseMoov(bytes);
    if (!header.fragmented) throw new Mp4Error('not a fragmented MP4: nothing to do', at);
    this.#header = header;
    this.#moovBytes = bytes;
    this.#moovAt = at;
  }

  #onMoof(bytes, at) {
    if (!this.#header) throw new Mp4Error('fragment before the header', at);
    addFragment(bytes, at, this.#header);
    this.#fragments++;
  }

  /**
   * The edits that index the file, or null to leave it as it is.
   * partial: also index a file that ends mid-box or has damaged bytes after
   * some point (a recovered take); only the samples before that are indexed,
   * and the rest of the bytes stay in the file.
   * @returns {{ headerAt: number, header: Uint8Array, moovAt: number, moov: Uint8Array, durationMs: number, tracks: object[] } | null}
   */
  plan({ partial = false } = {}) {
    if (!this.#header || !this.#fragments) return null;
    const clean = !this.#error && !this.#carry && this.#next === this.#size;
    if (!clean && !partial) return null;
    // Damaged bytes from the error onwards are kept, but nothing there is indexed.
    const limit = this.#error ? Math.min(this.#size, this.#error.at ?? this.#size) : this.#size;
    const b = this.#moovBytes;
    for (const t of this.#header.tracks) {
      if (t.chunks.some(c => c.offset < this.#moovAt + b.length)) return null;
    }
    const { moov, durationMs, tracks } = buildMoov(b, this.#header, limit);
    if (!tracks.some(t => t.samples > 0)) return null;
    // One mdat from the old moov's start to the end of the recording.
    const header = mdatHeader(this.#size - this.#moovAt);
    return { headerAt: this.#moovAt, header, moovAt: this.#size, moov, durationMs, tracks };
  }
}

/** The finalised file as a Blob (no media is copied: slices of `blob` plus the new header and index). */
export function applyPlanToBlob(blob, plan, type = blob.type) {
  if (blob.size !== plan.moovAt) throw new Error('the plan is for a different file');
  return new Blob([
    blob.slice(0, plan.headerAt),
    plan.header,
    blob.slice(plan.headerAt + plan.header.length, plan.moovAt),
    plan.moov,
  ], { type });
}

/**
 * Index a fragmented MP4 held as a Blob. Returns the original Blob untouched
 * when it isn't one or can't be read.
 * @returns {Promise<{blob: Blob, finalized: boolean, durationMs: number}>}
 */
export async function finalizeMp4Blob(blob, { partial = false } = {}) {
  const indexer = new Mp4Indexer();
  await indexer.push(blob);
  let plan = null;
  try { plan = indexer.plan({ partial }); } catch (e) { console.warn('MP4 left as recorded:', e.message); }
  if (!plan) {
    if (indexer.error) console.warn('MP4 left as recorded:', indexer.error.message);
    return { blob, finalized: false, durationMs: 0 };
  }
  return { blob: applyPlanToBlob(blob, plan), finalized: true, durationMs: plan.durationMs };
}

