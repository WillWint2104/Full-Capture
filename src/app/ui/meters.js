// Level meters. Meter data arrives ~25×/s from the audio thread; the bars are
// drawn on animation frames with ballistics (instant rise, 20 dB/s fall, peak
// hold) so they look calm and readable.

import { dbToLevel, zoneFor, text, attr } from './dom.js';

const FALL_DB_PER_S = 20;
const PEAK_HOLD_MS = 1500;

export class Meter {
  /** @param {HTMLElement} el .meter element  @param {HTMLElement} [label] its text label */
  constructor(el, label, { labels = {} } = {}) {
    this.el = el;
    this.label = label;
    this.labels = { quiet: 'Too quiet', good: 'Good', loud: 'Too loud – move back a little', off: 'No sound', ...labels };
    this.db = -100; this.peakDb = -100; this.peakAt = 0; this.zone = null; this.last = 0;
    this.target = { rmsDb: -100, peakDb: -100 };
    if (el) {
      attr(el, 'role', 'meter');
      attr(el, 'aria-valuemin', 0);
      attr(el, 'aria-valuemax', 100);
      el.style.setProperty('--good-from', String(dbToLevel(-28)));
      el.style.setProperty('--good-to', String(dbToLevel(-12)));
    }
  }

  /** Feed the latest reading. */
  set(rmsDb, peakDb) { this.target = { rmsDb, peakDb }; }

  /** Advance the animation; call once per frame. */
  tick(now) {
    if (!this.el || !this.el.isConnected) return;
    const dt = this.last ? Math.min(0.25, (now - this.last) / 1000) : 0;
    this.last = now;
    const { rmsDb, peakDb } = this.target;
    this.db = rmsDb >= this.db ? rmsDb : Math.max(rmsDb, this.db - FALL_DB_PER_S * dt);
    if (peakDb >= this.peakDb || now - this.peakAt > PEAK_HOLD_MS) {
      this.peakDb = peakDb >= this.peakDb ? peakDb : Math.max(peakDb, this.peakDb - FALL_DB_PER_S * dt);
      if (peakDb >= this.peakDb) this.peakAt = now;
    }
    const level = dbToLevel(this.db);
    this.el.style.setProperty('--level', level.toFixed(3));
    this.el.style.setProperty('--peak', dbToLevel(this.peakDb).toFixed(3));
    const zone = this.db <= -70 ? 'off' : zoneFor(this.db, this.target.peakDb);
    if (zone !== this.zone) {
      this.zone = zone;
      attr(this.el, 'data-zone', zone === 'off' ? 'quiet' : zone);
      attr(this.el, 'aria-valuetext', this.labels[zone]);
      if (this.label) text(this.label, this.labels[zone]);
    }
    attr(this.el, 'aria-valuenow', Math.round(level * 100));
  }
}

/**
 * Runs every registered meter on one animation-frame loop. Pass another
 * window (the floating controls) to run on its frames: it stays visible when
 * this tab is hidden and this tab's frames stop.
 */
export class MeterLoop {
  constructor(win = globalThis) { this.win = win; this.meters = new Set(); this.extra = new Set(); this.raf = 0; }
  add(m) { this.meters.add(m); this.#start(); return () => this.meters.delete(m); }
  /** Extra per-frame callbacks (e.g. the spectrum). */
  onFrame(fn) { this.extra.add(fn); this.#start(); return () => this.extra.delete(fn); }
  #start() {
    if (this.raf) return;
    const loop = now => {
      for (const m of this.meters) m.tick(now);
      for (const fn of this.extra) { try { fn(now); } catch (e) { console.error(e); } }
      this.raf = this.win.requestAnimationFrame(loop);
    };
    this.raf = this.win.requestAnimationFrame(loop);
  }
  stop() { if (this.raf) this.win.cancelAnimationFrame(this.raf); this.raf = 0; this.meters.clear(); this.extra.clear(); }
}
