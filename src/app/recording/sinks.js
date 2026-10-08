// Where a take's bytes go while it is recorded.
//
// Common interface (the recorder calls write() strictly in order, one at a time):
//   kind                                  'memory' | 'folder'
//   async open({ filename, container, mimeType })
//   async write(blob)
//   async finalize({ durationMs }) -> { savedTo, size, blob?, filename, folderName? }
//   async abort()                         // throw away partial output
//
// WebM from MediaRecorder has no Duration, so players can't show a length or
// seek well. Both sinks add it while touching only the header.

import { prepareStreamingHeader, encodeDurationPayload, patchWebmBlob, NeedMoreData } from '../media/webm.js';

/** Stop waiting for a parseable WebM header after this much data and write it unpatched. */
export const HEADER_LIMIT_BYTES = 2 * 1024 * 1024;

const typeFor = (container, mimeType) => mimeType || (container === 'mp4' ? 'video/mp4' : 'video/webm');

/**
 * Keeps the recording as Blob parts. Chrome moves large blobs to disk on its
 * own, so even long lessons don't sit in RAM. The result is handed to the
 * teacher as a download.
 */
export class MemorySink {
  kind = 'memory';
  #parts = [];
  #size = 0;
  #filename = '';
  #container = 'webm';
  #type = 'video/webm';

  async open({ filename = 'recording.webm', container = 'webm', mimeType = '' } = {}) {
    this.#parts = [];
    this.#size = 0;
    this.#filename = filename;
    this.#container = container;
    this.#type = typeFor(container, mimeType);
  }

  async write(blob) {
    if (!blob || !blob.size) return;
    this.#parts.push(blob);
    this.#size += blob.size;
  }

  /** Bytes received so far. */
  get size() { return this.#size; }

  async finalize({ durationMs = 0 } = {}) {
    let blob = new Blob(this.#parts, { type: this.#type });
    if (this.#container === 'webm' && durationMs > 0 && blob.size) blob = await patchWebmBlob(blob, durationMs);
    this.#parts = [];
    return { savedTo: 'memory', size: blob.size, blob, filename: this.#filename };
  }

  async abort() {
    this.#parts = [];
    this.#size = 0;
  }
}

/**
 * Streams straight into a file in the teacher's folder through a
 * FileSystemWritableFileStream (Chrome writes to a temporary ".crswap" file
 * and only replaces the real one on close(), so a crash leaves no half file;
 * the journal covers that case).
 *
 * WebM: the first chunks are held back until the header's Info element is
 * complete (the first chunk can be a single byte), then written with a
 * placeholder Duration whose offset is remembered; finalize() writes the real
 * value there just before close().
 */
export class FolderSink {
  kind = 'folder';
  #store;
  #handle = null;
  #writable = null;
  #name = '';
  #container = 'webm';
  #pending = [];
  #pendingBytes = 0;
  #headerDone = false;
  #duration = null;          // { offset, size, timecodeScale } once the placeholder is written
  #written = 0;
  #closed = false;
  #saved = false;            // finalize() committed the file: it is the teacher's recording now

  /** @param {import('./folder.js').FolderStore} folderStore */
  constructor(folderStore) {
    this.#store = folderStore;
  }

  /** The file's final name in the folder (after "(2)" de-duplication). */
  get filename() { return this.#name; }
  /** The folder's display name, for messages. */
  get folderName() { return this.#store?.name || ''; }
  /** Bytes written to the file so far. */
  get size() { return this.#written + this.#pendingBytes; }
  /** True once the WebM header carries a Duration placeholder that finalize() will fill in. */
  get durationPatchable() { return !!this.#duration; }

  async open({ filename, container = 'webm' } = {}) {
    if (!this.#store) throw new Error('No folder is chosen for recordings.');
    const { handle, writable, name } = await this.#store.createFile(filename);
    this.#handle = handle;
    this.#writable = writable;
    this.#name = name;
    this.#container = container;
    this.#headerDone = container !== 'webm';
  }

  async write(blob) {
    if (!this.#writable || this.#closed) throw new Error('The file is not open.');
    if (!blob || !blob.size) return;
    if (this.#headerDone) {
      await this.#writable.write(blob);
      this.#written += blob.size;
      return;
    }
    this.#pending.push(blob);
    this.#pendingBytes += blob.size;
    await this.#tryHeader(false);
  }

  /** Write the buffered head once it parses (or once we give up on parsing it). */
  async #tryHeader(force) {
    const head = new Uint8Array(await new Blob(this.#pending).arrayBuffer());
    let out = head;
    try {
      const prepared = prepareStreamingHeader(head);
      out = prepared.bytes;
      this.#duration = { offset: prepared.durationOffset, size: prepared.durationSize, timecodeScale: prepared.timecodeScale };
    } catch (e) {
      if (e instanceof NeedMoreData && !force && this.#pendingBytes < HEADER_LIMIT_BYTES) return;
      // Unparseable (or never complete): keep the recording, just without a Duration.
      console.warn('WebM header left unpatched:', e.message);
      out = head;
      this.#duration = null;
    }
    await this.#writable.write(out);
    this.#written += out.length;
    this.#pending = [];
    this.#pendingBytes = 0;
    this.#headerDone = true;
  }

  async finalize({ durationMs = 0 } = {}) {
    if (!this.#writable || this.#closed) throw new Error('The file is not open.');
    if (!this.#headerDone && this.#pending.length) await this.#tryHeader(true);
    if (this.#duration && durationMs > 0) {
      const { offset, size, timecodeScale } = this.#duration;
      await this.#writable.write({ type: 'write', position: offset, data: encodeDurationPayload(durationMs, timecodeScale, size) });
    }
    await this.#writable.close();
    this.#closed = true;
    this.#saved = true;
    let size = this.#written;
    try { size = (await this.#handle.getFile()).size; } catch { /* keep our count */ }
    return { savedTo: 'folder', size, filename: this.#name, folderName: this.#store.name || '' };
  }

  async abort() {
    // Only partial output is thrown away; a finished file is never deleted from here.
    if (this.#saved) return;
    const w = this.#writable;
    this.#pending = [];
    this.#pendingBytes = 0;
    if (w && !this.#closed) {
      this.#closed = true;
      // abort() discards Chrome's temporary file without touching the real one.
      try {
        if (typeof w.abort === 'function') await w.abort();
        else await w.close();
      } catch { /* the stream may already be broken */ }
    }
    if (this.#name) {
      try { await this.#store.remove(this.#name); } catch { /* permission gone: nothing more we can do */ }
    }
  }
}
