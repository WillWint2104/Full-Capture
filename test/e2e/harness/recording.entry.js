// Browser harness for the recording subsystem. Exposes the modules on
// window.rec and helpers on window.kit: fake screen + mic tracks, recorder
// options, a <video> probe that checks a file really plays, header/tail
// duration readers, raw journal rows, and a v1-shaped legacy database.
import { TakeRecorder, Stopwatch, mergeChunks } from '../../../src/app/recording/recorder.js';
import { MemorySink, FolderSink } from '../../../src/app/recording/sinks.js';
import { Journal, findLegacyRecording, takeLockName, webmEndMs } from '../../../src/app/recording/journal.js';
import { FolderStore } from '../../../src/app/recording/folder.js';
import { TakesLibrary } from '../../../src/app/recording/takes.js';
import { detectFormats, recorderOptions } from '../../../src/app/media/formats.js';
import { locateInfo } from '../../../src/app/media/webm.js';
import { tx } from '../../../src/app/lib/idb.js';
import { createFakeDirectory } from './recording-fakefs.entry.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
let counter = 0;

const live = [];

/** Fake screen (getDisplayMedia) + fake mic (getUserMedia). */
async function tracks() {
  const screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
  const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
  const video = screen.getVideoTracks()[0];
  const audio = mic.getAudioTracks()[0];
  live.push(video, audio);
  return { video, audio };
}

function stopTracks() {
  for (const t of live.splice(0)) t.stop();
}

function options(format = 'webm') {
  return recorderOptions({ format, width: 640, height: 360, fps: 30, supported: detectFormats() });
}

/** A TakeRecorder wired like the session does. */
async function newTake({ sink = 'memory', store = null, journal = undefined, filename, id, ...rest } = {}) {
  const t = await tracks();
  const o = options('webm');
  const j = journal === undefined ? await Journal.open() : journal;
  const theId = id || `take-${Date.now()}-${++counter}`;
  const s = sink === 'folder' ? new FolderSink(store) : sink === 'memory' ? new MemorySink() : sink;
  const recorder = new TakeRecorder({
    id: theId, videoTrack: t.video, audioTrack: t.audio, options: o, sink: s, journal: j,
    meta: { lessonName: 'Fractions', filename: filename || `Fractions ${theId}.${o.ext}`, startedAt: Date.now() }, ...rest,
  });
  const events = [];
  for (const type of ['state', 'warning', 'error']) recorder.on(type, d => events.push({ type, ...d }));
  window.current = { recorder, events, journal: j, tracks: t, id: theId };
  return window.current;
}

/** Load a recording into a <video>, check it plays and report its duration (seconds). */
async function probe(blobOrBytes, { type = 'video/webm' } = {}) {
  const blob = blobOrBytes instanceof Blob ? blobOrBytes : new Blob([blobOrBytes], { type });
  const url = URL.createObjectURL(blob);
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'auto';
  document.body.appendChild(v);
  const once = (el, ...names) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${names.join('/')}`)), 10_000);
    for (const n of names) el.addEventListener(n, e => { clearTimeout(timer); resolve(e.type); }, { once: true });
  });
  try {
    v.src = url;
    const ev = await once(v, 'loadedmetadata', 'error');
    if (ev === 'error') return { error: v.error?.message || `media error ${v.error?.code}` };
    const duration = v.duration;
    const out = { duration, width: v.videoWidth, height: v.videoHeight, error: null };
    // Seek near the end and decode a frame there: the file is really playable, not just a header.
    if (Number.isFinite(duration) && duration > 0.5) {
      v.currentTime = Math.max(0, duration - 0.3);
      const s = await once(v, 'seeked', 'error');
      if (s === 'error') out.error = v.error?.message || 'seek error';
      out.seekedTo = v.currentTime;
      try { await v.play(); await sleep(150); v.pause(); out.played = true; } catch (e) { out.played = false; out.playError = e.message; }
    }
    return out;
  } finally {
    v.remove();
    URL.revokeObjectURL(url);
  }
}

/** Duration written in a WebM header, in ms (or null). */
async function headerDurationMs(blobOrBytes) {
  const bytes = blobOrBytes instanceof Blob ? new Uint8Array(await blobOrBytes.slice(0, 65536).arrayBuffer()) : blobOrBytes.subarray(0, 65536);
  const l = locateInfo(bytes);
  if (!l.duration) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset + l.duration.offset, l.duration.size);
  return (l.duration.size === 8 ? dv.getFloat64(0) : dv.getFloat32(0)) * l.timecodeScale / 1e6;
}

/** Raw journal contents. */
async function journalRows() {
  const metas = await tx('journalMeta', 'readonly', s => s.journalMeta.getAll());
  const chunks = await tx('journalChunks', 'readonly', s => s.journalChunks.getAllKeys());
  return { metas, chunkKeys: chunks };
}

async function legacyExists() {
  return (await indexedDB.databases()).some(d => d.name === 'lessonRecorderDB');
}

/** Record a few seconds with a bare MediaRecorder, like v1 did. */
async function rawChunks(ms = 2000) {
  const t = await tracks();
  const mr = new MediaRecorder(new MediaStream([t.video, t.audio]), { mimeType: 'video/webm;codecs=vp8,opus' });
  const parts = [];
  mr.ondataavailable = e => { if (e.data.size) parts.push(e.data); };
  const stopped = new Promise(r => { mr.onstop = r; });
  mr.start(500);
  await sleep(ms);
  mr.stop();
  await stopped;
  return parts;
}

/** Create v1's database exactly as v13 did and leave an unfinished recording in it. */
function makeLegacy({ parts, meta }) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('lessonRecorderDB', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('chunks', { autoIncrement: true });
      db.createObjectStore('meta');
    };
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const t = db.transaction(['chunks', 'meta'], 'readwrite');
      for (const p of parts) t.objectStore('chunks').add(p);
      if (meta) t.objectStore('meta').put(meta, 'current');
      t.oncomplete = () => { db.close(); resolve(); };
      t.onerror = () => reject(t.error);
    };
  });
}

window.rec = { TakeRecorder, Stopwatch, mergeChunks, MemorySink, FolderSink, Journal, findLegacyRecording, takeLockName, webmEndMs, FolderStore, TakesLibrary, createFakeDirectory };
window.kit = { sleep, tracks, stopTracks, options, newTake, probe, headerDurationMs, journalRows, legacyExists, rawChunks, makeLegacy };
