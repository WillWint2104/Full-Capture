// WebM (EBML) helpers. Chrome's MediaRecorder writes WebM without a Duration,
// so players show no length and scrub badly. These helpers add the Duration
// by touching only the file header, never the whole recording:
//
//  * prepareStreamingHeader(firstChunk) puts a placeholder Duration into the
//    first chunk before it is written to disk, and reports where it sits, so
//    the real value can be written in place when recording stops.
//  * patchWebmBlob(blob, ms) rewrites just the first few KB of a finished
//    recording and splices it back in front of the untouched remainder.

export const IDS = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
};

const DEFAULT_SCALE = 1_000_000; // ns per tick: 1 tick = 1 ms

/** Thrown when the bytes end before the element we need is complete. */
export class NeedMoreData extends Error {
  constructor() { super('need more data'); this.name = 'NeedMoreData'; }
}

function vintLength(first) {
  for (let i = 0; i < 8; i++) if (first & (0x80 >> i)) return i + 1;
  return 0;
}

/** Element ID at `pos` (marker bits kept). */
export function readId(bytes, pos) {
  if (pos >= bytes.length) throw new NeedMoreData();
  const len = vintLength(bytes[pos]);
  if (len < 1 || len > 4) throw new Error(`invalid element id at ${pos}`);
  if (pos + len > bytes.length) throw new NeedMoreData();
  let id = 0;
  for (let i = 0; i < len; i++) id = id * 256 + bytes[pos + i];
  return { id, length: len };
}

/** Element size at `pos`; `unknown` when every value bit is set. */
export function readSize(bytes, pos) {
  if (pos >= bytes.length) throw new NeedMoreData();
  const len = vintLength(bytes[pos]);
  if (len < 1) throw new Error(`invalid element size at ${pos}`);
  if (pos + len > bytes.length) throw new NeedMoreData();
  let value = bytes[pos] & (0xff >> len);
  let allOnes = value === (0xff >> len);
  for (let i = 1; i < len; i++) {
    value = value * 256 + bytes[pos + i];
    if (bytes[pos + i] !== 0xff) allOnes = false;
  }
  return { value, length: len, unknown: allOnes };
}

/** Encode a size as a VINT of exactly `length` bytes (or the shortest that fits). */
export function encodeSize(value, length = 0) {
  let len = 1;
  // All-ones is reserved for "unknown", so a length holds values up to 2^(7n) - 2.
  while (value > 2 ** (7 * len) - 2 && len < 8) len++;
  if (length) {
    if (length < len) throw new Error(`size ${value} does not fit in ${length} bytes`);
    len = length;
  }
  const out = new Uint8Array(len);
  let v = value;
  for (let i = len - 1; i > 0; i--) { out[i] = v % 256; v = Math.floor(v / 256); }
  out[0] = (0x80 >> (len - 1)) | v;
  return out;
}

function readUint(bytes, pos, size) {
  let v = 0;
  for (let i = 0; i < size; i++) v = v * 256 + bytes[pos + i];
  return v;
}

/** Big-endian float payload for a Duration element (float64, or float32 when size is 4). */
export function encodeDurationPayload(durationMs, timecodeScale = DEFAULT_SCALE, size = 8) {
  const ticks = (durationMs * 1e6) / timecodeScale;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  if (size === 8) dv.setFloat64(0, ticks);
  else if (size === 4) dv.setFloat32(0, ticks);
  else throw new Error(`unsupported Duration size ${size}`);
  return out;
}

/**
 * Walk EBML header -> Segment -> Info. Returns the layout needed to read or
 * add a Duration. Throws NeedMoreData if `bytes` ends before Info does.
 */
export function locateInfo(bytes) {
  let pos = 0;
  const ebml = readId(bytes, pos);
  if (ebml.id !== IDS.EBML) throw new Error('not a WebM file (no EBML header)');
  pos += ebml.length;
  const ebmlSize = readSize(bytes, pos);
  if (ebmlSize.unknown) throw new Error('EBML header has unknown size');
  pos += ebmlSize.length + ebmlSize.value;

  const seg = readId(bytes, pos);
  if (seg.id !== IDS.Segment) throw new Error('no Segment element');
  const segSizePos = pos + seg.length;
  const segSize = readSize(bytes, segSizePos);
  pos = segSizePos + segSize.length;

  for (;;) {
    const child = readId(bytes, pos);
    const sizePos = pos + child.length;
    const size = readSize(bytes, sizePos);
    const dataStart = sizePos + size.length;
    if (child.id === IDS.Info) {
      if (size.unknown) throw new Error('Info has unknown size');
      const dataEnd = dataStart + size.value;
      if (dataEnd > bytes.length) throw new NeedMoreData();
      let timecodeScale = DEFAULT_SCALE, duration = null;
      for (let p = dataStart; p < dataEnd;) {
        const kid = readId(bytes, p);
        const kSize = readSize(bytes, p + kid.length);
        if (kSize.unknown) throw new Error('Info child has unknown size');
        const kData = p + kid.length + kSize.length;
        if (kid.id === IDS.TimecodeScale) timecodeScale = readUint(bytes, kData, kSize.value) || DEFAULT_SCALE;
        if (kid.id === IDS.Duration) duration = { offset: kData, size: kSize.value };
        p = kData + kSize.value;
      }
      return {
        segment: { sizePos: segSizePos, size: segSize, dataStart: segSizePos + segSize.length },
        info: { idPos: pos, sizePos, size, dataStart, dataEnd },
        timecodeScale,
        duration,
      };
    }
    // Inserting bytes would invalidate the byte offsets a SeekHead stores.
    if (child.id === IDS.SeekHead) throw new Error('SeekHead present; header cannot grow safely');
    if (child.id === IDS.Cluster || child.id === IDS.Tracks || size.unknown) {
      throw new Error('Info element not found before media data');
    }
    pos = dataStart + size.value;
  }
}

/**
 * Make sure the header has a Duration element. Returns the (possibly new)
 * header bytes and the byte offset of the Duration payload inside them.
 * `bytes` is not modified.
 * @returns {{bytes:Uint8Array, durationOffset:number, durationSize:number, timecodeScale:number}}
 */
export function prepareStreamingHeader(bytes) {
  const layout = locateInfo(bytes);
  if (layout.duration && (layout.duration.size === 8 || layout.duration.size === 4)) {
    return { bytes: bytes.slice(), durationOffset: layout.duration.offset, durationSize: layout.duration.size, timecodeScale: layout.timecodeScale };
  }
  if (layout.duration) throw new Error(`unexpected Duration size ${layout.duration.size}`);

  const { info, segment } = layout;
  // Duration element: ID 0x4489, size 8, float64 payload = 11 bytes.
  const durEl = new Uint8Array([0x44, 0x89, 0x88, 0, 0, 0, 0, 0, 0, 0, 0]);
  // Keep Info's size field the same width when the new size fits.
  let newInfoSize;
  try { newInfoSize = encodeSize(info.size.value + durEl.length, info.size.length); }
  catch { newInfoSize = encodeSize(info.size.value + durEl.length); }
  const growth = durEl.length + (newInfoSize.length - info.size.length);

  let segSizeBytes = null;
  if (!segment.size.unknown) {
    // A sized Segment must grow too; keep its size field the same width so
    // nothing before Info moves.
    segSizeBytes = encodeSize(segment.size.value + growth, segment.size.length);
  }

  const out = new Uint8Array(bytes.length + growth);
  let o = 0;
  const copy = part => { out.set(part, o); o += part.length; };
  if (segSizeBytes) {
    copy(bytes.subarray(0, segment.sizePos));
    copy(segSizeBytes);
    copy(bytes.subarray(segment.sizePos + segment.size.length, info.sizePos));
  } else {
    copy(bytes.subarray(0, info.sizePos));
  }
  copy(newInfoSize);
  copy(bytes.subarray(info.dataStart, info.dataEnd));
  const durationOffset = o + 3;
  copy(durEl);
  copy(bytes.subarray(info.dataEnd));
  return { bytes: out, durationOffset, durationSize: 8, timecodeScale: layout.timecodeScale };
}

/** Return a copy of the header bytes with Duration set to `durationMs`. */
export function injectDuration(bytes, durationMs) {
  const prepared = prepareStreamingHeader(bytes);
  prepared.bytes.set(
    encodeDurationPayload(durationMs, prepared.timecodeScale, prepared.durationSize),
    prepared.durationOffset,
  );
  return prepared.bytes;
}

/**
 * Add or fix the Duration of a finished WebM recording by reading only its
 * first bytes. Never loads the whole file into memory. Returns the original
 * blob unchanged if the header cannot be parsed.
 */
export async function patchWebmBlob(blob, durationMs, { initialBytes = 64 * 1024, maxBytes = 8 * 1024 * 1024 } = {}) {
  let n = Math.min(initialBytes, blob.size);
  for (;;) {
    const head = new Uint8Array(await blob.slice(0, n).arrayBuffer());
    try {
      const patched = injectDuration(head, durationMs);
      return new Blob([patched, blob.slice(n)], { type: blob.type });
    } catch (e) {
      if (!(e instanceof NeedMoreData) || n >= blob.size || n >= maxBytes) {
        console.warn('WebM duration patch skipped:', e.message);
        return blob;
      }
      n = Math.min(n * 4, blob.size, maxBytes);
    }
  }
}

/** Read the TimecodeScale from a header, or the default when unreadable. */
export function readTimecodeScale(headBytes) {
  try { return locateInfo(headBytes).timecodeScale; } catch { return DEFAULT_SCALE; }
}

/**
 * Estimate where a (possibly truncated) recording ends, in ms, by finding the
 * last Cluster in its final bytes and the latest block timestamp inside it.
 * Used to give recovered recordings an accurate Duration. Returns null when
 * no cluster can be found.
 */
export function lastTimestampMs(tailBytes, timecodeScale = DEFAULT_SCALE) {
  const b = tailBytes;
  for (let i = b.length - 4; i >= 0; i--) {
    if (b[i] !== 0x1f || b[i + 1] !== 0x43 || b[i + 2] !== 0xb6 || b[i + 3] !== 0x75) continue;
    const ticks = parseClusterEnd(b, i);
    if (ticks != null) return (ticks * timecodeScale) / 1e6;
  }
  return null;
}

function parseClusterEnd(b, pos) {
  try {
    const size = readSize(b, pos + 4);
    let p = pos + 4 + size.length;
    const end = size.unknown ? b.length : Math.min(b.length, p + size.value);
    // A real Cluster starts with its Timecode; anything else is a false match
    // inside compressed media data.
    const first = readId(b, p);
    if (first.id !== IDS.Timecode) return null;
    const tSize = readSize(b, p + first.length);
    if (tSize.value < 1 || tSize.value > 8) return null;
    const tData = p + first.length + tSize.length;
    if (tData + tSize.value > b.length) return null;
    const clusterTc = readUint(b, tData, tSize.value);
    let latest = clusterTc;
    p = tData + tSize.value;
    while (p < end) {
      let id, s;
      try { id = readId(b, p); s = readSize(b, p + id.length); } catch { break; }
      const data = p + id.length + s.length;
      if (id.id === IDS.Cluster) break;
      if (id.id === IDS.SimpleBlock || id.id === IDS.Block) {
        const track = readSize(b, data);
        const tcPos = data + track.length;
        if (tcPos + 2 <= b.length) {
          const rel = (b[tcPos] << 8 | b[tcPos + 1]) << 16 >> 16; // signed int16
          latest = Math.max(latest, clusterTc + rel);
        }
      } else if (id.id === IDS.BlockGroup && !s.unknown) {
        // Walk into the group for its Block.
        for (let q = data; q < Math.min(end, data + s.value);) {
          let kid, ks;
          try { kid = readId(b, q); ks = readSize(b, q + kid.length); } catch { break; }
          const kd = q + kid.length + ks.length;
          if (kid.id === IDS.Block) {
            const track = readSize(b, kd);
            const tcPos = kd + track.length;
            if (tcPos + 2 <= b.length) latest = Math.max(latest, clusterTc + ((b[tcPos] << 8 | b[tcPos + 1]) << 16 >> 16));
          }
          q = kd + ks.value;
        }
      }
      if (s.unknown) break;
      p = data + s.value;
    }
    return latest;
  } catch {
    return null;
  }
}
