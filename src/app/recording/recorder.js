// One take: MediaRecorder -> crash journal + sink, with a pause-aware clock,
// chapter markers and a graceful end when anything goes wrong.
//
// Reliability rules (losing a lesson is the worst possible failure):
//  * Every chunk goes to the journal (IndexedDB) first, then to the sink.
//    Each destination has its own promise chain, so neither can reorder
//    chunks and a slow disk never holds up the safety copy (or vice versa).
//  * If the folder stops accepting data (disk full, permission revoked), the
//    take carries on and is saved from the journal (or from memory when there
//    is no journal) as a download instead.
//  * If MediaRecorder errors or screen sharing ends, the take stops on its
//    own and everything recorded so far is saved.
//  * The take holds a Web Lock for its lifetime so another tab never offers
//    it for recovery while it is still being recorded.

import { Emitter } from '../lib/emitter.js';
import { markerTitle } from '../lib/chapters.js';
import { formatClock } from '../lib/time.js';
import { patchWebmBlob } from '../media/webm.js';
import { finalizeMp4Blob } from '../media/mp4.js';
import { takeLockName } from './journal.js';
import { folderErrorMessage } from './folder.js';

export const TIMESLICE_MS = 1000;
export const FIRST_CHUNK_TIMEOUT_MS = 5000;
export const JOURNAL_UPDATE_MS = 2000;
export const TICK_MS = 500;
const STOP_TIMEOUT_MS = 10_000;
const LOCK_TIMEOUT_MS = 3000;
// Storage that doesn't answer must not leave the take "Starting…" forever.
const JOURNAL_TIMEOUT_MS = 3000;   // then the take runs without its safety copy
const SINK_TIMEOUT_MS = 5000;      // then the folder is skipped and the take downloads when stopped

/** Wait for `promise`, but no longer than `ms` (and don't leave the timer running). */
function within(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise(r => { timer = setTimeout(r, ms); })]).finally(() => clearTimeout(timer));
}
const newId = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
const SCREEN_GONE = 'The shared screen has gone. Choose a screen again, then press record.';

/** Tag an error with a `code` the caller can branch on (start(): 'sink' = the folder/sink couldn't be opened). */
function withCode(e, code) {
  const err = e instanceof Error ? e : new Error(String(e?.message || e));
  if (!err.code) {
    try { err.code = code; } catch { /* frozen: leave it */ }
  }
  return err;
}

/**
 * Pure: elapsed recording time, excluding pauses. Stopping while paused
 * does not count the pause. `now` is injectable for tests.
 */
export class Stopwatch {
  #now;
  #t0 = null;
  #pausedTotal = 0;
  #pausedAt = null;           // set while paused
  #stoppedAt = null;          // set once stopped

  constructor(now = () => performance.now()) { this.#now = now; }

  get started() { return this.#t0 !== null; }
  get paused() { return this.#pausedAt !== null && this.#stoppedAt === null; }
  get stopped() { return this.#stoppedAt !== null; }

  start() {
    this.#t0 = this.#now();
    this.#pausedTotal = 0;
    this.#pausedAt = null;
    this.#stoppedAt = null;
  }

  pause() {
    if (this.#t0 === null || this.#stoppedAt !== null || this.#pausedAt !== null) return;
    this.#pausedAt = this.#now();
  }

  resume() {
    if (this.#pausedAt === null || this.#stoppedAt !== null) return;
    this.#pausedTotal += this.#now() - this.#pausedAt;
    this.#pausedAt = null;
  }

  /** Freeze the clock. Stopped while paused, it stays at the moment of the pause. */
  stop() {
    if (this.#t0 === null || this.#stoppedAt !== null) return;
    this.#stoppedAt = this.#pausedAt ?? this.#now();
  }

  get elapsedMs() {
    if (this.#t0 === null) return 0;
    const end = this.#stoppedAt ?? this.#pausedAt ?? this.#now();
    return Math.max(0, end - this.#t0 - this.#pausedTotal);
  }
}

/**
 * Pure: combine chunk lists ([{seq, blob}] or Map seq -> blob) into one
 * ordered list of blobs. The first copy of a seq wins. `missing` lists the
 * seq numbers absent between 0 and the highest seq.
 * @returns {{parts: Blob[], missing: number[]}}
 */
export function mergeChunks(...lists) {
  const bySeq = new Map();
  for (const list of lists) {
    if (!list) continue;
    const entries = list instanceof Map ? [...list].map(([seq, blob]) => ({ seq, blob })) : list;
    for (const { seq, blob } of entries) if (blob && !bySeq.has(seq)) bySeq.set(seq, blob);
  }
  const seqs = [...bySeq.keys()].sort((a, b) => a - b);
  const missing = [];
  const max = seqs.length ? seqs[seqs.length - 1] : -1;
  for (let s = 0, i = 0; s <= max; s++) {
    if (seqs[i] === s) i++;
    else missing.push(s);
  }
  return { parts: seqs.map(s => bySeq.get(s)), missing };
}

function friendlyStartError(e) {
  const name = e?.name;
  let message;
  if (name === 'NotSupportedError') message = 'This browser can’t record in the chosen file type. Choose a different file type in Settings and try again.';
  else if (name === 'SecurityError' || name === 'NotAllowedError') message = 'The browser didn’t allow recording. Reload the page and choose your screen again.';
  else if (name === 'InvalidStateError') message = 'The shared screen or microphone stopped. Choose your screen again, then press record.';
  else message = `Recording couldn’t start${e?.message ? ` (${e.message})` : ''}. Reload the page and try again.`;
  const out = new Error(message);
  out.name = name || 'Error';
  out.cause = e;
  return out;
}

/**
 * @typedef {object} TakeResult
 * @property {string} id
 * @property {string} filename     final name (the folder may have added " (2)")
 * @property {'mp4'|'webm'} container
 * @property {string} mimeType     what MediaRecorder actually produced
 * @property {number} durationMs   excludes paused time
 * @property {number} size
 * @property {{id:string, atMs:number, title:string}[]} markers
 * @property {number} startedAt    Date.now() at the start (from meta)
 * @property {'folder'|'memory'} savedTo
 * @property {Blob} [blob]         when savedTo is 'memory'
 * @property {string} [folderName] when savedTo is 'folder'
 * @property {string} warning      '' or a teacher-facing note (e.g. the folder failed, so it downloads instead)
 * @property {null|'share-ended'|'error'} endedBy  why the take ended when the teacher didn't press stop
 */

export class TakeRecorder extends Emitter {
  // inputs
  #id; #videoTrack; #audioTrack; #options; #sink; #journal; #meta;
  #timesliceMs; #firstChunkTimeoutMs; #updateIntervalMs;
  // state
  #state = 'idle';
  #mr = null;
  #clock;
  #bytes = 0;
  #seq = 0;
  #markers = [];
  #filename = '';
  #container = 'webm';
  #mimeType = '';
  #journalOk = false;
  #sinkOk = true;
  #needBackup = true;
  #backup = new Map();         // seq -> blob: chunks the journal couldn't take (folder takes only)
  #journalChain = Promise.resolve();
  #sinkChain = Promise.resolve();
  #discarding = false;
  #sealed = false;             // after stop: late data is ignored
  #sinkError = null;
  #gotData = false;
  #endedBy = null;
  #mrStopped = null;           // resolves on MediaRecorder 'stop'
  #tickTimer = null;
  #watchdog = null;
  #lastUpdate = 0;
  #lock = null;                // { release, done, wanted }
  #startPromise = null;
  #ending = null;
  #result = null;
  #warnings = [];
  #startWarnings = [];
  #starting = false;
  #offTrack = null;

  /**
   * @param {object} o
   * @param {string} o.id
   * @param {MediaStreamTrack} o.videoTrack
   * @param {MediaStreamTrack|null} [o.audioTrack]
   * @param {object} o.options   recorderOptions(): {mimeType, container, ext, videoBitsPerSecond, audioBitsPerSecond, videoKeyFrameIntervalDuration}
   * @param {import('./sinks.js').MemorySink|import('./sinks.js').FolderSink} o.sink
   * @param {import('./journal.js').Journal|null} [o.journal]
   * @param {{lessonName?:string, filename?:string, startedAt?:number}} [o.meta]
   * @param {number} [o.timesliceMs]          MediaRecorder timeslice (1000)
   * @param {number} [o.firstChunkTimeoutMs]  warn when no data arrives within this (5000)
   * @param {number} [o.updateIntervalMs]     journal progress/heartbeat cadence (2000)
   * @param {() => number} [o.now]            clock for elapsed time (performance.now)
   */
  constructor({
    id, videoTrack, audioTrack = null, options = {}, sink, journal = null, meta = {},
    timesliceMs = TIMESLICE_MS, firstChunkTimeoutMs = FIRST_CHUNK_TIMEOUT_MS, updateIntervalMs = JOURNAL_UPDATE_MS,
    now = () => performance.now(),
  }) {
    super();
    this.#clock = new Stopwatch(now);
    this.#id = id || newId();
    this.#videoTrack = videoTrack;
    this.#audioTrack = audioTrack;
    this.#options = options || {};
    this.#sink = sink;
    this.#journal = journal || null;
    this.#meta = { startedAt: Date.now(), lessonName: '', ...meta };
    this.#timesliceMs = timesliceMs;
    this.#firstChunkTimeoutMs = firstChunkTimeoutMs;
    this.#updateIntervalMs = updateIntervalMs;
    this.#container = this.#options.container === 'mp4' ? 'mp4' : 'webm';
    this.#mimeType = this.#options.mimeType || '';
    this.#filename = this.#meta.filename || `Recording.${this.#options.ext || this.#container}`;
    this.#needBackup = sink?.kind !== 'memory';
  }

  get id() { return this.#id; }
  /** 'idle' | 'recording' | 'paused' | 'stopping' | 'stopped' | 'failed' */
  get state() { return this.#state; }
  /** Recorded time, excluding pauses. */
  get elapsedMs() { return Math.round(this.#clock.elapsedMs); }
  get bytes() { return this.#bytes; }
  get markers() { return this.#markers.map(m => ({ ...m })); }
  get mimeType() { return this.#mimeType; }
  get container() { return this.#container; }
  get filename() { return this.#filename; }
  /** Where the take will end up right now: 'folder' until the folder fails, else 'memory'. */
  get savingTo() { return this.#sink?.kind === 'folder' && this.#sinkOk ? 'folder' : 'memory'; }
  /** True while chunks are reaching the crash journal. */
  get safetyCopy() { return this.#journalOk; }
  /** Warnings so far (also emitted as 'warning'). */
  get warnings() { return [...this.#warnings]; }
  /** The TakeResult once stop() has finished, else null. */
  get result() { return this.#result; }

  // ------------------------------------------------------------------ start

  /**
   * Start recording (MediaRecorder.start(1000)). Rejects with a teacher-facing
   * message; `err.code === 'sink'` when the sink (the folder) couldn't be
   * opened, so only then is retrying with a MemorySink worthwhile.
   */
  start() {
    if (!this.#startPromise) {
      // stop()/cancel() already ran on this never-started take: starting now
      // would leave a recorder that nothing can stop.
      this.#startPromise = this.#ending
        ? Promise.reject(new Error('This take has already ended. Start a new take.'))
        : this.#start();
    }
    return this.#startPromise;
  }

  async #start() {
    if (this.#state !== 'idle') throw new Error('This take has already started.');
    this.#starting = true;
    try {
      const video = this.#videoTrack;
      if (!video || video.readyState === 'ended') throw withCode(new Error(SCREEN_GONE), 'screen-gone');
      if (typeof MediaRecorder === 'undefined') throw new Error('This browser can’t record video. Use Chrome or Edge.');
      const tracks = [video];
      if (this.#audioTrack && this.#audioTrack.readyState !== 'ended') tracks.push(this.#audioTrack);
      const mr = this.#createMediaRecorder(new MediaStream(tracks));

      await this.#acquireLock();
      try {
        if (this.#journal) {
          try {
            const begun = this.#journal.begin({
              id: this.#id, lessonName: this.#meta.lessonName || '', filename: this.#filename,
              container: this.#container, mimeType: this.#mimeType, startedAt: this.#meta.startedAt,
            }).then(() => true);
            // An entry that lands late has no chunks; the next visit cleans it up (Journal.listPending).
            if (await within(begun, JOURNAL_TIMEOUT_MS)) this.#journalOk = true;
            else this.#warn('Crash protection isn’t available for this take, because the browser’s storage didn’t answer in time. The take is still saved when you stop.', 'no-journal');
          } catch (e) {
            console.warn('journal.begin failed', e);
            this.#warn('Crash protection isn’t available for this take, because the browser’s storage can’t be used. The take is still saved when you stop.', 'no-journal');
          }
        } else {
          this.#warn('Crash protection isn’t available in this browser window (private windows block it). The take is still saved when you stop.', 'no-journal');
        }
        const opened = this.#sink.open({ filename: this.#filename, container: this.#container, mimeType: this.#mimeType }).then(() => true);
        let open;
        try {
          open = await within(opened, SINK_TIMEOUT_MS);
        } catch (e) {
          throw withCode(e, 'sink');
        }
        if (!open) {
          // If the file does open later, it is removed again (nothing will be written to it).
          opened.then(() => this.#sink.abort?.(), () => {}).catch(() => {});
          throw withCode(new Error('Your lessons folder didn’t answer in time.'), 'sink');
        }
        if (this.#sink.filename) this.#filename = this.#sink.filename;
        // "Stop sharing" may have been pressed while the lock, journal and
        // file were being set up. Its 'ended' event has already fired, so the
        // listener below would never hear it and the take would run on, with
        // no picture, until the teacher noticed.
        if (video.readyState === 'ended') throw withCode(new Error(SCREEN_GONE), 'screen-gone');

        this.#mr = mr;
        this.#mrStopped = new Promise(resolve => mr.addEventListener('stop', () => resolve(), { once: true }));
        mr.addEventListener('dataavailable', e => this.#guard(() => this.#onData(e.data)));
        mr.addEventListener('error', e => this.#guard(() => this.#onRecorderError(e)));
        mr.addEventListener('stop', () => this.#guard(() => this.#onRecorderStopped()));
        try {
          mr.start(this.#timesliceMs);
        } catch (e) {
          throw friendlyStartError(e);
        }
      } catch (e) {
        await this.#undoStart();
        throw e;
      }

      this.#clock.start();
      // Before start() Chrome echoes the requested type; afterwards it is the real one.
      this.#mimeType = mr.mimeType || this.#mimeType;
      const onEnded = () => this.#guard(() => this.#onTrackEnded());
      video.addEventListener('ended', onEnded);
      this.#offTrack = () => video.removeEventListener('ended', onEnded);
      this.#tickTimer = setInterval(() => this.#guard(() => { this.#emitTick(); this.#maybeUpdate(); }), TICK_MS);
      this.#armWatchdog(this.#firstChunkTimeoutMs);
      this.#lastUpdate = performance.now();
      this.#setState('recording');
    } catch (e) {
      this.#state = 'failed';
      throw e;
    } finally {
      this.#starting = false;
      // Listeners are attached after start() resolves; deliver early warnings then.
      const early = this.#startWarnings.splice(0);
      if (early.length) setTimeout(() => early.forEach(w => this.emit('warning', w)), 0);
    }
  }

  #createMediaRecorder(stream) {
    const o = this.#options;
    const full = {};
    if (o.mimeType) full.mimeType = o.mimeType;
    if (o.videoBitsPerSecond) full.videoBitsPerSecond = o.videoBitsPerSecond;
    if (o.audioBitsPerSecond) full.audioBitsPerSecond = o.audioBitsPerSecond;
    // MP4 only emits data at keyframes: without this the safety copy could stay empty for minutes.
    if (o.videoKeyFrameIntervalDuration) full.videoKeyFrameIntervalDuration = o.videoKeyFrameIntervalDuration;
    try {
      return new MediaRecorder(stream, full);
    } catch (first) {
      if (!o.mimeType) throw friendlyStartError(first);
      try {
        return new MediaRecorder(stream, { mimeType: o.mimeType });
      } catch (e) {
        throw friendlyStartError(e);
      }
    }
  }

  /** Undo a half-finished start so the same id can be retried with another sink. */
  async #undoStart() {
    try { await this.#sink?.abort?.(); } catch { /* nothing written */ }
    if (this.#journal && this.#journalOk) {
      try { await this.#journal.discard(this.#id); } catch { /* ignore */ }
    }
    this.#journalOk = false;
    await this.#dropLock();
  }

  // ------------------------------------------------------------- lock

  async #acquireLock() {
    const locks = globalThis.navigator?.locks;
    if (!locks?.request) return;
    const lock = { release: null, done: null, wanted: true };
    let granted;
    const got = new Promise(r => { granted = r; });
    lock.done = locks.request(takeLockName(this.#id), () => {
      granted(true);
      // Abandoned while we waited: let go straight away.
      if (!lock.wanted) return undefined;
      return new Promise(r => { lock.release = r; });
    }).catch(() => granted(false));
    this.#lock = lock;
    // A lock nobody else should hold; don't wait forever if something is odd.
    await within(got, LOCK_TIMEOUT_MS);
  }

  async #dropLock() {
    const lock = this.#lock;
    if (!lock) return;
    this.#lock = null;
    lock.wanted = false;
    lock.release?.();
    // Wait until the lock is really free, so a retry can take it at once.
    await within(lock.done, 1000);
  }

  // ------------------------------------------------------------- recording

  #guard(fn) {
    try { fn(); } catch (e) { console.error('recorder handler failed', e); }
  }

  #setState(state, extra = {}) {
    this.#state = state;
    this.emit('state', { state, ...extra });
  }

  #warn(message, code = '') {
    const w = { message, code };
    this.#warnings.push(w);
    if (this.#starting) this.#startWarnings.push(w);
    else this.emit('warning', w);
  }

  #emitTick() {
    if (this.#state !== 'recording' && this.#state !== 'paused') return;
    this.emit('tick', { elapsedMs: this.elapsedMs, bytes: this.#bytes });
  }

  #onData(blob) {
    if (!blob || !blob.size || this.#discarding || this.#sealed) return;
    const seq = this.#seq++;
    this.#bytes += blob.size;
    this.#gotData = true;
    // Journal first, then the sink; each in its own queue.
    this.#journalChain = this.#journalChain.then(() => this.#toJournal(seq, blob));
    this.#sinkChain = this.#sinkChain.then(() => this.#toSink(blob));
    this.#emitTick();
    this.#maybeUpdate();
  }

  async #toJournal(seq, blob) {
    if (this.#journalOk) {
      try {
        await this.#journal.append(this.#id, seq, blob);
        return;
      } catch (e) {
        console.warn('journal.append failed', e);
        this.#journalOk = false;
        const full = e?.name === 'QuotaExceededError' || /quota/i.test(e?.message || '');
        this.#warn(full
          ? 'Crash protection has stopped because the browser’s storage is full. Keep going: the take is still saved when you stop. Free up disk space before the next lesson.'
          : 'Crash protection has stopped for this take. Keep going: the take is still saved when you stop.', 'journal-failed');
      }
    }
    // Without a journal, a folder take keeps its own copy so a failing folder can't lose it.
    if (this.#needBackup) this.#backup.set(seq, blob);
  }

  async #toSink(blob) {
    if (!this.#sinkOk) return;
    try {
      await this.#sink.write(blob);
    } catch (e) {
      this.#sinkFailed(e);
    }
  }

  /** live: the take is still running (say so and keep going); otherwise it failed while saving. */
  #sinkFailed(e, { live = true } = {}) {
    if (!this.#sinkOk) return;
    console.warn('sink failed', e);
    this.#sinkOk = false;
    this.#sinkError = e;
    // Once Stop was pressed, "keep recording" would be wrong (and the saved
    // take's `warning` already explains it): no live error then.
    if (!live || (this.#state !== 'recording' && this.#state !== 'paused')) return;
    const folder = this.#sink?.kind === 'folder';
    this.emit('error', {
      fatal: false,
      code: 'folder-failed',
      savingTo: 'memory',
      message: folder
        ? `${folderErrorMessage(e?.cause || e, this.#sink.folderName || '')} Keep recording: this take will download to your Downloads folder when you stop.`
        : 'Part of this take couldn’t be kept in memory. Keep recording: it will be rebuilt from the safety copy when you stop.',
    });
  }

  #maybeUpdate(force = false) {
    if (!this.#journalOk || (this.#state !== 'recording' && this.#state !== 'paused')) return;
    const now = performance.now();
    if (!force && now - this.#lastUpdate < this.#updateIntervalMs) return;
    this.#lastUpdate = now;
    this.#journal.update(this.#id, { elapsedMs: this.elapsedMs, bytes: this.#bytes, markers: this.markers })
      .catch(e => console.warn('journal.update failed', e));
  }

  #armWatchdog(ms) {
    clearTimeout(this.#watchdog);
    this.#watchdog = setTimeout(() => this.#guard(() => {
      if (this.#gotData || (this.#state !== 'recording' && this.#state !== 'paused')) return;
      // Paused before anything arrived: check again once recording resumes.
      if (this.#state === 'paused') { this.#armWatchdog(ms); return; }
      this.#warn('Crash protection isn’t working for this take: no video has reached the safety copy yet. Keep going; if this message comes back, switch the file type in Settings.', 'no-data');
    }), ms);
  }

  /** Stop on our own; the caller (session) gets the same promise from stop(). */
  #stopFromEvent(endedBy) {
    this.#endedBy = endedBy;
    this.stop().catch(() => { /* reported to whoever awaits stop() */ });
  }

  #onTrackEnded() {
    if (this.#ending || (this.#state !== 'recording' && this.#state !== 'paused')) return;
    const at = formatClock(this.elapsedMs);
    this.#stopFromEvent('share-ended');
    this.emit('error', {
      fatal: true,
      code: 'share-ended',
      message: `Screen sharing ended, so the recording stopped. Everything up to ${at} is being saved.`,
    });
  }

  #onRecorderError(e) {
    if (this.#ending || (this.#state !== 'recording' && this.#state !== 'paused')) return;
    const at = formatClock(this.elapsedMs);
    const detail = e?.error?.message || e?.error?.name || '';
    this.#stopFromEvent('error');
    this.emit('error', {
      fatal: true,
      code: 'recorder-error',
      message: `The browser stopped recording unexpectedly${detail ? ` (${detail})` : ''}. Everything up to ${at} is being saved.`,
    });
  }

  #onRecorderStopped() {
    // MediaRecorder stopped by itself (e.g. every track ended): save what we have.
    if (this.#ending || (this.#state !== 'recording' && this.#state !== 'paused')) return;
    const at = formatClock(this.elapsedMs);
    this.#stopFromEvent(this.#videoTrack?.readyState === 'ended' ? 'share-ended' : 'error');
    this.emit('error', {
      fatal: true,
      code: this.#endedBy === 'share-ended' ? 'share-ended' : 'recorder-error',
      message: this.#endedBy === 'share-ended'
        ? `Screen sharing ended, so the recording stopped. Everything up to ${at} is being saved.`
        : `The recording stopped unexpectedly. Everything up to ${at} is being saved.`,
    });
  }

  // ------------------------------------------------------------- controls

  /** Pause recording. Returns false when not recording. */
  pause() {
    if (this.#state !== 'recording' || !this.#mr) return false;
    try {
      // Flush what's buffered so the safety copy is complete up to the pause.
      if (this.#container === 'webm') this.#mr.requestData();
    } catch { /* optional */ }
    try { this.#mr.pause(); } catch (e) { console.warn('pause failed', e); return false; }
    this.#clock.pause();
    this.#setState('paused');
    this.#maybeUpdate(true);
    return true;
  }

  /** Resume after pause(). Returns false when not paused. */
  resume() {
    if (this.#state !== 'paused' || !this.#mr) return false;
    try { this.#mr.resume(); } catch (e) { console.warn('resume failed', e); return false; }
    this.#clock.resume();
    this.#setState('recording');
    this.#maybeUpdate(true);
    return true;
  }

  /**
   * Drop a chapter marker at the current recorded time (pauses excluded).
   * Returns null when no take is running.
   */
  addMarker(title) {
    if (this.#state !== 'recording' && this.#state !== 'paused') return null;
    const m = {
      id: newId(),
      atMs: this.elapsedMs,
      title: String(title ?? '').trim().slice(0, 100) || markerTitle(this.#markers.length + 1),
    };
    this.#markers.push(m);
    this.#maybeUpdate(true);
    return { ...m };
  }

  // ------------------------------------------------------------- ending

  /** Stop and save. Idempotent: later calls return the same promise. */
  stop() {
    if (!this.#ending) this.#ending = this.#stop();
    return this.#ending;
  }

  /** Stop and throw everything away (file, journal entry). Idempotent like stop(). */
  cancel() {
    if (!this.#ending) this.#ending = this.#cancel();
    return this.#ending;
  }

  async #halt(reason) {
    this.#clock.stop();
    this.#setState('stopping', { reason });
    clearInterval(this.#tickTimer);
    clearTimeout(this.#watchdog);
    this.#offTrack?.();
    this.#offTrack = null;
    const mr = this.#mr;
    if (mr && mr.state !== 'inactive') {
      try { mr.stop(); } catch (e) { console.warn('MediaRecorder.stop failed', e); }
    }
    // 'stop' fires after the final 'dataavailable', so every chunk is queued after this.
    if (this.#mrStopped) await within(this.#mrStopped, STOP_TIMEOUT_MS);
    this.#sealed = true;
    await this.#journalChain;
    await this.#sinkChain;
  }

  async #stop() {
    if (this.#startPromise) {
      try { await this.#startPromise; } catch { return null; }
    }
    if (this.#state !== 'recording' && this.#state !== 'paused') return this.#result;

    await this.#halt(this.#endedBy || 'user');
    const durationMs = this.elapsedMs;

    if (!this.#bytes) {
      await this.#undoStart();
      this.#setState('failed');
      const e = new Error('Nothing was recorded: the browser didn’t deliver any video. Choose your screen again and start a new take.');
      e.code = 'empty';
      throw e;
    }

    let out = null;
    let warning = '';
    if (this.#sinkOk) {
      try {
        out = await this.#sink.finalize({ durationMs });
      } catch (e) {
        this.#sinkFailed(e, { live: false });
      }
    }
    let missing = 0;
    if (!out) {
      let blob;
      try {
        ({ blob, missing } = await this.#assembleFallback(durationMs));
      } catch (e) {
        // Keep the journal entry: after a reload it is offered for recovery.
        console.error('fallback assembly failed', e);
        // The folder file never got its data (Chrome commits only on close()),
        // so don't leave an empty file or an open writable behind.
        if (this.#sink?.kind === 'folder') {
          try { await this.#sink.abort(); } catch { /* the partial file may remain */ }
        }
        this.#backup.clear();
        await this.#dropLock();
        this.#setState('failed');
        throw new Error('This take couldn’t be saved. Reload the page: Full Capture will offer to recover it.');
      }
      out = { savedTo: 'memory', blob, size: blob.size, filename: this.#filename };
      if (this.#sink?.kind === 'folder') {
        const why = this.#sinkError ? `${folderErrorMessage(this.#sinkError?.cause || this.#sinkError, this.#sink.folderName || '')} ` : '';
        warning = `${why}This take was saved to your Downloads folder instead.`;
        try { await this.#sink.abort(); } catch { /* the partial file may remain */ }
      }
    }
    if (missing) warning = [warning, 'A few seconds of this take couldn’t be saved.'].filter(Boolean).join(' ');

    // Journal bookkeeping before the lock goes, so no tab sees a half-finished state.
    if (this.#journal) {
      try {
        if (out.savedTo === 'memory' && this.#journalOk) {
          await this.#journal.update(this.#id, { elapsedMs: durationMs, bytes: this.#bytes, markers: this.markers, filename: out.filename });
          await this.#journal.complete(this.#id, { keep: true });
          await this.#journal.prune({ exceptId: this.#id });
        } else {
          // Saved in the folder, or the safety copy is incomplete: don't keep it.
          await this.#journal.complete(this.#id);
        }
      } catch (e) {
        console.warn('journal bookkeeping failed', e);
      }
    }
    this.#backup.clear();
    await this.#dropLock();

    if (warning) this.#warn(warning, 'saved-elsewhere');
    this.#result = {
      id: this.#id,
      filename: out.filename || this.#filename,
      container: this.#container,
      mimeType: this.#mimeType,
      durationMs,
      size: out.size,
      markers: this.markers,
      startedAt: this.#meta.startedAt,
      savedTo: out.savedTo === 'folder' ? 'folder' : 'memory',
      blob: out.blob,
      folderName: out.folderName || '',
      warning,
      endedBy: this.#endedBy,
    };
    this.#setState('stopped');
    return this.#result;
  }

  /** Rebuild the take from the journal plus any chunks held in memory. Resolves {blob, missing}. */
  async #assembleFallback(durationMs) {
    let stored = [];
    if (this.#journal) {
      try { stored = await this.#journal.chunks(this.#id); } catch (e) { console.warn('journal read failed', e); }
    }
    const { parts, missing } = mergeChunks(stored, this.#backup);
    if (!parts.length || missing.includes(0)) throw new Error('no recoverable data');
    const type = this.#mimeType || (this.#container === 'mp4' ? 'video/mp4' : 'video/webm');
    let blob = new Blob(parts, { type });
    if (this.#container === 'webm' && durationMs > 0) blob = await patchWebmBlob(blob, durationMs);
    if (this.#container === 'mp4') blob = (await finalizeMp4Blob(blob, { partial: true })).blob;
    return { blob, missing: missing.length };
  }

  async #cancel() {
    if (this.#startPromise) {
      try { await this.#startPromise; } catch { return null; }
    }
    if (this.#state !== 'recording' && this.#state !== 'paused') return null;
    this.#discarding = true;
    await this.#halt('cancel');
    this.#backup.clear();
    try { await this.#sink.abort(); } catch (e) { console.warn('sink.abort failed', e); }
    if (this.#journal) {
      try { await this.#journal.discard(this.#id); } catch (e) { console.warn('journal.discard failed', e); }
    }
    this.#journalOk = false;
    await this.#dropLock();
    this.#setState('stopped', { cancelled: true });
    return null;
  }
}
