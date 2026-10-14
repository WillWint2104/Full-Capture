// Toasts (brief), sticky banners (critical alerts and recovery cards) and the
// two visually hidden live regions. Everything a screen reader should hear
// goes through those two regions, once.

import { $, clone, fill, show, text, onAction, focusEl } from './dom.js';
import { formatDuration, formatBytes } from '../lib/time.js';

const TOAST_MS = 6000;
let bannerSeq = 0;

/** Alerts that mean the microphone isn't being heard. */
export const isNoSound = a => a.id === 'no-audio' || a.id === 'mic-lost';

/**
 * The alert that matters most right now, for places with room for one (the tab
 * title, the floating controls): no sound first, then errors, then warnings,
 * oldest first. Null when there is none.
 */
export function topAlert(alerts = []) {
  const rank = a => (isNoSound(a) ? 0 : a.kind === 'error' ? 1 : a.kind === 'warning' ? 2 : 3);
  let best = null;
  for (const a of alerts) if (rank(a) < 3 && (!best || rank(a) < rank(best))) best = a;
  return best;
}

export class Notices {
  constructor(session, { confirm }) {
    this.session = session;
    this.confirm = confirm;
    this.toasts = $('toasts');
    this.banners = $('banners');
    this.status = $('srStatus');
    this.alertRegion = $('srAlert');
    this.bannerEls = new Map();   // key -> element
    this.toastIds = new Map();    // notice id -> element (a repeated id replaces the old toast)
    session.on('notice', n => this.toast(n));
    window.addEventListener('scroll', () => this.#placeToasts(), { passive: true });
    window.addEventListener('resize', () => this.#placeToasts());
  }

  /** Announce routine state changes to screen readers. */
  announce(message) {
    if (!message) return;
    // Clearing first makes repeated identical messages announce again.
    text(this.status, '');
    requestAnimationFrame(() => text(this.status, message));
  }

  /** Announce something urgent. */
  shout(message) {
    if (!message) return;
    text(this.alertRegion, '');
    requestAnimationFrame(() => text(this.alertRegion, message));
  }

  toast({ id, kind = 'info', title = '', text: body = '', actions = [], timeoutMs }) {
    if (id && this.toastIds.has(id)) this.toastIds.get(id).remove();
    const el = fill(clone('tplToast'), { title, text: body });
    el.dataset.kind = kind;
    // Announced through the page's live regions, not as a new live region.
    el.removeAttribute('role');
    this.#actions(el, actions, () => this.#dismissToast(el, id));
    onAction(el, a => { if (a === 'dismiss') this.#dismissToast(el, id); });
    this.toasts.prepend(el);
    if (id) this.toastIds.set(id, el);
    const spoken = `${title}. ${body}`.trim();
    if (kind === 'error' || actions.length) this.shout(actions.length ? `${spoken} ${actions.map(a => a.label).join(', ')} button in the message at the top right.` : spoken);
    else this.announce(spoken);
    // Errors and toasts with buttons stay until dismissed; the rest fade, pausing on hover/focus.
    const ms = timeoutMs ?? (kind === 'error' || actions.length ? 0 : TOAST_MS);
    if (ms > 0) {
      let left = ms, started = performance.now(), timer = setTimeout(() => this.#dismissToast(el, id), left);
      const pause = () => { clearTimeout(timer); left -= performance.now() - started; };
      const resume = () => { started = performance.now(); timer = setTimeout(() => this.#dismissToast(el, id), Math.max(1500, left)); };
      el.addEventListener('mouseenter', pause); el.addEventListener('mouseleave', resume);
      el.addEventListener('focusin', pause); el.addEventListener('focusout', resume);
    }
    // Keep the stack short.
    while (this.toasts.children.length > 4) this.toasts.lastElementChild.remove();
    this.#placeToasts();
  }

  #dismissToast(el, id) {
    el.remove();
    if (id && this.toastIds.get(id) === el) this.toastIds.delete(id);
  }

  /** Buttons for session actions, e.g. {label:'Record without my voice', action:'record', args:[…]}. */
  #actions(el, actions, done) {
    const box = el.querySelector('[data-actions]');
    if (!box) return;
    box.replaceChildren();
    show(box, actions.length > 0);
    for (const a of actions) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = a.primary ? 'btn btn-primary btn-small' : 'btn btn-secondary btn-small';
      b.textContent = a.label;
      b.addEventListener('click', async () => {
        if (a.confirm && !(await this.confirm(a.confirm))) return;
        done?.();
        if (typeof a.run === 'function') a.run();
        else if (a.action && typeof this.session[a.action] === 'function') this.session[a.action](...(a.args || []));
      });
      box.append(b);
    }
  }

  /** Toasts sit below the alerts and the paused banner, so they never cover their buttons. */
  #placeToasts() {
    let bottom = 0;
    for (const el of [this.banners, $('recBanner')]) {
      if (!el || el.hidden || !el.children.length) continue;
      bottom = Math.max(bottom, el.getBoundingClientRect().bottom);
    }
    document.documentElement.style.setProperty('--banners-bottom', `${Math.round(Math.max(0, bottom))}px`);
  }

  /** Render the sticky banners from the snapshot: alerts + recovery cards. */
  render(state) {
    const want = new Map();
    for (const a of state.alerts) {
      const sticky = a.id === 'mic-lost' || a.id === 'no-audio';
      want.set(`alert:${a.id}`, {
        kind: a.kind, title: a.title, text: a.text, urgent: true,
        actions: sticky ? [] : [{ label: 'Dismiss', run: () => this.session.dismissAlert(a.id) }],
        dismissible: !sticky,
        onDismiss: () => this.session.dismissAlert(a.id),
      });
    }
    const recording = ['starting', 'recording', 'paused', 'stopping'].includes(state.phase);
    for (const r of state.recovery) {
      const when = r.startedAt ? new Date(r.startedAt).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'earlier';
      const length = r.elapsedMs > 60_000 ? `about ${formatDuration(r.elapsedMs).replace(/ \d+ s$/, '')}` : r.elapsedMs > 0 ? 'under a minute' : (r.bytes ? formatBytes(r.bytes) : 'an unknown length');
      want.set(`recovery:${r.id}`, {
        kind: 'warning', recovery: true,
        title: 'We found a recording that didn’t finish',
        text: r.busy ? `Saving “${r.lessonName || 'Untitled lesson'}”…` : `“${r.lessonName || 'Untitled lesson'}”, ${when}, ${length}. Save it before it’s lost.`,
        actions: recording || r.busy ? [] : [
          { label: 'Save it', primary: true, run: () => this.session.recover(r.id) },
          { label: 'Delete it…', confirm: { title: 'Delete the unfinished recording?', text: 'It will be gone for good. This can’t be undone.', ok: 'Delete recording', danger: true }, run: () => this.session.discardRecovery(r.id) },
        ],
        dismissible: false,
      });
    }

    for (const [key, el] of this.bannerEls) {
      if (!want.has(key)) { el.remove(); this.bannerEls.delete(key); }
    }
    // Show the container first: focusing inside a hidden element does nothing.
    show(this.banners, want.size > 0);
    for (const [key, b] of want) {
      let el = this.bannerEls.get(key);
      const isNew = !el;
      if (isNew) {
        el = clone('tplBanner');
        onAction(el, a => { if (a === 'dismiss') b.onDismiss?.(); });
        this.banners.append(el);
        this.bannerEls.set(key, el);
        const title = el.querySelector('[data-field="title"]');
        if (title) { title.id = `bannerTitle${++bannerSeq}`; el.setAttribute('aria-labelledby', title.id); }
      }
      el.dataset.kind = b.kind;
      // A named region; urgent ones are also spoken once through the alert region.
      el.setAttribute('role', 'region');
      fill(el, { title: b.title, text: b.text });
      const sig = JSON.stringify(b.actions.map(a => a.label));
      if (el.dataset.sig !== sig) { el.dataset.sig = sig; this.#actions(el, b.actions); }
      for (const d of el.querySelectorAll('[data-action="dismiss"]')) show(d, !!b.dismissible);
      if (isNew && b.urgent) this.shout(`${b.title}. ${b.text}`);
      if (isNew && b.recovery) {
        this.announce(`${b.title}. ${b.text}`);
        requestAnimationFrame(() => focusEl(el.querySelector('[data-field="title"]')));
      }
    }
    // After the other views have rendered (the paused banner is theirs).
    requestAnimationFrame(() => this.#placeToasts());
  }
}
