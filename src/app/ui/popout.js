// Floating controls: a Document Picture-in-Picture window that stays on top
// of other apps, so the teacher can see the timer and sound level, and pause,
// add chapters or stop without coming back to this tab. Its markup comes
// from <template id="tplPopout">; its styles are copied from this page.

import { clone, fill, show, text, attr, onAction } from './dom.js';
import { Meter } from './meters.js';
import { formatClock, formatDuration } from '../lib/time.js';

export class Popout {
  constructor(session, { meters, toast, onClose }) {
    this.session = session;
    this.meters = meters;
    this.toast = toast;
    this.onClose = onClose;
    this.keyHandler = null;   // set by the app: shared shortcut handler
    this.win = null;
    this.opening = false;
    this.meter = null;
    this.offMeterLoop = null;
    this.confirming = false;
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
      this.toast({ kind: 'info', title: 'Floating controls need Chrome or Edge 116+', text: 'You can keep this tab open on your other screen instead.' });
      return false;
    }
    this.opening = true;
    try {
      this.win = await documentPictureInPicture.requestWindow({ width: 320, height: 420, disallowReturnToOpener: false });
    } catch (e) {
      this.opening = false;
      this.toast({ kind: 'warning', title: 'Couldn’t open the floating controls', text: e.message || String(e) });
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
    d.body.classList.add('popout');
    const root = clone('tplPopout', document);
    d.body.append(d.adoptNode(root));
    this.root = root;

    const meterEl = root.querySelector('[data-field="meter"]') || root.querySelector('.meter');
    this.meter = new Meter(meterEl, root.querySelector('[data-field="micLabel"]'), {
      labels: { good: 'We can hear you ✓', quiet: 'Too quiet', loud: 'Too loud', off: 'No sound' },
    });
    this.offMeterLoop = this.meters.add(this.meter);
    this.offTick = this.meters.onFrame(now => this.#tickClock(now));

    onAction(root, action => this.#act(action));
    d.addEventListener('keydown', e => {
      if (this.keyHandler?.(e)) e.preventDefault();
      if (e.key === 'Escape' && this.confirming) { this.confirming = false; this.render(this.session.state); }
    });

    // The pop-out stays visible while this tab is hidden, so its wake lock
    // keeps the PC awake for the whole lesson.
    w.navigator.wakeLock?.request('screen').then(lock => { this.wakeLock = lock; }).catch(() => {});
    this.offChange = this.session.on('change', this.onChange);
    this.offMeter = this.session.on('meter', this.onMeter);
    w.addEventListener('pagehide', () => this.#teardown(), { once: true });
    this.render(this.session.state);
  }

  #teardown() {
    this.offChange?.(); this.offMeter?.(); this.offMeterLoop?.(); this.offTick?.();
    this.wakeLock?.release().catch(() => {}); this.wakeLock = null;
    this.win = null; this.root = null; this.meter = null; this.confirming = false;
    this.onClose?.();
  }

  #act(action) {
    const s = this.session;
    switch (action) {
      case 'start': s.toggleRecord(); break;
      case 'stop': s.stop(); break;
      case 'pause': s.togglePause(); break;
      case 'marker': s.addMarker(); break;
      case 'more': this.confirming = true; this.render(s.state); break;
      case 'discard-no': this.confirming = false; this.render(s.state); break;
      case 'discard-yes': this.confirming = false; s.cancelTake(); break;
    }
  }

  #tickClock(now) {
    if (!this.root) return;
    const c = this.clock;
    const ms = c.running ? c.elapsedMs + (now - c.at) : c.elapsedMs;
    const timer = this.root.querySelector('[data-field="timer"]');
    if (timer && c.at) text(timer, formatClock(ms));
  }

  render(st) {
    const root = this.root;
    if (!root) return;
    const phase = st.phase;
    const active = ['recording', 'paused', 'stopping'].includes(phase);
    const counting = phase === 'countdown';
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

    const pill = phase === 'paused' ? '❚❚ PAUSED' : phase === 'stopping' ? 'SAVING…' : active ? (noSound ? '⚠ NO SOUND' : '● REC') : counting ? 'STARTING…' : st.screen ? 'READY' : 'CHOOSE A SCREEN';
    fill(root, {
      pill,
      lesson: st.lesson.name.trim() || 'Untitled lesson',
      notes: st.lesson.notes,
      countdown: counting ? String(st.countdown) : '',
    });
    for (const el of root.querySelectorAll('[data-field="pill"]')) attr(el, 'data-state', noSound ? 'nosound' : phase);
    for (const el of root.querySelectorAll('[data-field="notes"]')) show(el, !!st.lesson.notes.trim());
    for (const el of root.querySelectorAll('[data-field="countdown"]')) show(el, counting);

    if (active && st.take) {
      const running = phase === 'recording';
      if (st.take.elapsedMs !== this.clock.elapsedMs || running !== this.clock.running) this.clock = { elapsedMs: st.take.elapsedMs, at: performance.now(), running };
    } else {
      this.clock = { elapsedMs: 0, at: performance.now(), running: false };
    }

    for (const b of root.querySelectorAll('[data-action="pause"]')) {
      text(b.querySelector('[data-field="label"]') || b, phase === 'paused' ? 'Resume' : 'Pause');
      attr(b, 'aria-pressed', phase === 'paused' ? 'true' : 'false');
    }
    for (const b of root.querySelectorAll('[data-action="start"]')) {
      text(b.querySelector('[data-field="label"]') || b, counting ? `Cancel (${st.countdown})` : 'Start recording');
      attr(b, 'aria-disabled', !counting && !st.screen ? 'true' : null);
    }
    for (const b of root.querySelectorAll('[data-action="stop"], [data-action="marker"], [data-action="more"]')) attr(b, 'aria-disabled', phase === 'stopping' ? 'true' : null);
    const confirmText = root.querySelector('[data-part="confirm"] [data-field="confirmText"]');
    if (confirmText && st.take) text(confirmText, `Discard ${formatDuration(st.take.elapsedMs)}? This can’t be undone.`);
    if (st.take) {
      for (const el of root.querySelectorAll('[data-field="markerCount"]')) { text(el, st.take.markers.length ? String(st.take.markers.length) : ''); show(el, st.take.markers.length > 0); }
    }
  }
}
