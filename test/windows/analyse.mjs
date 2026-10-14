// Checks of a saved recording for the Windows acceptance kit (run.mjs), made
// with ffmpeg and ffprobe only, which share no code with the app. Every frame
// is measured for brightness (the test pattern's flashes) and magenta (the
// floating controls, painted magenta by the kit), the sound for the pattern's
// clicks, and the file for its layout, seeks and decoding.
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import { openSync, readSync, closeSync, fstatSync } from 'node:fs';
import path from 'node:path';
import { boxes, child, durationOf, timescaleOf, ffprobePackets, audioPackets, decodeErrors } from '../tools/media.mjs';

const run = (cmd, args) => execFileSync(cmd, args, { maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const round = (x, d = 3) => (x == null || !Number.isFinite(x) ? x : Math.round(x * 10 ** d) / 10 ** d);

// A frame shows the floating controls when more than SHOWN of it is magenta, and none of them when at most CLEAN is.
export const CLEAN = 0.001;
export const SHOWN = 0.01;

export function toolVersions() {
  const first = cmd => { try { return run(cmd, ['-version']).split('\n')[0].trim(); } catch { return null; } };
  return { ffmpeg: first('ffmpeg'), ffprobe: first('ffprobe') };
}

/** Container, length and streams, as ffprobe reports them. */
export function probe(file) {
  const j = JSON.parse(run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]));
  const v = j.streams.find(s => s.codec_type === 'video');
  const a = j.streams.find(s => s.codec_type === 'audio');
  const rate = r => { const [n, d] = String(r || '0/1').split('/').map(Number); return d ? n / d : 0; };
  return {
    container: j.format.format_name, durationS: round(Number(j.format.duration)), bytes: Number(j.format.size), bitRate: Number(j.format.bit_rate),
    video: v ? { codec: v.codec_name, profile: v.profile, width: v.width, height: v.height, avgFps: round(rate(v.avg_frame_rate), 2), durationS: round(Number(v.duration)) } : null,
    audio: a ? { codec: a.codec_name, sampleRate: Number(a.sample_rate), channels: a.channels, durationS: round(Number(a.duration)) } : null,
  };
}

/** Top-level MP4 boxes and the length the header gives, read without loading the media. */
export function mp4Layout(file) {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const head = Buffer.alloc(16);
    const order = [];
    const counts = {};
    let moov = null;
    for (let p = 0; p + 8 <= size;) {
      readSync(fd, head, 0, 16, p);
      let n = head.readUInt32BE(0);
      const type = head.toString('latin1', 4, 8);
      if (n === 1) n = Number(head.readBigUInt64BE(8)); else if (n === 0) n = size - p;
      if (n < 8 || p + n > size) { order.push(`${type}(truncated)`); break; }
      counts[type] = (counts[type] || 0) + 1;
      if (order.length < 8) order.push(type);
      if (type === 'moov') { moov = Buffer.alloc(n); readSync(fd, moov, 0, n, p); }
      p += n;
    }
    const layout = { order, counts, moov: !!moov, moovAtEnd: false, fragmented: !!counts.moof, headerS: null };
    if (!moov) return layout;
    const b = new Uint8Array(moov.buffer, moov.byteOffset, moov.length);
    const m = boxes(b)[0];
    const mvhd = child(m, 'mvhd');
    layout.headerS = round(durationOf(b, mvhd) / timescaleOf(b, mvhd));
    layout.fragmented ||= !!child(m, 'mvex');
    // The index sits after the media (Chrome's recorder can't know it until the end).
    layout.moovAtEnd = order.includes('mdat') && order.lastIndexOf('moov') > order.indexOf('mdat');
    return layout;
  } finally { closeSync(fd); }
}

// Brightness is measured at the right of the picture, clear of the Full Capture window (top
// left) when it comes to the front, of the taskbar and of the browser's sharing bar.
export const LUMA_REGION = { x0: 0.8, x1: 1, y0: 0.1, y1: 0.8 };

/**
 * Every decoded video frame from `from` for `duration` seconds (whole file by
 * default), in the file's own time: {t, luma 0–255 in `region`, magenta share
 * 0–1 of the whole frame}.
 */
export function videoFrames(file, { from = 0, duration = 0, w = 160, h = 90, region = LUMA_REGION } = {}) {
  const args = ['-v', 'info', '-nostats'];
  if (from > 0) args.push('-ss', String(from));
  if (duration > 0) args.push('-t', String(duration));
  args.push('-copyts', '-i', file, '-map', '0:v:0', '-fps_mode', 'passthrough', '-vf', `scale=${w}:${h},showinfo`, '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-');
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const size = w * h * 3;
    const [x0, x1, y0, y1] = [Math.floor(region.x0 * w), Math.ceil(region.x1 * w), Math.floor(region.y0 * h), Math.ceil(region.y1 * h)];
    const area = (x1 - x0) * (y1 - y0);
    const stats = [];
    const times = [];
    let pending = Buffer.alloc(0);
    let line = '';
    let errors = '';
    ff.stdout.on('data', d => {
      pending = pending.length ? Buffer.concat([pending, d]) : d;
      let o = 0;
      for (; o + size <= pending.length; o += size) {
        let sum = 0, magenta = 0;
        for (let k = o, i = 0; k < o + size; k += 3, i++) {
          const r = pending[k], g = pending[k + 1], b = pending[k + 2];
          const x = i % w, y = (i - x) / w;
          if (x >= x0 && x < x1 && y >= y0 && y < y1) sum += 0.299 * r + 0.587 * g + 0.114 * b;
          if (r > 200 && g < 60 && b > 200) magenta++;
        }
        stats.push({ luma: sum / area, magenta: magenta / (w * h) });
      }
      pending = pending.subarray(o);
    });
    ff.stderr.on('data', d => {
      const parts = (line + d).split('\n');
      line = parts.pop();
      for (const l of parts) {
        const m = l.match(/showinfo.*\bn:\s*\d+\s.*\bpts_time:\s*(-?[\d.]+)/);
        if (m) times.push(Number(m[1]));
        else if (/error/i.test(l)) errors += l.trim() + '\n';
      }
    });
    ff.on('error', reject);
    ff.on('close', code => {
      if (code) return reject(new Error(`ffmpeg exited with ${code}: ${errors}`));
      resolve(stats.map((s, i) => ({ t: times[i], luma: round(s.luma, 1), magenta: round(s.magenta, 5) })));
    });
  });
}

/** Loudness in 5 ms steps (dB RMS, above 700 Hz so room rumble doesn't count) and where the sound starts. */
export function audioEnvelope(file, { from = 0, duration = 0 } = {}) {
  const seek = [];
  if (from > 0) seek.push('-ss', String(from));
  if (duration > 0) seek.push('-t', String(duration));
  const text = run('ffmpeg', ['-v', 'quiet', ...seek, '-copyts', '-i', file, '-map', '0:a:0', '-af',
    'highpass=f=700,aresample=16000,asetnsamples=n=80:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-',
    '-f', 'null', '-']);
  const rows = [];
  let t = null;
  for (const l of text.split('\n')) {
    const m = l.match(/pts_time:(-?[\d.]+)/);
    if (m) t = Number(m[1]);
    const v = l.match(/RMS_level=(-?[\d.]+|-?inf|nan)/);
    if (v && t !== null) rows.push({ t, db: /inf|nan/.test(v[1]) ? -200 : Number(v[1]) });
  }
  const shown = spawnSync('ffmpeg', ['-v', 'info', '-nostats', ...seek, '-copyts', '-i', file, '-map', '0:a:0', '-af', 'ashowinfo', '-frames:a', '1', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 64 << 20 }).stderr || '';
  const first = shown.match(/ashowinfo.*\bpts_time:\s*(-?[\d.]+)/);
  return { rows, firstAudio: first ? Number(first[1]) : rows[0]?.t ?? null };
}

/** Low and high thresholds between a signal's floor and its peaks, or null when it has no clear peaks. */
export function thresholds(values, minRange) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const q = p => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
  const floor = q(0.1), peak = q(0.998);
  if (peak - floor < minRange) return { floor, peak, lo: null, hi: null };
  return { floor, peak, lo: floor + 0.35 * (peak - floor), hi: floor + 0.6 * (peak - floor) };
}

/** Times a signal [{t, v}] rises above hi, having been below lo since the last rise (and at least gapS later). */
export function onsets(rows, { lo, hi }, gapS = 0.5) {
  if (lo == null) return [];
  const out = [];
  let armed = false;          // a window that opens mid-flash has no real onset at its start
  for (const { t, v } of rows) {
    if (v < lo && (!out.length || t - out.at(-1) > gapS)) armed = true;
    if (armed && v > hi) { out.push(round(t)); armed = false; }
  }
  return out;
}

/** Pair each flash with the nearest click: offsets in ms (> 0: the sound is late). */
export function pairs(flashes, clicks) {
  return flashes.map(f => {
    const c = clicks.reduce((best, x) => (Math.abs(x - f) < Math.abs(best - f) ? x : best), Infinity);
    return Math.abs(c - f) < 0.5 ? { at: f, ms: Math.round((c - f) * 1000) } : null;
  }).filter(Boolean);
}

const median = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };

/** Gaps in the sound (between audio packets) and in the picture (between frames). */
export function gaps(file, frames) {
  const sound = audioPackets(file);
  const soundGaps = [];
  for (let i = 1; i < sound.length; i++) {
    const g = sound[i].pts - sound[i - 1].end;
    if (g > 0.03) soundGaps.push({ at: round(sound[i - 1].end), s: round(g) });
  }
  const pictureGaps = [];
  let maxFrameGap = 0;
  for (let i = 1; i < frames.length; i++) {
    const g = frames[i].t - frames[i - 1].t;
    maxFrameGap = Math.max(maxFrameGap, g);
    if (g > 0.5) pictureGaps.push({ at: round(frames[i - 1].t), s: round(g) });
  }
  return { soundGaps, pictureGaps, maxFrameGapS: round(maxFrameGap) };
}

/** Peak and mean level of the recorded sound, and how many samples reached full scale. */
export function loudness(file) {
  const log = spawnSync('ffmpeg', ['-v', 'info', '-nostats', '-i', file, '-map', '0:a:0', '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 64 << 20 }).stderr || '';
  const num = re => { const m = log.match(re); return m ? Number(m[1]) : null; };
  return { meanDb: num(/mean_volume:\s*(-?[\d.]+) dB/), maxDb: num(/max_volume:\s*(-?[\d.]+) dB/), samplesAtFullScale: num(/histogram_0db:\s*(\d+)/) ?? 0 };
}

/** MediaRecorder's own output against the saved file: the same packets (times, sizes, keyframes)? */
export function samePackets(rawFile, savedFile) {
  // The discard flag is left out: an edit list in the saved file marks the encoder's priming packets.
  const norm = l => l.replace(/,([K_])[D_][_C]?,?$/, ',$1');
  const count = list => list.reduce((m, l) => m.set(l, (m.get(l) || 0) + 1), new Map());
  // trimEnd: ffprobe on Windows ends its lines with \r\n.
  const a = ffprobePackets(rawFile).map(l => norm(l.trimEnd())), b = ffprobePackets(savedFile).map(l => norm(l.trimEnd()));
  const ca = count(a), cb = count(b);
  const onlyRaw = [...ca].filter(([l, n]) => (cb.get(l) || 0) < n).map(([l]) => l);
  const onlySaved = [...cb].filter(([l, n]) => (ca.get(l) || 0) < n).map(([l]) => l);
  return { rawPackets: a.length, savedPackets: b.length, identical: !onlyRaw.length && !onlySaved.length, onlyRaw: onlyRaw.slice(0, 5), onlySaved: onlySaved.slice(0, 5) };
}

/** What Windows itself reads from the file (Explorer → Properties → Details), through the Shell. */
export function windowsShell(file) {
  if (process.platform !== 'win32') return null;
  const ps = "$s = New-Object -ComObject Shell.Application; $f = $s.Namespace($env:FC_DIR).ParseName($env:FC_NAME); " +
    "if (-not $f) { 'missing'; exit 0 }; '{0}|{1}|{2}' -f $f.ExtendedProperty('System.Media.Duration'), $f.ExtendedProperty('System.Video.FrameWidth'), $f.ExtendedProperty('System.Video.FrameHeight')";
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    env: { ...process.env, FC_DIR: path.dirname(path.resolve(file)), FC_NAME: path.basename(file) }, encoding: 'utf8', timeout: 60_000,
  });
  const out = String(r.stdout || '').trim();
  if (r.status !== 0 || !out || out === 'missing') return { error: (r.stderr || out || `exit ${r.status}`).trim().slice(0, 300) };
  const [d, w, h] = out.split('|');
  return { durationS: d ? round(Number(d) / 1e7) : null, width: Number(w) || null, height: Number(h) || null };
}

/** Decode one frame at `at` seconds into a PNG (never overwriting), and the time of the frame decoded. */
function frameAt(file, at, png) {
  const r = spawnSync('ffmpeg', ['-v', 'info', '-nostats', '-n', '-ss', String(at), '-copyts', '-i', file, '-map', '0:v:0', '-frames:v', '1', '-vf', 'showinfo', png], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const m = (r.stderr || '').match(/showinfo.*\bn:\s*0\s.*\bpts_time:\s*(-?[\d.]+)/);
  return { t: m ? Number(m[1]) : null, saved: r.status === 0 };
}

/**
 * Everything about one saved take. `expect`: {durationS (what the app says), pauseAt (s
 * into the file where a pause was), controls: [{from, to, shown}] (times when the floating
 * controls must be in or out of the picture)}. Writes seek frames into `outDir` as `name`-seek-NN.png.
 */
export async function analyseTake(file, { outDir, name, expect = {}, raw = null } = {}) {
  const r = { file, probe: probe(file) };
  const isMp4 = /mp4|mov/.test(r.probe.container);
  r.layout = isMp4 ? mp4Layout(file) : null;
  r.decodeErrors = decodeErrors(file);
  r.windows = windowsShell(file);
  const frames = await videoFrames(file);
  const env = r.probe.audio ? audioEnvelope(file) : { rows: [], firstAudio: null };
  r.frames = { count: frames.length, first: frames[0]?.t ?? null, last: frames.at(-1)?.t ?? null };
  r.gaps = r.probe.audio ? gaps(file, frames) : null;
  r.loudness = r.probe.audio ? loudness(file) : null;
  r.digitalSilence = silentRuns(env.rows);
  if (raw) r.packets = samePackets(raw, file);

  // Flashes and clicks: thresholds from the whole take, reused after each seek.
  const vt = thresholds(frames.filter(f => f.magenta < SHOWN).map(f => f.luma), 40);
  const at = thresholds(env.rows.filter(x => x.db > -150).map(x => x.db), 15);
  const vrows = frames.map(f => ({ t: f.t, v: f.luma }));
  const arows = env.rows.map(x => ({ t: x.t, v: x.db }));
  const flashes = vt ? onsets(vrows, vt) : [];
  const clicks = at ? onsets(arows, at) : [];
  const all = pairs(flashes, clicks);
  r.sync = { videoThresholds: vt, audioThresholds: at, flashes: flashes.length, clicks: clicks.length, pairs: all, ...syncSummary(all, expect) };

  // Floating controls: magenta share of the frames in each window of time.
  r.controls = (expect.controls || []).map(w => {
    const inside = frames.filter(f => f.t >= w.from && f.t <= w.to);
    const bad = w.shown ? inside.filter(f => f.magenta < SHOWN) : inside.filter(f => f.magenta > CLEAN);
    return { ...w, from: Math.max(w.from, frames[0]?.t ?? 0), to: Math.min(w.to, frames.at(-1)?.t ?? 0), frames: inside.length, wrong: bad.length, maxMagenta: round(Math.max(0, ...inside.map(f => f.magenta)), 4), minMagenta: round(Math.min(1, ...inside.map(f => f.magenta)), 4), examples: bad.slice(0, 5).map(f => f.t) };
  });

  // Seeks at a quarter, half and three quarters: a frame there, clean decoding, and the same sync as in the whole take.
  const length = r.layout?.headerS || r.probe.durationS;
  r.seeks = [];
  for (const f of [0.25, 0.5, 0.75]) {
    const target = round(f * length, 2);
    const png = path.join(outDir, `${name}-seek-${Math.round(f * 100)}.png`);
    const frame = frameAt(file, target, png);
    const errors = decodeErrors(file, ['-ss', String(target), '-t', '3']);
    const seekEnv = r.probe.audio ? audioEnvelope(file, { from: target, duration: 8 }) : { rows: [], firstAudio: null };
    const seekFrames = await videoFrames(file, { from: target, duration: 8 });
    const after = vt && at ? pairs(onsets(seekFrames.map(x => ({ t: x.t, v: x.luma })), vt), onsets(seekEnv.rows.map(x => ({ t: x.t, v: x.db })), at)) : [];
    const matches = after.map(p => { const same = all.find(x => Math.abs(x.at - p.at) < 0.002); return { at: p.at, ms: p.ms, wholeMs: same?.ms ?? null }; });
    r.seeks.push({
      target, firstVideo: frame.t, firstAudio: seekEnv.firstAudio, png: frame.saved ? png : null, decodeErrors: errors,
      // 15 ms: the sound is measured in 5 ms steps, which start at a different sample after a seek.
      pairs: matches, syncKept: matches.length ? matches.every(m => m.wholeMs != null && Math.abs(m.ms - m.wholeMs) <= 15) : null,
    });
  }
  return r;
}

/** Runs of exact digital silence (the microphone delivering nothing) longer than 0.25 s. */
function silentRuns(rows) {
  const out = [];
  let start = null;
  for (const x of rows) {
    if (x.db <= -150) { if (start === null) start = x.t; continue; }
    if (start !== null && x.t - start > 0.25) out.push({ at: round(start), s: round(x.t - start) });
    start = null;
  }
  if (start !== null && rows.length && rows.at(-1).t - start > 0.25) out.push({ at: round(start), s: round(rows.at(-1).t - start) });
  return out;
}

/** Sync at the start, after a pause and at the end of a take, from flash/click pairs. */
export function syncSummary(all, { pauseAt = null } = {}) {
  if (all.length < 3) return { measured: false };
  const ms = all.map(p => p.ms);
  const pick = list => (list.length ? { pairs: list.length, medianMs: median(list.map(p => p.ms)) } : null);
  return {
    measured: true,
    medianMs: median(ms), minMs: Math.min(...ms), maxMs: Math.max(...ms), spreadMs: Math.max(...ms) - Math.min(...ms),
    start: pick(all.filter(p => p.at < all[0].at + 8)),
    afterPause: pauseAt == null ? null : pick(all.filter(p => p.at > pauseAt && p.at < pauseAt + 8)),
    end: pick(all.slice(-3)),
  };
}
