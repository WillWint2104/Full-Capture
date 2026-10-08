// An in-memory stand-in for a FileSystemDirectoryHandle (File System Access
// API), used by the recording tests both in node and in the browser harness.
// It follows Chrome's semantics where they matter to us:
//  * createWritable() writes into a hidden buffer; the file only changes on
//    close() (abort() throws the buffer away);
//  * write() takes data or {type:'write', position, data} / {type:'seek'} /
//    {type:'truncate'};
//  * names compare case-insensitively (like Windows) by default;
//  * permission is 'granted' | 'prompt' | 'denied'.
// Test hooks: failAfterBytes (simulate a full disk), writes (log of
// {name, position|null, size}), permission.

const domError = (name, message = name) => (typeof DOMException === 'function'
  ? new DOMException(message, name)
  : Object.assign(new Error(message), { name }));

async function toBytes(data) {
  if (data == null) return new Uint8Array(0);
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (typeof data.arrayBuffer === 'function') return new Uint8Array(await data.arrayBuffer());
  throw new TypeError('unsupported data');
}

function checkName(name) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[/\\]/.test(name)) {
    throw new TypeError(`invalid name: ${name}`);
  }
}

class FakeWritable {
  #dir; #entry; #buf; #len; #pos = 0; #state = 'open';

  constructor(dir, entry, keep) {
    this.#dir = dir;
    this.#entry = entry;
    this.#buf = keep ? entry.data.slice() : new Uint8Array(1024);
    this.#len = keep ? entry.data.length : 0;
  }

  #ensure(n) {
    if (n <= this.#buf.length) return;
    const next = new Uint8Array(Math.max(n, this.#buf.length * 2));
    next.set(this.#buf.subarray(0, this.#len));
    this.#buf = next;
  }

  async write(arg) {
    if (this.#state !== 'open') throw new TypeError('The stream is closed or errored.');
    let data = arg;
    let positioned = null;
    if (arg && typeof arg === 'object' && typeof arg.type === 'string' && !(typeof Blob !== 'undefined' && arg instanceof Blob)) {
      if (arg.type === 'seek') { this.#pos = arg.position; return; }
      if (arg.type === 'truncate') {
        this.#ensure(arg.size);
        if (arg.size > this.#len) this.#buf.fill(0, this.#len, arg.size);
        this.#len = arg.size;
        this.#pos = Math.min(this.#pos, arg.size);
        return;
      }
      if (arg.type !== 'write') throw new TypeError(`unknown write type ${arg.type}`);
      if (Number.isFinite(arg.position)) { this.#pos = arg.position; positioned = arg.position; }
      data = arg.data;
    }
    const bytes = await toBytes(data);
    const dir = this.#dir;
    if (dir.failAfterBytes != null && dir.bytesWritten + bytes.length > dir.failAfterBytes) {
      this.#state = 'errored';
      throw domError(dir.failWith || 'QuotaExceededError', 'The disk is full.');
    }
    if (dir.permission !== 'granted') {
      this.#state = 'errored';
      throw domError('NotAllowedError', 'Permission was revoked.');
    }
    dir.bytesWritten += bytes.length;
    this.#ensure(this.#pos + bytes.length);
    if (this.#pos > this.#len) this.#buf.fill(0, this.#len, this.#pos);
    this.#buf.set(bytes, this.#pos);
    this.#pos += bytes.length;
    this.#len = Math.max(this.#len, this.#pos);
    dir.writes.push({ name: this.#entry.name, position: positioned, size: bytes.length });
  }

  async seek(position) { return this.write({ type: 'seek', position }); }
  async truncate(size) { return this.write({ type: 'truncate', size }); }

  async close() {
    if (this.#state !== 'open') throw new TypeError('The stream is closed or errored.');
    this.#state = 'closed';
    // Commit only if the file still exists (it may have been removed meanwhile).
    if (this.#dir._entry(this.#entry.name) === this.#entry) this.#entry.data = this.#buf.slice(0, this.#len);
    this.#entry.modified = Date.now();
  }

  async abort() {
    this.#state = 'closed';
    this.#buf = new Uint8Array(0);
  }
}

class FakeFileHandle {
  kind = 'file';
  #dir; #entry;
  constructor(dir, entry) { this.#dir = dir; this.#entry = entry; }
  get name() { return this.#entry.name; }

  #alive() {
    if (this.#dir._entry(this.#entry.name) !== this.#entry) throw domError('NotFoundError', 'The file is gone.');
  }

  async getFile() {
    this.#alive();
    return new File([this.#entry.data], this.#entry.name, { lastModified: this.#entry.modified });
  }

  async createWritable({ keepExistingData = false } = {}) {
    this.#alive();
    this.#dir._check();
    return new FakeWritable(this.#dir, this.#entry, keepExistingData);
  }

  async isSameEntry(other) { return other instanceof FakeFileHandle && other.#entry === this.#entry; }

  async move(...args) {
    if (!this.#dir.supportsMove) throw new TypeError('move() is not supported');
    const newName = typeof args[args.length - 1] === 'string' ? args[args.length - 1] : this.#entry.name;
    checkName(newName);
    this.#alive();
    this.#dir._check();
    const existing = this.#dir._entry(newName);
    if (existing && existing !== this.#entry) throw domError('InvalidModificationError', 'A file with that name exists.');
    this.#dir._rename(this.#entry, newName);
  }

  async queryPermission() { return this.#dir.permission; }
  async requestPermission() { return this.#dir.requestPermission(); }
}

class FakeDirectoryHandle {
  kind = 'directory';
  name;
  permission;
  grantOnRequest;
  caseInsensitive;
  supportsMove;
  failAfterBytes = null;
  failWith = 'QuotaExceededError';
  bytesWritten = 0;
  writes = [];
  #entries = new Map();

  constructor({ name = 'Lessons', permission = 'granted', grantOnRequest = true, caseInsensitive = true, supportsMove = true } = {}) {
    this.name = name;
    this.permission = permission;
    this.grantOnRequest = grantOnRequest;
    this.caseInsensitive = caseInsensitive;
    this.supportsMove = supportsMove;
  }

  #key(name) { return this.caseInsensitive ? name.toLowerCase() : name; }
  _entry(name) { return this.#entries.get(this.#key(name)) || null; }
  _check() { if (this.permission !== 'granted') throw domError('NotAllowedError', 'Permission is needed.'); }
  _rename(entry, newName) {
    this.#entries.delete(this.#key(entry.name));
    entry.name = newName;
    this.#entries.set(this.#key(newName), entry);
  }

  async queryPermission() { return this.permission; }
  async requestPermission() {
    if (this.grantOnRequest) this.permission = 'granted';
    return this.permission;
  }

  async getFileHandle(name, { create = false } = {}) {
    checkName(name);
    this._check();
    let entry = this._entry(name);
    if (!entry) {
      if (!create) throw domError('NotFoundError', `${name} not found`);
      entry = { name, data: new Uint8Array(0), modified: Date.now() };
      this.#entries.set(this.#key(name), entry);
    }
    return new FakeFileHandle(this, entry);
  }

  async getDirectoryHandle(name) { throw domError('NotFoundError', `${name} not found`); }

  async removeEntry(name) {
    checkName(name);
    this._check();
    if (!this.#entries.delete(this.#key(name))) throw domError('NotFoundError', `${name} not found`);
  }

  async *entries() { for (const e of [...this.#entries.values()]) yield [e.name, new FakeFileHandle(this, e)]; }
  async *values() { for (const e of [...this.#entries.values()]) yield new FakeFileHandle(this, e); }
  async *keys() { for (const e of [...this.#entries.values()]) yield e.name; }
  [Symbol.asyncIterator]() { return this.entries(); }

  // --- test helpers
  /** Names of the files, in creation order. */
  fileNames() { return [...this.#entries.values()].map(e => e.name); }
  /** Committed bytes of a file (or null). */
  bytes(name) { return this._entry(name)?.data ?? null; }
  /** Put a file in place directly. */
  seed(name, data = new Uint8Array([1, 2, 3])) {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    this.#entries.set(this.#key(name), { name, data: bytes, modified: Date.now() });
  }
}

/** A fake folder the tests can hand to FolderStore (via a stubbed showDirectoryPicker). */
export function createFakeDirectory(opts) {
  return new FakeDirectoryHandle(opts);
}
