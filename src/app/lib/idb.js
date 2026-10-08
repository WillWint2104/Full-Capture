// One IndexedDB database for the whole app. Every store is declared here so
// modules never race each other over schema upgrades.
//
//   journalMeta   keyPath 'id'           one row per in-progress take (crash recovery)
//   journalChunks keyPath ['id','seq']   recorded chunks for those takes
//   takes         keyPath 'id'           the takes library (metadata only)
//   kv            out-of-line keys       small values, e.g. the saved folder handle
//
// IndexedDB can be missing or throw (private windows, blocked site data), so
// openDb() resolves to null instead of rejecting; callers degrade gracefully.

export const DB_NAME = 'full-capture';
export const DB_VERSION = 1;
export const STORES = {
  journalMeta: { keyPath: 'id' },
  journalChunks: { keyPath: ['id', 'seq'] },
  takes: { keyPath: 'id' },
  kv: {},
};

let dbPromise = null;

/** @returns {Promise<IDBDatabase|null>} */
export function openDb() {
  if (dbPromise) return dbPromise;
  const p = new Promise(resolve => {
    let factory;
    try { factory = globalThis.indexedDB; } catch { factory = null; }
    if (!factory) return resolve(null);
    let req;
    try { req = factory.open(DB_NAME, DB_VERSION); } catch { return resolve(null); }
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const [name, opts] of Object.entries(STORES)) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, opts);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // Another tab upgrading the schema: step aside rather than block it.
      db.onversionchange = () => { db.close(); dbPromise = null; };
      // The browser can close the connection (e.g. storage cleared); reopen next time.
      db.onclose = () => { dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  // Cache only a working connection so a transient failure is retried later.
  dbPromise = p.then(db => { if (!db) dbPromise = null; return db; });
  return dbPromise;
}

/** Promise for a single IDBRequest. */
export function req(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Run `fn(stores)` inside one transaction and resolve with its return value
 * once the transaction commits. `fn` may return a value or a request; a
 * request resolves to its result. `stores` maps store name -> IDBObjectStore.
 * Rejects if the database is unavailable.
 */
export async function tx(storeNames, mode, fn) {
  const db = await openDb();
  if (!db) throw new Error('IndexedDB is unavailable');
  const names = Array.isArray(storeNames) ? storeNames : [storeNames];
  return new Promise((resolve, reject) => {
    const t = db.transaction(names, mode);
    const stores = Object.fromEntries(names.map(n => [n, t.objectStore(n)]));
    let out;
    try { out = fn(stores); } catch (e) { try { t.abort(); } catch {} reject(e); return; }
    t.oncomplete = () => resolve(out instanceof IDBRequest ? out.result : out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('transaction aborted'));
  });
}

/** Small key/value helpers on the `kv` store. */
export const kv = {
  get: key => tx('kv', 'readonly', s => s.kv.get(key)),
  set: (key, value) => tx('kv', 'readwrite', s => { s.kv.put(value, key); }),
  delete: key => tx('kv', 'readwrite', s => { s.kv.delete(key); }),
};
