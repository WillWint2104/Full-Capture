// Everything around the views: theme, the save-location chip, the tab title
// and favicon (so the state is visible from other windows), keyboard
// shortcuts, countdown beeps and the leave-page warning.

import { $, text, attr, label as setLabel } from './dom.js';
import { formatClock } from '../lib/time.js';
import { topAlert, isNoSound } from './notices.js';

const ICON_COLORS = { idle: '#5b6b7f', live: '#c0392b', paused: '#d99a1f', alert: '#c0392b' };
const warning = alert => (alert ? ` · ⚠ ${alert.title}` : '');

function drawFavicon(kind) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = ICON_COLORS[kind] || ICON_COLORS.idle;
  if (kind === 'paused') {
    g.fillRect(14, 10, 13, 44); g.fillRect(37, 10, 13, 44);
  } else if (kind === 'alert') {
    g.beginPath(); g.moveTo(32, 4); g.lineTo(62, 58); g.lineTo(2, 58); g.closePath(); g.fill();
    g.fillStyle = '#fff'; g.fillRect(29, 22, 6, 20); g.fillRect(29, 46, 6, 6);
  } else if (kind === 'live') {
    g.beginPath(); g.arc(32, 32, 26, 0, Math.PI * 2); g.fill();
  } else {
    // Neutral: a rounded screen with a small dot.
    g.beginPath(); g.roundRect(6, 12, 52, 36, 8); g.fill();
    g.fillStyle = '#fff'; g.beginPath(); g.arc(32, 30, 7, 0, Math.PI * 2); g.fill();
    g.fillStyle = ICON_COLORS.idle; g.fillRect(24, 50, 16, 5);
  }
  return c.toDataURL('image/png');
}

export class Chrome {
  constructor(session, { settings, popout, startOrStop }) {
    this.session = session;
    this.settings = settings;
    this.popout = popout;
    this.startOrStop = startOrStop;
    this.favKind = null;
    this.icons = {};
    this.prevCountdown = null;
    this.beepCtx = null;
    this.baseTitle = 'Full Capture';

    $('btnFolder').addEventListener('click', () => {
      const f = session.state.folder;
      if (!f.supported) session.chooseFolder();
      else if (f.status === 'needs-permission') session.reconnectFolder();
      else if (f.status === 'ready') settings.open();
      else session.chooseFolder();
    });

    document.addEventListener('keydown', e => this.#onKey(e), true);
    window.addEventListener('beforeunload', e => {
      if (session.busy) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  /** Shortcuts shared with the floating controls. Returns true if handled. */
  handleKey(e) {
    const st = this.session.state;
    if (e.key === 'Escape' && (st.phase === 'countdown' || st.phase === 'starting' || st.preparing)) { this.session.cancelCountdown(); return true; }
    if (!st.prefs.shortcuts || !e.altKey || e.ctrlKey || e.metaKey) return false;
    const k = e.key.toLowerCase();
    if (!['r', 'p', 'm', 'h'].includes(k)) return false;
    // A held key repeats; act once per press.
    if (e.repeat) return true;
    if (k === 'r') this.startOrStop('keyboard');
    if (k === 'p') this.session.togglePause();
    if (k === 'm') this.session.addMarker();
    // In the floating controls this hides them; here it also shows them again (the key press lets them open).
    if (k === 'h') this.popout.toggle();
    return true;
  }

  #onKey(e) {
    // An open dialog gets Escape (to close itself) and keeps the keyboard.
    if (document.querySelector('dialog[open]')) return;
    const t = e.target;
    // Alt+letter doesn't type into a <select>, so shortcuts still work there.
    const typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA)$/.test(t.tagName)) && !['checkbox', 'radio', 'range'].includes(t.type);
    if (typing && e.key !== 'Escape') return;
    if (this.handleKey(e)) e.preventDefault();
  }

  render(st) {
    // Shortcut hints only while shortcuts work.
    for (const [id, keys] of [['btnStart', 'Alt+R'], ['btnStop', 'Alt+R'], ['btnPause', 'Alt+P'], ['btnMarker', 'Alt+M'], ['btnResumeBig', 'Alt+P'], ['btnPopout', 'Alt+H']]) {
      attr($(id), 'aria-keyshortcuts', st.prefs.shortcuts ? keys : null);
    }

    // Theme.
    const theme = st.prefs.theme;
    attr(document.documentElement, 'data-theme', theme === 'light' || theme === 'dark' ? theme : null);
    attr(document.documentElement, 'data-phase', st.phase);

    // Save-location chip.
    const f = st.folder;
    const chip = $('btnFolder');
    const label = !f.supported ? 'Saving to Downloads'
      : f.status === 'ready' ? `Saving to “${f.name}”`
      : f.status === 'needs-permission' ? `Reconnect “${f.name}”`
      : 'Choose a folder';
    setLabel(chip, label);
    attr(chip, 'data-status', f.supported ? f.status : 'unsupported');

    // Tab title and favicon.
    const lesson = st.lesson.name.trim();
    const suffix = lesson ? ` – ${lesson}` : '';
    // During a take the title is often all the teacher can see (the floating controls may be hidden).
    const live = st.phase === 'recording' || st.phase === 'paused';
    const top = live ? topAlert(st.alerts) : null;
    let title = this.baseTitle + suffix, fav = 'idle';
    if (st.phase === 'countdown') { title = `Starting in ${st.countdown}…${suffix}`; fav = 'live'; }
    else if (st.phase === 'starting') { title = `Starting…${suffix}`; fav = 'live'; }
    else if (top && isNoSound(top)) { title = `⚠ No sound!${suffix}`; fav = 'alert'; }
    // Any other warning joins the state, which stays: paused must never look like recording.
    else if (st.phase === 'recording') { title = `● ${formatClock(st.take?.elapsedMs || 0)} Recording${warning(top)}${suffix}`; fav = top?.kind === 'error' ? 'alert' : 'live'; }
    else if (st.phase === 'paused') { title = `❚❚ Paused${warning(top)}${suffix}`; fav = top?.kind === 'error' ? 'alert' : 'paused'; }
    else if (st.phase === 'stopping') { title = `Saving…${suffix}`; fav = 'live'; }
    if (document.title !== title) document.title = title;
    if (fav !== this.favKind) {
      this.favKind = fav;
      let link = document.querySelector('link[rel~="icon"]');
      if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.append(link); }
      link.href = this.icons[fav] || (this.icons[fav] = drawFavicon(fav));
    }

    // Countdown beeps (the "go" beep is skipped when computer sound is
    // recorded, or it would land in the lesson).
    if (st.phase === 'countdown' && st.countdown !== this.prevCountdown && st.prefs.beeps) this.#beep(660, 0.12);
    if (this.prevPhase === 'countdown' && st.phase === 'recording' && st.prefs.beeps && !st.screen?.hasAudio) this.#beep(990, 0.18);
    this.prevCountdown = st.phase === 'countdown' ? st.countdown : null;
    this.prevPhase = st.phase;
  }

  #beep(freq, seconds) {
    const ctx = this.session.audioContext;
    if (!ctx || ctx.state !== 'running') return;
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + seconds);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + seconds + 0.02);
    osc.onended = () => { osc.disconnect(); gain.disconnect(); };
  }
}
