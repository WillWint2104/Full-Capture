// Minimal event emitter shared by every stateful module.
// Listeners get one `detail` argument; on() returns an unsubscribe function.
export class Emitter {
  #listeners = new Map();

  on(type, fn) {
    let set = this.#listeners.get(type);
    if (!set) this.#listeners.set(type, (set = new Set()));
    set.add(fn);
    return () => this.off(type, fn);
  }

  once(type, fn) {
    const off = this.on(type, detail => { off(); fn(detail); });
    return off;
  }

  off(type, fn) {
    const set = this.#listeners.get(type);
    if (set) set.delete(fn);
  }

  emit(type, detail) {
    const set = this.#listeners.get(type);
    if (!set) return;
    // Copy first so listeners can unsubscribe while we iterate.
    for (const fn of [...set]) {
      try { fn(detail); } catch (e) { console.error(`[${type}] listener failed`, e); }
    }
  }
}
