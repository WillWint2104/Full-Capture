// Floating controls: a Document Picture-in-Picture window that stays on top
// of other apps, so the teacher can see the timer and sound level, and pause,
// add chapters or stop without coming back to this tab. Its markup comes
// from <template id="tplPopout">; its styles are copied from this page.

import { clone, fill, show, text, attr, onAction, label } from './dom.js';
import { Meter, MeterLoop } from './meters.js';
import { formatClock, formatDuration } from '../lib/time.js';

export class Popout {
  constructor(session, { notices, toast, onClose } = {}) {
    this.session = session;
    this.notices = notices;
    this.toast = toast;
    this.onClose = onClose;
    this.keyHandler = null;   // set by the app: shared shortcut handler
    this.startOrStop = null;  // set by the app: the one Start path (same microphone rule as the big button)
    this.win = null;
    this.opening = false;
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

  /** Must be called from a click (it needs the click's user activation). */
  async open() {
    if (this.win) { try { this.win.focus(); } catch { /* ignore */ } return true; }
    if (this.opening) return false;
    if (!this.supported) {
      this.toast?.({ kind: 'info', title: 'Floating controls need Chrome or Edge 116+', text: 'You can keep this tab open on your other screen instead.' });
      return false;
    }
    this.opening = true;
    try {
      this.win = await documentPictureInPicture.requestWindow({ width: 320, height: 420, disallowReturnToOpener: false });
    } catch (e) {
      this.opening = false;
      this.toast?.({ kind: 'warning', title: 'Couldn’t open the floating controls', text: e.message || String(e) });
      return false;
    }
    this.opening = false;
    this.#build();
    return true;
  }

  close() { try { this.win?.close(); } catch { /* already closed */ } }

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
    const root = this.root;
    if (!root) return;
    const phase = st.phase;
    const active = ['recording', 'paused', 'stopping'].includes(phase);
    const counting = phase === 'countdown' || phase === 'starting';
    const noSound = active && st.alerts.some(a => a.id === 'no-audio' || a.id === 'mic-lost');
    if (!active) this.confirming = false;

    const part = name => root.querySelector(`[data-part="${name}"]`);
    show(part('idle'), !active && !counting);
    show(part('active'), active && !this.confirming);
    show(part('confirm'), active && this.confirming);
    show(part('nosound'), noSound);
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
      label(b, phase === 'countdown' ? `Cancel (${st.countdown})` : phase === 'starting' ? 'Cancel' : 'Start recording');
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
    this.prevPhase = phase;
  }
}
