// The "Your takes" list: metadata about every saved take (never the video
// itself), kept in IndexedDB so it survives reloads. Falls back to memory
// when IndexedDB is unavailable (e.g. some private windows) or stops working.

import { Emitter } from '../lib/emitter.js';
import { openDb, tx } from '../lib/idb.js';

/**
 * @typedef {object} Take
 * @property {string} id
 * @property {string} lessonName
 * @property {string} filename
 * @property {'mp4'|'webm'} container
 * @property {string} mimeType
 * @property {number} durationMs
 * @property {number} size
 * @property {number} createdAt
 * @property {{id:string, atMs:number, title:string}[]} markers
 * @property {'folder'|'download'} savedTo
 * @property {string} folderName
 * @property {string} thumbnail   small JPEG data URL or ''
 */

/** Pure: newest first (ties broken by id so the order is stable). */
export function sortTakes(rows) {
  return [...rows].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0) || String(a.id).localeCompare(String(b.id)));
}

const clone = t => ({ ...t, markers: Array.isArray(t.markers) ? t.markers.map(m => ({ ...m })) : [] });

export class TakesLibrary extends Emitter {
  #persistent;
  #rows = new Map();   // mirror of the store; the only copy in memory mode

  constructor(persistent = false) {
    super();
    this.#persistent = persistent;
  }

  /** @returns {Promise<TakesLibrary>} in-memory only if IndexedDB is unavailable. */
  static async open() {
    const db = await openDb();
    const lib = new TakesLibrary(!!db);
    if (db) {
      try { await lib.list(); } catch { lib.#persistent = false; }
    }
    return lib;
  }

  /** True when takes survive a reload. */
  get persistent() { return this.#persistent; }

  /** @returns {Promise<Take[]>} newest first */
  async list() {
    if (this.#persistent) {
      try {
        const rows = (await tx('takes', 'readonly', s => s.takes.getAll())) || [];
        this.#rows = new Map(rows.map(r => [r.id, r]));
      } catch (e) {
        this.#degrade(e);
      }
    }
    return sortTakes([...this.#rows.values()]).map(clone);
  }

  /** @returns {Promise<Take|null>} */
  async get(id) {
    if (this.#persistent) {
      try {
        const row = await tx('takes', 'readonly', s => s.takes.get(id));
        return row ? clone(row) : null;
      } catch (e) {
        this.#degrade(e);
      }
    }
    const row = this.#rows.get(id);
    return row ? clone(row) : null;
  }

  /** Add (or replace) a take. */
  async add(take) {
    if (!take?.id) throw new Error('A take needs an id.');
    const row = clone({ createdAt: Date.now(), markers: [], ...take });
    await this.#put(row);
    await this.#changed();
    return clone(row);
  }

  /** Merge `patch` into a take. Resolves to the updated take, or null if it doesn't exist. */
  async update(id, patch = {}) {
    const cur = await this.get(id);
    if (!cur) return null;
    const row = clone({ ...cur, ...patch, id });
    await this.#put(row);
    await this.#changed();
    return clone(row);
  }

  /** Remove a take from the list (the file itself is the caller's business). */
  async remove(id) {
    if (this.#persistent) {
      try { await tx('takes', 'readwrite', s => { s.takes.delete(id); }); } catch (e) { this.#degrade(e); }
    }
    this.#rows.delete(id);
    await this.#changed();
  }

  async #put(row) {
    if (this.#persistent) {
      try { await tx('takes', 'readwrite', s => { s.takes.put(row); }); } catch (e) { this.#degrade(e); }
    }
    this.#rows.set(row.id, row);
  }

  #degrade(e) {
    if (!this.#persistent) return;
    console.warn('Takes list: IndexedDB failed, keeping the list in memory', e);
    this.#persistent = false;
  }

  async #changed() {
    this.emit('change', await this.list());
  }
}
