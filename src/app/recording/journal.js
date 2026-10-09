// Crash recovery. Every recorded chunk is written to IndexedDB as it arrives,
// so if the tab crashes, the laptop sleeps for good or the teacher closes the
// window by mistake, the next visit can rebuild the recording.
//
//   journalMeta   { id, lessonName, filename, container, mimeType, startedAt,
//                   status: 'recording'|'downloaded', elapsedMs, bytes, markers,
//                   heartbeatAt, completedAt? }
//   journalChunks { id, seq, blob, size }        key [id, seq]
//
// A take still being recorded in another tab must never be offered for
// recovery (or deleted). Each recording tab holds a Web Lock named
// takeLockName(id) for the take's lifetime; a take whose lock is free is
// orphaned. Without Web Locks a 10 s heartbeat (meta.heartbeatAt) decides.

import { tx, openDb } from '../lib/idb.js';
import { patchWebmBlob, lastTimestampMs, readTimecodeScale } from '../media/webm.js';
import { finalizeMp4Blob } from '../media/mp4.js';

export const HEARTBEAT_STALE_MS = 10_000;
/** How much of the end of a recording is scanned for its last timestamp. */
export const TAIL_BYTES = 2 * 1024 * 1024;
const HEAD_BYTES = 64 * 1024;

/** Web Lock held by the tab recording take `id`. */
export const takeLockName = id => `full-capture-take:${id}`;

/** Pure: is a take with this meta abandoned, judged by its heartbeat alone? */
export function isStale(meta, now = Date.now(), staleMs = HEARTBEAT_STALE_MS) {
  const beat = Number(meta?.heartbeatAt) || Number(meta?.startedAt) || 0;
  return now - beat > staleMs;
}

/** Pure: the MIME type to give an assembled recording. */
export function blobTypeFor(meta) {
  if (meta?.mimeType) return meta.mimeType;
  if (meta?.mime) return meta.mime; // v1 meta
  return meta?.container === 'mp4' ? 'video/mp4' : 'video/webm';
}

const isWebm = type => /webm/i.test(type || '');
const isMp4 = type => /mp4/i.test(type || '');

/**
 * Where a (possibly cut-off) WebM recording ends, from the timestamps in its
 * last ~2 MB; null when it can't be read.
 */
export async function webmEndMs(blob, { tailBytes = TAIL_BYTES } = {}) {
  if (!blob?.size) return null;
  try {
    const head = new Uint8Array(await blob.slice(0, Math.min(HEAD_BYTES, blob.size)).arrayBuffer());
    const scale = readTimecodeScale(head);
    const tail = new Uint8Array(await blob.slice(Math.max(0, blob.size - tailBytes)).arrayBuffer());
    const ms = lastTimestampMs(tail, scale);
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  } catch {
    return null;
  }
}

/**
 * Join chunk blobs into one playable file. WebM gets a Duration: from the
 * recording's own timestamps, else `fallbackMs`. MP4 gets an index of every
 * sample it holds, even when its last fragment was cut off.
 * @returns {Promise<{blob: Blob, durationMs: number}>}
 */
export async function buildRecording(parts, type, fallbackMs = 0) {
  let blob = new Blob(parts, { type });
  let durationMs = Math.max(0, Number(fallbackMs) || 0);
  if (isWebm(type) && blob.size) {
    const end = await webmEndMs(blob);
    if (end) durationMs = end;
    if (durationMs > 0) blob = await patchWebmBlob(blob, durationMs);
  }
  if (isMp4(type) && blob.size) {
    const mp4 = await finalizeMp4Blob(blob, { partial: true });
    blob = mp4.blob;
    if (mp4.finalized && mp4.durationMs > 0) durationMs = mp4.durationMs;
  }
  return { blob, durationMs: Math.round(durationMs) };
}

const chunkRange = id => IDBKeyRange.bound([id, -Infinity], [id, Infinity]);

/** Resolve with whether `name` is free right now (and release it straight away). */
async function lockIsFree(name) {
  const locks = globalThis.navigator?.locks;
  if (!locks?.request) return null;
  try {
    return await locks.request(name, { ifAvailable: true }, lock => !!lock);
  } catch {
    return null;
  }
}

export class Journal {
  /** @returns {Promise<Journal|null>} null when IndexedDB is unavailable. */
  static async open() {
    const db = await openDb();
    return db ? new Journal() : null;
  }

  /** Start journaling a take. meta: {id, lessonName, filename, container, mimeType, startedAt}. */
  async begin(meta) {
    if (!meta?.id) throw new Error('journal.begin needs an id');
    const row = {
      lessonName: '', filename: '', container: 'webm', mimeType: '', startedAt: Date.now(),
      ...meta,
      status: 'recording', elapsedMs: 0, bytes: 0, markers: [], heartbeatAt: Date.now(),
    };
    await tx(['journalMeta', 'journalChunks'], 'readwrite', s => {
      // A reused id (a retried start) must not inherit old chunks.
      s.journalChunks.delete(chunkRange(meta.id));
      s.journalMeta.put(row);
    });
  }

  /** Store chunk number `seq` of take `id`. */
  async append(id, seq, blob) {
    await tx('journalChunks', 'readwrite', s => { s.journalChunks.put({ id, seq, blob, size: blob.size }); });
  }

  /** Merge progress into the take's meta and stamp the heartbeat. patch: {elapsedMs, bytes, markers, ...}. */
  async update(id, patch = {}) {
    await tx('journalMeta', 'readwrite', s => {
      const r = s.journalMeta.get(id);
      r.onsuccess = () => {
        if (r.result) s.journalMeta.put({ ...r.result, ...patch, id, heartbeatAt: Date.now() });
      };
    });
  }

  /**
   * The take is saved. keep=false (it's in the folder): forget it entirely.
   * keep=true (handed over as a download, which can't be confirmed): keep the
   * chunks as a safety copy, marked 'downloaded', until prune().
   */
  async complete(id, { keep = false } = {}) {
    if (!keep) return this.discard(id);
    await tx('journalMeta', 'readwrite', s => {
      const r = s.journalMeta.get(id);
      r.onsuccess = () => {
        if (r.result) s.journalMeta.put({ ...r.result, status: 'downloaded', completedAt: Date.now(), heartbeatAt: Date.now() });
      };
    });
  }

  /**
   * Delete the 'downloaded' safety copies that `exceptId` supersedes: every
   * one except it and any completed after it. (Two tabs saving at once must
   * not delete each other's fresh copy; the later prune removes the older.)
   */
  async prune({ exceptId } = {}) {
    const metas = await this.#allMeta();
    const keep = exceptId == null ? null : metas.find(m => m.id === exceptId);
    const cutoff = Number(keep?.completedAt) || Infinity;
    const doomed = metas
      .filter(m => m.status === 'downloaded' && m.id !== exceptId && !(Number(m.completedAt) > cutoff))
      .map(m => m.id);
    for (const id of doomed) await this.discard(id);
    return doomed;
  }

  /**
   * Unfinished takes that no tab is recording any more, newest first.
   * A take with no chunks has nothing to recover and is cleaned up.
   * @param {{staleMs?: number, useLocks?: boolean}} [opts]
   * @returns {Promise<{meta: object, chunks: number, bytes: number}[]>}
   */
  async listPending({ staleMs = HEARTBEAT_STALE_MS, useLocks = true } = {}) {
    const metas = (await this.#allMeta()).filter(m => m.status === 'recording');
    const out = [];
    for (const meta of metas) {
      const free = useLocks ? await lockIsFree(takeLockName(meta.id)) : null;
      // free === null: no Web Locks, so trust the heartbeat.
      if (free === false || (free === null && !isStale(meta, Date.now(), staleMs))) continue;
      const { chunks, bytes } = await this.#chunkStats(meta.id);
      if (!chunks) { await this.discard(meta.id).catch(() => {}); continue; }
      out.push({ meta, chunks, bytes });
    }
    return out.sort((a, b) => (b.meta.startedAt || 0) - (a.meta.startedAt || 0));
  }

  /** Safety copies of downloaded takes ('downloaded'), newest first. */
  async listKept() {
    return (await this.#allMeta())
      .filter(m => m.status === 'downloaded')
      .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  }

  /** The take's meta row, or null. */
  async getMeta(id) {
    return (await tx('journalMeta', 'readonly', s => s.journalMeta.get(id))) || null;
  }

  /** The stored chunks of a take in recording order: [{seq, blob}]. */
  async chunks(id) {
    const rows = await tx('journalChunks', 'readonly', s => s.journalChunks.getAll(chunkRange(id)));
    return (rows || []).sort((a, b) => a.seq - b.seq).map(r => ({ seq: r.seq, blob: r.blob }));
  }

  /** Rebuild the take as one playable file. */
  async assemble(id) {
    return (await this.assembleInfo(id)).blob;
  }

  /**
   * Like assemble(), and also report the duration written into the file.
   * @returns {Promise<{blob: Blob, durationMs: number, meta: object}>}
   */
  async assembleInfo(id) {
    const meta = await this.getMeta(id);
    if (!meta) throw new Error('This recording is no longer stored in the browser.');
    const rows = await this.chunks(id);
    if (!rows.length) throw new Error('Nothing of this recording was stored, so there is nothing to recover.');
    const { blob, durationMs } = await buildRecording(rows.map(r => r.blob), blobTypeFor(meta), meta.elapsedMs);
    return { blob, durationMs, meta };
  }

  /** Forget a take: its chunks and its meta. */
  async discard(id) {
    await tx(['journalMeta', 'journalChunks'], 'readwrite', s => {
      s.journalChunks.delete(chunkRange(id));
      s.journalMeta.delete(id);
    });
  }

  /** Browser storage use and limit, or null when unknown. */
  async estimate() {
    try {
      const est = await globalThis.navigator?.storage?.estimate?.();
      return est ? { usage: est.usage || 0, quota: est.quota || 0 } : null;
    } catch {
      return null;
    }
  }

  async #allMeta() {
    return (await tx('journalMeta', 'readonly', s => s.journalMeta.getAll())) || [];
  }

  async #chunkStats(id) {
    // Rows hold Blob references, not the bytes, so this stays cheap for long takes.
    const rows = await tx('journalChunks', 'readonly', s => s.journalChunks.getAll(chunkRange(id)));
    let bytes = 0;
    for (const r of rows || []) bytes += r.size ?? r.blob?.size ?? 0;
    return { chunks: (rows || []).length, bytes };
  }
}

// ------------------------------------------------------------------ legacy v1

const LEGACY_DB = 'lessonRecorderDB';

/** Open v1's database only if it already exists (opening would otherwise create it). */
async function openLegacyDb() {
  const factory = globalThis.indexedDB;
  if (!factory) return null;
  if (typeof factory.databases === 'function') {
    try {
      const list = await factory.databases();
      if (!list.some(d => d.name === LEGACY_DB)) return null;
    } catch {
      return null;
    }
  }
  return new Promise(resolve => {
    let request;
    try { request = factory.open(LEGACY_DB); } catch { resolve(null); return; }
    // Only reachable without databases(): the DB didn't exist, so undo its creation.
    request.onupgradeneeded = () => { try { request.transaction.abort(); } catch { /* ignore */ } };
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('chunks') || !db.objectStoreNames.contains('meta')) { db.close(); resolve(null); return; }
      resolve(db);
    };
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

function legacyTx(db, stores, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    const out = fn(...(Array.isArray(stores) ? stores : [stores]).map(n => t.objectStore(n)));
    t.oncomplete = () => resolve(out instanceof IDBRequest ? out.result : out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('transaction aborted'));
  });
}

/**
 * v1 left an unfinished recording in IndexedDB 'lessonRecorderDB' (stores
 * 'chunks' autoIncrement and 'meta' with key 'current' =
 * {name, mime, container, status:'recording', startTime, elapsedMs}).
 * @returns {Promise<null | {meta, chunks, bytes, assemble: () => Promise<Blob>,
 *   assembleInfo: () => Promise<{blob, durationMs, meta}>, discard: () => Promise<void>}>}
 */
export async function findLegacyRecording() {
  const db = await openLegacyDb();
  if (!db) return null;
  try {
    const meta = await legacyTx(db, 'meta', 'readonly', s => s.get('current'));
    if (!meta || meta.status !== 'recording') return null;
    const parts = await legacyTx(db, 'chunks', 'readonly', s => s.getAll());
    if (!parts?.length) return null;
    const bytes = parts.reduce((n, b) => n + (b?.size || b?.byteLength || 0), 0);
    const type = blobTypeFor({ mimeType: meta.mime, container: meta.container });
    const assembleInfo = async () => {
      const db2 = await openLegacyDb();
      if (!db2) throw new Error('The earlier recording is no longer stored in the browser.');
      try {
        const all = await legacyTx(db2, 'chunks', 'readonly', s => s.getAll());
        const { blob, durationMs } = await buildRecording(all, type, meta.elapsedMs);
        return { blob, durationMs, meta };
      } finally { db2.close(); }
    };
    return {
      meta,
      chunks: parts.length,
      bytes,
      assembleInfo,
      assemble: async () => (await assembleInfo()).blob,
      // Same as v1's own "finish": empty both stores (v1 may still be open in another tab).
      discard: async () => {
        const db3 = await openLegacyDb();
        if (!db3) return;
        try {
          await legacyTx(db3, ['chunks', 'meta'], 'readwrite', (c, m) => { c.clear(); m.delete('current'); });
        } finally { db3.close(); }
      },
    };
  } catch (e) {
    console.warn('Could not read the earlier recording', e);
    return null;
  } finally {
    db.close();
  }
}
