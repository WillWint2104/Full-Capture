// The folder the teacher chose for recordings (File System Access API).
//
// The directory handle is persisted in IndexedDB (kv 'folderHandle') so the
// choice survives reloads. Chrome forgets the *permission* between visits,
// so after a reload the status is 'needs-permission' until the teacher
// clicks something that calls reconnect() (permission prompts need a user
// gesture).
//
// Names are never overwritten: a second "Lesson.mp4" becomes "Lesson (2).mp4".

import { Emitter } from '../lib/emitter.js';
import { kv } from '../lib/idb.js';
import { withSuffix } from '../lib/names.js';

const KV_KEY = 'folderHandle';
const MAX_SUFFIX = 999;

const isNotFound = e => e?.name === 'NotFoundError' || e?.name === 'TypeMismatchError';

/**
 * Pure: the first name in "name.ext", "name (2).ext", "name (3).ext"... for
 * which `exists(name)` is false. `exists` may be async. Names are compared by
 * the callback, so case rules (Windows ignores case) live there.
 * @param {string} filename
 * @param {(name:string) => boolean|Promise<boolean>} exists
 * @returns {Promise<string>}
 */
export async function uniqueName(filename, exists, { max = MAX_SUFFIX } = {}) {
  if (!(await exists(filename))) return filename;
  for (let n = 2; n <= max; n++) {
    const candidate = withSuffix(filename, n);
    if (!(await exists(candidate))) return candidate;
  }
  throw new Error(`There are too many files called “${filename}” in this folder. Rename or move some of them.`);
}

/** Pure: a short teacher-facing explanation for a file-system error. */
export function folderErrorMessage(e, folderName = '') {
  const where = folderName ? `your “${folderName}” folder` : 'your folder';
  switch (e?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return `Full Capture is no longer allowed to save into ${where}. Click the folder button at the top to allow it again.`;
    case 'QuotaExceededError':
      return `The disk with ${where} is full. Free up some space.`;
    case 'NotFoundError':
      return `${where[0].toUpperCase()}${where.slice(1)} can’t be found. It may have been moved, renamed or unplugged.`;
    case 'NoModificationAllowedError':
    case 'InvalidStateError':
      return `Another program is using a file in ${where}. Close it and try again.`;
    default:
      return `Something went wrong saving into ${where}${e?.message ? ` (${e.message})` : ''}.`;
  }
}

export class FolderStore extends Emitter {
  #handle = null;
  #status = 'none';

  /** True when the browser can save straight into a folder (Chrome/Edge on desktop). */
  static isSupported() {
    return typeof globalThis.showDirectoryPicker === 'function';
  }

  constructor() {
    super();
    if (!FolderStore.isSupported()) this.#status = 'unsupported';
  }

  /** 'unsupported' | 'none' | 'needs-permission' | 'ready' */
  get status() { return this.#status; }

  /** The folder's display name ('' when none is chosen). */
  get name() { return this.#handle?.name || ''; }

  /** The directory handle (or null). */
  get handle() { return this.#handle; }

  #setStatus(status) {
    const changed = status !== this.#status;
    this.#status = status;
    if (changed) this.emit('status', { status, name: this.name });
  }

  /** Load the remembered folder and check whether we may still write to it. */
  async init() {
    if (!FolderStore.isSupported()) { this.#setStatus('unsupported'); return this.#status; }
    let handle = null;
    try { handle = await kv.get(KV_KEY); } catch { handle = null; }
    if (!handle || typeof handle.getFileHandle !== 'function') {
      this.#handle = null;
      this.#setStatus('none');
      return this.#status;
    }
    this.#handle = handle;
    await this.refresh();
    return this.#status;
  }

  /** Re-read the permission state (e.g. before starting a take). */
  async refresh() {
    if (!this.#handle) { this.#setStatus(FolderStore.isSupported() ? 'none' : 'unsupported'); return this.#status; }
    let state = 'prompt';
    try { state = await this.#handle.queryPermission({ mode: 'readwrite' }); } catch { state = 'prompt'; }
    this.#setStatus(state === 'granted' ? 'ready' : 'needs-permission');
    return this.#status;
  }

  /** Let the teacher pick a folder. Must run from a click. Rejects with AbortError when they cancel. */
  async choose() {
    if (!FolderStore.isSupported()) throw new Error('This browser can’t save straight into a folder.');
    const handle = await globalThis.showDirectoryPicker({ id: 'full-capture', mode: 'readwrite', startIn: 'videos' });
    let state = 'prompt';
    try { state = await handle.queryPermission({ mode: 'readwrite' }); } catch { /* ask below */ }
    if (state !== 'granted') {
      try { state = await handle.requestPermission({ mode: 'readwrite' }); } catch { state = 'denied'; }
    }
    this.#handle = handle;
    // A folder whose handle can't be stored still works for this visit.
    try { await kv.set(KV_KEY, handle); } catch (e) { console.warn('Could not remember the folder', e); }
    const before = this.#status;
    this.#setStatus(state === 'granted' ? 'ready' : 'needs-permission');
    // A different folder is news even when the status stays the same.
    if (before === this.#status) this.emit('status', { status: this.#status, name: this.name });
    return this.#status;
  }

  /** Ask again for permission to the remembered folder. Must run from a click. Resolves true when ready. */
  async reconnect() {
    if (!this.#handle) return false;
    let state = 'denied';
    try { state = await this.#handle.requestPermission({ mode: 'readwrite' }); } catch { state = 'denied'; }
    this.#setStatus(state === 'granted' ? 'ready' : 'needs-permission');
    return this.#status === 'ready';
  }

  /** Stop using the folder (files in it are untouched). */
  async forget() {
    this.#handle = null;
    try { await kv.delete(KV_KEY); } catch { /* nothing stored */ }
    this.#setStatus(FolderStore.isSupported() ? 'none' : 'unsupported');
  }

  async #dir() {
    if (!this.#handle) throw new Error('No folder is chosen for recordings.');
    if (this.#status !== 'ready') {
      await this.refresh();
      if (this.#status !== 'ready') {
        const e = new Error(folderErrorMessage({ name: 'NotAllowedError' }, this.name));
        e.name = 'NotAllowedError';
        throw e;
      }
    }
    return this.#handle;
  }

  async #exists(dir, name) {
    try { await dir.getFileHandle(name); return true; } catch (e) {
      if (isNotFound(e)) return e.name === 'TypeMismatchError'; // a sub-folder with that name counts as taken
      throw e;
    }
  }

  /** A name that is free in the folder: "name.ext", else "name (2).ext", ... */
  async uniqueName(filename) {
    const dir = await this.#dir();
    return uniqueName(filename, name => this.#exists(dir, name));
  }

  /**
   * Create a new file (never overwrites) and open it for writing.
   * @returns {Promise<{handle: FileSystemFileHandle, writable: FileSystemWritableFileStream, name: string}>}
   */
  async createFile(filename) {
    const dir = await this.#dir();
    try {
      const name = await uniqueName(filename, n => this.#exists(dir, n));
      const handle = await dir.getFileHandle(name, { create: true });
      let writable;
      try {
        writable = await handle.createWritable({ keepExistingData: false });
      } catch (e) {
        // getFileHandle(create) already made an empty file under a name that
        // was free a moment ago: remove it, or the teacher finds a 0-byte
        // "Lesson.mp4" next to the take that was downloaded instead.
        try { await dir.removeEntry(name); } catch { /* best effort */ }
        throw e;
      }
      return { handle, writable, name };
    } catch (e) {
      throw this.#friendly(e);
    }
  }

  /** Write a small text file (e.g. chapters), replacing one with the same name. Resolves to the name. */
  async writeText(filename, text) {
    const dir = await this.#dir();
    try {
      const handle = await dir.getFileHandle(filename, { create: true });
      const writable = await handle.createWritable({ keepExistingData: false });
      try {
        await writable.write(new Blob([text], { type: 'text/plain' }));
        await writable.close();
      } catch (e) {
        try { await writable.abort?.(); } catch { /* already failed */ }
        throw e;
      }
      return filename;
    } catch (e) {
      throw this.#friendly(e);
    }
  }

  /** The file's current contents, or null when it isn't there. */
  async getFile(name) {
    const dir = await this.#dir();
    try {
      const handle = await dir.getFileHandle(name);
      return await handle.getFile();
    } catch (e) {
      if (isNotFound(e)) return null;
      throw this.#friendly(e);
    }
  }

  /** Delete a file; a file that is already gone is not an error. */
  async remove(name) {
    const dir = await this.#dir();
    try { await dir.removeEntry(name); } catch (e) {
      if (isNotFound(e)) return;
      throw this.#friendly(e);
    }
  }

  /**
   * Rename a file inside the folder. The new name is made unique, so nothing
   * is overwritten. Resolves to the final name.
   */
  async rename(oldName, newName) {
    if (!newName || oldName === newName) return oldName;
    const dir = await this.#dir();
    let src;
    try { src = await dir.getFileHandle(oldName); } catch (e) { throw this.#friendly(e); }
    // Changing only the letter case: on Windows that is the same file, so it isn't "taken".
    const sameIgnoringCase = oldName.toLowerCase() === newName.toLowerCase();
    const finalName = sameIgnoringCase ? newName
      : await uniqueName(newName, n => (n === oldName ? Promise.resolve(false) : this.#exists(dir, n)));
    if (typeof src.move === 'function') {
      try {
        await src.move(finalName);
        return finalName;
      } catch (e) {
        // Older Chrome only supports move() inside the private file system;
        // copying below works everywhere (and reports any real problem).
        console.warn('move() failed, copying instead', e);
      }
    }
    if (sameIgnoringCase) return oldName; // copying onto itself would destroy it
    // Copy, then remove the original only once the copy is complete.
    try {
      const file = await src.getFile();
      const dst = await dir.getFileHandle(finalName, { create: true });
      let w = null;
      try {
        w = await dst.createWritable({ keepExistingData: false });
        await w.write(file);
        await w.close();
      } catch (e) {
        // finalName was free, so the (empty or partial) copy is ours to remove.
        try { await w?.abort?.(); } catch { /* ignore */ }
        try { await dir.removeEntry(finalName); } catch { /* ignore */ }
        throw e;
      }
      await dir.removeEntry(oldName);
      return finalName;
    } catch (e) {
      throw this.#friendly(e);
    }
  }

  #friendly(e) {
    // Our own errors already speak plainly.
    if (e instanceof Error && e.name === 'Error') return e;
    if (e?.name === 'NotAllowedError' || e?.name === 'SecurityError') this.refresh().catch(() => {});
    const out = new Error(folderErrorMessage(e, this.name));
    out.name = e?.name || 'Error';
    out.cause = e;
    return out;
  }
}
