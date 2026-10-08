// Toasts (brief, role=status), sticky banners (critical alerts and recovery
// cards, role=alert) and the two visually hidden live regions.

import { $, clone, fill, show, text, onAction, focusEl } from './dom.js';
import { formatDuration, formatBytes } from '../lib/time.js';

const TOAST_MS = 5000;

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
  }

  /** Announce routine state changes to screen readers. */
  announce(message) {
    // Clearing first makes repeated identical messages announce again.
    text(this.status, '');
    requestAnimationFrame(() => text(this.status, message));
  }

  /** Announce something urgent. */
  shout(message) {
    text(this.alertRegion, '');
    requestAnimationFrame(() => text(this.alertRegion, message));
  }

  toast({ id, kind = 'info', title = '', text: body = '', actions = [], timeoutMs }) {
    if (id && this.toastIds.has(id)) this.toastIds.get(id).remove();
    const el = fill(clone('tplToast'), { title, text: body });
    el.dataset.kind = kind;
    el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    this.#actions(el, actions, () => this.#dismissToast(el, id));
    onAction(el, a => { if (a === 'dismiss') this.#dismissToast(el, id); });
    this.toasts.prepend(el);
    if (id) this.toastIds.set(id, el);
    // Errors and toasts with buttons stay until dismissed; the rest fade, pausing on hover/focus.
    const ms = timeoutMs ?? (kind === 'error' || actions.length ? 0 : TOAST_MS);
    if (ms > 0) {
      let left = ms, started = performance.now(), timer = setTimeout(() => this.#dismissToast(el, id), left);
      const pause = () => { clearTimeout(timer); left -= performance.now() - started; };
      const resume = () => { started = performance.now(); timer = setTimeout(() => this.#dismissToast(el, id), Math.max(1200, left)); };
      el.addEventListener('mouseenter', pause); el.addEventListener('mouseleave', resume);
      el.addEventListener('focusin', pause); el.addEventListener('focusout', resume);
    }
    // Keep the stack short.
    while (this.toasts.children.length > 4) this.toasts.lastElementChild.remove();
  }

  #dismissToast(el, id) {
    el.remove();
    if (id && this.toastIds.get(id) === el) this.toastIds.delete(id);
  }

  /** Buttons for session actions, e.g. {label:'Record without sound', action:'record', args:[…]}. */
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

  /** Render the sticky banners from the snapshot: alerts + recovery cards. */
  render(state) {
    const want = new Map();
    for (const a of state.alerts) {
      want.set(`alert:${a.id}`, {
        kind: a.kind, title: a.title, text: a.text, role: 'alert',
        actions: a.id === 'mic-lost' || a.id === 'no-audio' ? [] : [{ label: 'Dismiss', run: () => this.session.dismissAlert(a.id) }],
        dismissible: a.id !== 'mic-lost' && a.id !== 'no-audio',
        onDismiss: () => this.session.dismissAlert(a.id),
      });
    }
    const recording = ['recording', 'paused', 'stopping'].includes(state.phase);
    for (const r of state.recovery) {
      const when = r.startedAt ? new Date(r.startedAt).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'earlier';
      const length = r.elapsedMs > 60_000 ? `about ${formatDuration(r.elapsedMs).replace(/ \d+ s$/, '')}` : r.elapsedMs > 0 ? 'under a minute' : (r.bytes ? formatBytes(r.bytes) : 'an unknown length');
      want.set(`recovery:${r.id}`, {
        kind: 'warning', role: 'region', recovery: true,
        title: 'We found a recording that didn’t finish',
        text: `“${r.lessonName || 'Untitled lesson'}”, ${when}, ${length}. Save it before it’s lost.`,
        actions: recording ? [] : [
          { label: 'Save it', primary: true, run: () => this.session.recover(r.id) },
          { label: 'Delete it…', confirm: { title: 'Delete the unfinished recording?', text: 'It will be gone for good. This can’t be undone.', ok: 'Delete recording', danger: true }, run: () => this.session.discardRecovery(r.id) },
        ],
        dismissible: false,
      });
    }

    for (const [key, el] of this.bannerEls) {
      if (!want.has(key)) { el.remove(); this.bannerEls.delete(key); }
    }
    for (const [key, b] of want) {
      let el = this.bannerEls.get(key);
      const isNew = !el;
      if (isNew) {
        el = clone('tplBanner');
        onAction(el, a => { if (a === 'dismiss') b.onDismiss?.(); });
        this.banners.append(el);
        this.bannerEls.set(key, el);
      }
      el.dataset.kind = b.kind;
      el.setAttribute('role', b.role);
      fill(el, { title: b.title, text: b.text });
      const sig = JSON.stringify(b.actions.map(a => a.label));
      if (el.dataset.sig !== sig) { el.dataset.sig = sig; this.#actions(el, b.actions); }
      for (const d of el.querySelectorAll('[data-action="dismiss"]')) show(d, !!b.dismissible);
      if (isNew && b.role === 'alert') this.shout(`${b.title}. ${b.text}`);
      if (isNew && b.recovery) focusEl(el.querySelector('[data-field="title"]'));
    }
    show(this.banners, this.bannerEls.size > 0);
  }
}
