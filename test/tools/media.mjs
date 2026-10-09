// Independent checks of saved recordings, shared by the unit and browser
// tests: ffmpeg/ffprobe, GStreamer (through gst_probe.py) and a minimal MP4
// box reader that doesn't share code with the app.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const run = (cmd, args) => execFileSync(cmd, args, { maxBuffer: 256 << 20, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const works = (cmd, args) => { try { execFileSync(cmd, args, { stdio: 'ignore' }); return true; } catch { return false; } };

export const hasFfmpeg = works('ffprobe', ['-version']) && works('ffmpeg', ['-version']);

/** A Python that has GStreamer's bindings, or null. */
export const gstPython = ['python3', 'python3.12'].find(py => works(py, ['-c', "import gi; gi.require_version('Gst', '1.0'); from gi.repository import Gst"])) ?? null;

/** Every packet ffprobe reads, as sorted "stream,pts,dts,size,flags" lines. */
export function ffprobePackets(file) {
  return run('ffprobe', ['-v', 'error', '-show_entries', 'packet=stream_index,pts,dts,size,flags', '-of', 'csv=p=0', file])
    .trim().split('\n').filter(Boolean).sort();
}

export function ffprobeInfo(file) {
  const j = JSON.parse(run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]));
  return { duration: Number(j.format.duration), streams: j.streams.map(s => ({ type: s.codec_type, codec: s.codec_name })) };
}

/** Everything ffmpeg reports at error level while decoding the whole file ('' when clean). */
export function decodeErrors(file, extra = []) {
  try { return run('ffmpeg', ['-v', 'error', ...extra, '-i', file, '-f', 'null', '-']).trim(); } catch (e) { return String(e.stderr || e).trim(); }
}

const GST_PROBE = fileURLToPath(new URL('./gst_probe.py', import.meta.url));
/** What GStreamer's player stack sees: {duration, seekable, seekEnd, seeks: [{target, accepted, pts, bytes}]}. */
export function gstProbe(file, targets = []) {
  return JSON.parse(run(gstPython, [GST_PROBE, file, ...targets.map(String)]));
}

// ------------------------------------------------------------ MP4 boxes

const u32 = (b, p) => ((b[p] << 24) >>> 0) + (b[p + 1] << 16) + (b[p + 2] << 8) + b[p + 3];
const u64 = (b, p) => u32(b, p) * 2 ** 32 + u32(b, p + 4);
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'mvex', 'moof', 'traf', 'edts', 'dinf']);

/** Boxes in bytes[start..end): [{type, start, size, body, children?}]. */
export function boxes(b, start = 0, end = b.length) {
  const out = [];
  for (let p = start; p + 8 <= end;) {
    let size = u32(b, p);
    let hl = 8;
    if (size === 1) { size = u64(b, p + 8); hl = 16; } else if (size === 0) size = end - p;
    const type = String.fromCharCode(...b.subarray(p + 4, p + 8));
    const box = { type, start: p, size, body: p + hl };
    if (CONTAINERS.has(type)) box.children = boxes(b, p + hl, Math.min(end, p + size));
    out.push(box);
    if (size < hl) break;
    p += size;
  }
  return out;
}

export const child = (box, ...path) => path.reduce((b, t) => b?.children?.find(c => c.type === t) ?? null, box);

/** Duration fields of mvhd/tkhd/mdhd. */
export function durationOf(b, box) {
  const v = b[box.body];
  if (box.type === 'tkhd') return v === 1 ? u64(b, box.body + 28) : u32(b, box.body + 20);
  return v === 1 ? u64(b, box.body + 24) : u32(b, box.body + 16);
}

export function timescaleOf(b, box) {
  return u32(b, box.body + (b[box.body] === 1 ? 20 : 12));
}

/** Chunk offsets from stco or co64. */
export function chunkOffsets(b, stbl) {
  const stco = child(stbl, 'stco');
  const co64 = child(stbl, 'co64');
  const box = stco || co64;
  const n = u32(b, box.body + 4);
  return Array.from({ length: n }, (_, i) => (co64 ? u64(b, box.body + 8 + i * 8) : u32(b, box.body + 8 + i * 4)));
}

export function sampleCount(b, stbl) {
  return u32(b, child(stbl, 'stsz').body + 8);
}

// ------------------------------------------------------------ sync

/** Onset times (s) of a signal sampled as [{t, v}]: rises above `hi` after falling below `lo`. */
function onsets(samples, lo, hi, gapS = 0.5) {
  const out = [];
  let armed = true;
  for (const { t, v } of samples) {
    if (v < lo && !armed && out.length && t - out[out.length - 1] > gapS) armed = true;
    if (armed && v > hi) { out.push(t); armed = false; }
  }
  return out;
}

function metadataRows(text, key) {
  const rows = [];
  let t = null;
  for (const line of text.split('\n')) {
    const m = line.match(/pts_time:(-?[\d.]+)/);
    if (m) t = Number(m[1]);
    const v = line.match(new RegExp(`${key.replace(/\./g, '\\.')}=(-?[\\d.]+|-inf)`));
    if (v && t !== null) rows.push({ t, v: v[1] === '-inf' ? -200 : Number(v[1]) });
  }
  return rows;
}

/**
 * Flash and beep onsets of a recording of the sync stimulus (test/e2e/stimulus.mjs),
 * decoded from `from` seconds on with ffmpeg's index-based seek, keeping the file's
 * own timestamps. Returns {frames, firstVideo, firstAudio, flashes, beeps} in seconds
 * (frames: every video frame's time).
 */
export function flashesAndBeeps(file, { from = 0 } = {}) {
  const seek = from > 0 ? ['-ss', String(from)] : [];
  const video = run('ffmpeg', ['-v', 'quiet', ...seek, '-copyts', '-i', file, '-map', '0:v:0', '-vf', 'scale=64:36,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-', '-f', 'null', '-']);
  const audio = run('ffmpeg', ['-v', 'quiet', ...seek, '-copyts', '-i', file, '-map', '0:a:0', '-af', 'aresample=16000,asetnsamples=n=80:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-', '-f', 'null', '-']);
  const v = metadataRows(video, 'lavfi.signalstats.YAVG');
  const a = metadataRows(audio, 'lavfi.astats.Overall.RMS_level');
  // A window that opens mid-flash or mid-beep has no real onset at its start.
  const settled = rows => rows.filter(r => r.t > (rows[0]?.t ?? 0) + 0.15);
  return {
    frames: v.map(r => r.t),
    firstVideo: v[0]?.t ?? null,
    firstAudio: a[0]?.t ?? null,
    flashes: onsets(settled(v), 64, 128),
    beeps: onsets(settled(a), -50, -30),
  };
}

/** Pair each flash with the nearest beep: offsets in ms (> 0: the sound is late). */
export function syncOffsets({ flashes, beeps }) {
  return flashes.map(f => {
    const b = beeps.reduce((best, x) => (Math.abs(x - f) < Math.abs(best - f) ? x : best), Infinity);
    return Math.abs(b - f) < 0.5 ? { at: f, ms: Math.round((b - f) * 1000) } : null;
  }).filter(Boolean);
}
