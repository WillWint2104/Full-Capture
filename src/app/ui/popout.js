// Floating controls: a Document Picture-in-Picture window that stays on top
// of other apps, so the teacher can see the timer and sound level, and pause,
// add chapters or stop without coming back to this tab. Its markup comes
// from <template id="tplPopout">; its styles are copied from this page.
//
// Nothing can keep an ordinary window out of a recording of the whole screen,
// so the controls close themselves as a take starts when they'd be in it
// (controlsWouldBeRecorded), and Hide / Alt+H close them at any time. The take
// carries on; Alt+H or the Floating controls button brings them back.

import { clone, fill, show, text, attr, onAction, label } from './dom.js';
import { Meter, MeterLoop } from './meters.js';
import { topAlert, isNoSound } from './notices.js';
import { formatClock, formatDuration } from '../lib/time.js';

const TAKE_PHASES = ['starting', 'recording', 'paused', 'stopping'];
// Once the controls have closed, the take waits this long before it starts: the
// screen capture can still hand over frames it took while they were on screen.
export const HIDE_SETTLE_MS = 300;
// Captures are limited to this size (video/sources.js), so a bigger monitor arrives scaled down.
const MAX_CAPTURE = { width: 3840, height: 2160 };
// Display scale factors in common use (Windows' settings, Retina). The browser's
// devicePixelRatio is the display's scale times the page zoom, so on its own it can't
// say how many pixels a display has.
const SCALES = [1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 3, 3.5, 4];
// A show request this soon after the controls closed themselves is a late "hide" (the
// teacher pressing Alt+H as they vanish), not a wish to record them.
const LATE_PRESS_MS = 1500;

/**
 * Would a recording of this capture include the floating controls? Pure.
 *   capture: the shared screen { surface, nativeWidth, nativeHeight } (its size before fitting a preset)
 *   display: the controls' own screen { isExtended, width, height (CSS px), dpr }
 * A window or tab capture never contains them. On a single display they are on
 * the recorded monitor. With several displays, one that could be the size of the
 * recorded monitor may be it (two identical monitors can't be told apart), so it
 * counts; one that can't be doesn't. The display's size is known in CSS pixels
 * only, and the page zoom hides its scale, so every common scale is tried: any
 * match counts. Anything unknown counts. In doubt, the controls hide.
 */
export function controlsWouldBeRecorded(capture, display) {
  if (!capture || capture.surface !== 'monitor') return false;
  if (typeof display?.isExtended !== 'boolean' || !display.isExtended) return true;
  const { width: w, height: h } = display;
  const cw = capture.nativeWidth, ch = capture.nativeHeight;
  if (!(w > 0 && h > 0 && cw > 0 && ch > 0)) return true;
  const near = (a, b) => Math.abs(a - b) <= 0.02 * Math.max(a, b);
  // A capture at the size limit may be a bigger monitor scaled down: then only its shape can match.
  const clamped = cw >= MAX_CAPTURE.width * 0.98 || ch >= MAX_CAPTURE.height * 0.98;
  return [display.dpr, ...SCALES].some(s => {
    if (!(s > 0)) return false;
    const dw = w * s, dh = h * s;
    if (near(dw, cw) && near(dh, ch)) return true;
    return clamped && dw >= cw * 0.98 && dh >= ch * 0.98 && near(dw / dh, cw / ch);
  });
}

export class Popout {
  constructor(session, { notices, toast, onOpen, onClose } = {}) {
    this.session = session;
    this.notices = notices;
    this.toast = toast;
    this.onOpen = onOpen;
    this.onClose = onClose;
    this.keyHandler = null;   // set by the app: shared shortcut handler
    this.startOrStop = null;  // set by the app: the one Start path (same microphone rule as the big button)
    this.win = null;
    this.opening = false;
    this.openPromise = null;  // the window being opened (resolves true once it is built)
    this.take = null;         // per take: { decided, hiding }; null between takes
    this.prevAlert = '';
    this.meter = null;
    this.loop = null;
    this.confirming = false;
    this.prevPhase = null;
    this.prevNoSound = false;
    this.clock = { elapsedMs: 0, at: 0, running: false };
    this.onChange = st => this.render(st);
    this.onMeter = m => this.meter?.set(m.voice?.rmsDb ?? -100, m.voice?.peakDb ?? -100);
  }

  get supported() { return 'documentPictureInPicture' in window; }
  get isOpen() { return !!this.win; }

  /** Must be called from a click or key press (it needs its user activation). */
  async open() {
    if (this.win) { try { this.win.focus(); } catch { /* ignore */ } return true; }
    if (this.opening) return false;
    if (!this.supported) {
      this.toast?.({ kind: 'info', title: 'Floating controls need Chrome or Edge 116+', text: 'You can keep this tab open on your other screen instead.' });
      return false;
    }
    this.opening = true;
    // Asked for before anything awaits, while the press still counts.
    this.openPromise = this.#requestWindow();
    return this.openPromise;
  }

  async #requestWindow() {
    try {
      this.win = await documentPictureInPicture.requestWindow({ width: 320, height: 420, disallowReturnToOpener: false });
    } catch (e) {
      this.opening = false;
      this.toast?.({ kind: 'warning', title: 'Couldn’t open the floating controls', text: e.message || String(e) });
      return false;
    }
    this.opening = false;
    this.#build();
    this.onOpen?.();
    return true;
  }

  close() { try { this.win?.close(); } catch { /* already closed */ } }

  /**
   * Close the floating controls (Hide, Alt+H, or a take that would record them).
   * Recording carries on. Resolves once the window has gone.
   */
  async hide() {
    if (this.opening) await this.openPromise;
    const w = this.win;
    if (!w) return;
    const gone = new Promise(resolve => w.addEventListener('pagehide', resolve, { once: true }));
    this.close();
    await gone;
  }

  /** Alt+H and the Floating controls button: hide them when shown, show them when hidden (needs the press). */
  toggle() {
    if (this.win || this.opening) { this.hide(); return; }
    if (this.take?.hiddenAt && performance.now() - this.take.hiddenAt < LATE_PRESS_MS) return;
    this.open();
  }

  /**
   * Once per take, as it is about to begin ('starting'): close the controls if the
   * recording would include them. The session waits for this before it records
   * (session.setBeforeTake), so they are gone from the very first frame. Shown
   * again later in the take, they stay: that is the teacher's choice.
   */
  prepareForTake(st) {
    if (!TAKE_PHASES.includes(st.phase)) return Promise.resolve();
    if (!this.take) this.take = { decided: false, hiding: null };
    const take = this.take;
    if (take.decided) return take.hiding || Promise.resolve();
    take.decided = true;
    if (!st.prefs.autoHideControls || (!this.win && !this.opening)) return Promise.resolve();
    take.hiding = this.#autoHide(st, take);
    return take.hiding;
  }

  async #autoHide(st, take) {
    try {
      // Still opening (Start opens them): decide once the window is there, from its own screen.
      if (this.opening) await this.openPromise;
      const w = this.win;
      if (!w || this.take !== take) return;
      const s = w.screen;
      const capture = st.screen && { surface: st.screen.surface, nativeWidth: st.screen.nativeWidth, nativeHeight: st.screen.nativeHeight };
      if (!controlsWouldBeRecorded(capture, { isExtended: s?.isExtended, width: s?.width, height: s?.height, dpr: w.devicePixelRatio || 1 })) return;
      await this.hide();
      take.hiddenAt = performance.now();
      const keys = st.prefs.shortcuts ? 'Alt+H or ' : '';
      const elsewhere = s?.isExtended
        ? ' If they were on a screen you aren’t recording, turn off “Hide floating controls if they’d be recorded” in Settings.'
        : '';
      this.toast?.({
        id: 'controls-hidden', kind: 'info', title: 'Floating controls hidden',
        text: `So they aren’t in your recording of the whole screen. To bring them back, press ${keys}Floating controls.${elsewhere}`,
        timeoutMs: 10000,
      });
      await new Promise(resolve => setTimeout(resolve, HIDE_SETTLE_MS));
    } catch (e) {
      console.warn('could not hide the floating controls', e);
    }
  }

  /** Per-take state: made as a take begins, dropped once it has ended. */
  #followTake(st) {
    if (!TAKE_PHASES.includes(st.phase)) { this.take = null; return; }
    // Normally decided in the 'starting' step; if that was missed, decide now.
    this.prepareForTake(st);
  }

  #build() {
    const w = this.win, d = w.document;
    // Copy this page's styles (all inline) so the window matches the theme.
    for (const node of document.head.querySelectorAll('style, link[rel="stylesheet"]')) d.head.append(node.cloneNode(true));
    d.title = 'Full Capture';
    d.documentElement.lang = document.documentElement.lang || 'en';
    d.body.classList.add('popout');
    const root = clone('tplPopout', document);
    d.body.append(d.adoptNode(root));
    this.root = root;
    // Screen readers follow the focused window, so this one has its own live regions.
    this.status = d.createElement('div');
    this.status.className = 'sr-only';
    this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite');
    this.status.setAttribute('aria-atomic', 'true');
    this.alert = d.createElement('div');
    this.alert.className = 'sr-only';
    this.alert.setAttribute('role', 'alert');
    this.alert.setAttribute('aria-atomic', 'true');
    d.body.append(this.status, this.alert);

    const meterEl = root.querySelector('[data-field="meter"]') || root.querySelector('.meter');
    this.meter = new Meter(meterEl, root.querySelector('[data-field="micLabel"]'), {
      labels: { good: 'We can hear you ✓', quiet: 'Too quiet', loud: 'Too loud', off: 'No sound' },
    });
    // This window's own frames: they keep running while the main tab is hidden.
    this.loop = new MeterLoop(w);
    this.loop.add(this.meter);
    this.loop.onFrame(now => this.#tickClock(now));

    onAction(root, (action, btn, e) => this.#act(action, e));
    // A greyed-out Start still answers a press: it says why it can't start.
    root.querySelector('[data-action="start"]')?.addEventListener('click', e => {
      const reason = this.session.state.startBlocker;
      if (e.currentTarget.getAttribute('aria-disabled') === 'true' && reason) this.explainBlocked(reason);
    });
    d.addEventListener('keydown', e => {
      if (e.key === 'Escape' && this.confirming) {
        e.preventDefault();
        this.#closeConfirm();
        return;
      }
      if (this.keyHandler?.(e)) e.preventDefault();
    });

    // The pop-out stays visible while this tab is hidden, so its wake lock
    // keeps the PC awake for the whole lesson.
    w.navigator.wakeLock?.request('screen').then(lock => { this.wakeLock = lock; }).catch(() => {});
    this.offChange = this.session.on('change', this.onChange);
    this.offMeter = this.session.on('meter', this.onMeter);
    w.addEventListener('pagehide', () => this.#teardown(), { once: true });
    this.prevPhase = null;
    this.render(this.session.state);
  }

  #teardown() {
    this.offChange?.(); this.offMeter?.();
    this.loop?.stop(); this.loop = null;
    this.wakeLock?.release().catch(() => {}); this.wakeLock = null;
    this.win = null; this.root = null; this.meter = null; this.status = null; this.alert = null; this.confirming = false;
    // Shown again later, the new window says what is still wrong.
    this.prevAlert = ''; this.prevNoSound = false;
    this.onClose?.();
  }

  #say(message, urgent = false) {
    const region = urgent ? this.alert : this.status;
    if (!region || !message) return;
    text(region, '');
    this.win?.requestAnimationFrame(() => text(region, message));
  }

  /** A Start pressed here that can't go ahead: say why, here (the main tab may be out of sight). */
  explainBlocked(reason) {
    if (!this.root) return;
    this.#say(reason, true);
  }

  #closeConfirm() {
    this.confirming = false;
    this.render(this.session.state);
    this.root?.querySelector('[data-action="more"]')?.focus();
  }

  #act(action, e) {
    const s = this.session;
    switch (action) {
      case 'start':
        if (this.startOrStop) this.startOrStop('popout'); else s.toggleRecord();
        break;
      case 'stop': s.stop(); break;
      case 'pause': s.togglePause(); break;
      case 'marker': if (!e || e.detail <= 1) s.addMarker(); break;
      case 'more':
        this.confirming = true;
        this.render(s.state);
        // The safe choice gets focus.
        this.root?.querySelector('[data-action="discard-no"]')?.focus();
        break;
      case 'discard-no': this.#closeConfirm(); break;
      case 'hide': this.hide(); break;
      case 'discard-yes': {
        this.confirming = false;
        const st = s.state;
        if (st.take && ['recording', 'paused'].includes(st.phase)) s.cancelTake();
        else this.render(st);
        break;
      }
    }
  }

  #tickClock(now) {
    if (!this.root) return;
    const c = this.clock;
    if (!c.at) return;
    const ms = c.running ? c.elapsedMs + (now - c.at) : c.elapsedMs;
    const timer = this.root.querySelector('[data-field="timer"]');
    if (timer) text(timer, formatClock(ms));
  }

  render(st) {
    this.#followTake(st);
    const root = this.root;
    if (!root) return;
    const phase = st.phase;
    const active = ['recording', 'paused', 'stopping'].includes(phase);
    const counting = phase === 'countdown' || phase === 'starting' || st.preparing;
    const noSound = active && st.alerts.some(isNoSound);
    // Any other problem (camera unplugged, storage nearly full…) shows here too: the tab may be out of sight.
    const top = topAlert(st.alerts);
    const other = !noSound && top ? top : null;
    if (!active) this.confirming = false;

    const part = name => root.querySelector(`[data-part="${name}"]`);
    show(part('idle'), !active && !counting);
    show(part('active'), active && !this.confirming);
    show(part('confirm'), active && this.confirming);
    show(part('nosound'), noSound);
    show(part('alert'), !!other);
    attr(part('alert'), 'data-kind', other?.kind || null);
    fill(root, { alertTitle: other?.title || '', alertText: other?.text || '' });
    for (const b of root.querySelectorAll('[data-action="hide"]')) {
      attr(b, 'aria-keyshortcuts', st.prefs.shortcuts ? 'Alt+H' : null);
      attr(b, 'title', st.prefs.shortcuts ? 'Hide controls (Alt+H)' : 'Hide controls');
    }
    const body = this.win.document.body;
    attr(body, 'data-phase', phase);
    attr(body, 'data-alert', noSound ? 'nosound' : null);
    attr(this.win.document.documentElement, 'data-theme', document.documentElement.getAttribute('data-theme'));

    const blocked = !active && !counting && st.startBlocker ? st.startBlocker : '';
    const pill = phase === 'paused' ? '❚❚ Paused' : phase === 'stopping' ? 'Saving…' : active ? (noSound ? '⚠ No sound' : '● Recording') : counting ? 'Starting…' : blocked ? 'Microphone not ready' : st.screen ? 'Ready' : 'Choose a screen';
    fill(root, {
      pill,
      lesson: st.lesson.name.trim() || 'Untitled lesson',
      notes: st.lesson.notes,
      countdown: phase === 'countdown' ? String(st.countdown) : '',
    });
    for (const el of root.querySelectorAll('[data-field="pill"]')) attr(el, 'data-state', noSound ? 'nosound' : blocked ? 'blocked' : phase);
    for (const el of root.querySelectorAll('[data-field="notes"]')) show(el, !!st.lesson.notes.trim());
    for (const el of root.querySelectorAll('[data-field="countdown"]')) show(el, phase === 'countdown');
    for (const el of root.querySelectorAll('[data-field="talking"]')) show(el, phase === 'paused' && !!st.take?.talkingWhilePaused);
    for (const el of root.querySelectorAll('[data-field="blocked"]')) { text(el, blocked); show(el, !!blocked); }
    for (const el of root.querySelectorAll('.pop-ready-text')) show(el, !blocked);

    if (active && st.take) {
      const running = phase === 'recording';
      if (st.take.elapsedMs !== this.clock.elapsedMs || running !== this.clock.running || !this.clock.at) {
        this.clock = { elapsedMs: st.take.elapsedMs, at: this.win.performance.now(), running };
      }
    } else {
      this.clock = { elapsedMs: 0, at: this.win.performance.now(), running: false };
    }
    // Written here too: frames can be throttled while the window is in the background.
    const timer = root.querySelector('[data-field="timer"]');
    if (timer) text(timer, formatClock(this.clock.elapsedMs));

    for (const b of root.querySelectorAll('[data-action="pause"]')) {
      label(b, phase === 'paused' ? 'Resume' : 'Pause');
      attr(b, 'aria-disabled', phase === 'stopping' ? 'true' : null);
    }
    for (const b of root.querySelectorAll('[data-action="start"]')) {
      label(b, phase === 'countdown' ? `Cancel (${st.countdown})` : st.cancelling ? 'Cancelling…' : counting ? 'Cancel' : 'Start recording');
      attr(b, 'aria-disabled', !counting && (!st.screen || st.preparing || !!blocked) ? 'true' : null);
    }
    for (const b of root.querySelectorAll('[data-action="stop"], [data-action="marker"], [data-action="more"]')) attr(b, 'aria-disabled', phase === 'stopping' ? 'true' : null);
    for (const b of root.querySelectorAll('[data-action="more"]')) attr(b, 'aria-expanded', this.confirming ? 'true' : 'false');
    const confirmText = root.querySelector('[data-part="confirm"] [data-field="confirmText"]');
    if (confirmText && st.take) text(confirmText, `Discard ${formatDuration(st.take.elapsedMs)}? This can’t be undone.`);
    if (st.take) {
      for (const el of root.querySelectorAll('[data-field="markerCount"]')) { text(el, st.take.markers.length ? String(st.take.markers.length) : ''); show(el, st.take.markers.length > 0); }
    }

    // Tell a screen reader in this window what changed.
    const prev = this.prevPhase;
    if (prev !== null && phase !== prev) {
      if (phase === 'recording') this.#say(prev === 'paused' ? 'Recording resumed.' : 'Recording started.');
      else if (phase === 'paused') this.#say('Paused. Not recording.');
      else if (phase === 'stopping') this.#say('Saving…');
      else if (phase === 'review') this.#say('Saved.');
    }
    if (noSound && !this.prevNoSound) this.#say('No sound from your microphone.', true);
    this.prevNoSound = noSound;
    const alertKey = other ? `${other.id}|${other.title}` : '';
    if (other && alertKey !== this.prevAlert) this.#say(`${other.title}. ${other.text}`, other.kind === 'error');
    this.prevAlert = alertKey;
    this.prevPhase = phase;
  }
}
