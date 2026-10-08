// Small DOM helpers shared by the UI modules.

export const $ = (id, root = document) => root.getElementById ? root.getElementById(id) : root.querySelector(`#${id}`);

/** Show or hide with the `hidden` attribute (CSS forces display:none). */
export function show(el, visible) {
  if (!el) return;
  if (visible) el.removeAttribute('hidden');
  else el.setAttribute('hidden', '');
}

/** Set text only when it changed (avoids needless layout and screen-reader chatter). */
export function text(el, value) {
  if (!el) return;
  const v = value == null ? '' : String(value);
  if (el.textContent !== v) el.textContent = v;
}

/**
 * Set a button's (or chip's) visible words without wiping icons inside it:
 * uses a [data-field="label"] child when there is one, otherwise the last
 * non-empty text node, otherwise appends one.
 */
export function label(el, value) {
  if (!el) return;
  const field = el.querySelector('[data-field="label"]');
  if (field) return text(field, value);
  if (!el.children.length) return text(el, value);
  const v = value == null ? '' : String(value);
  const nodes = [...el.childNodes].filter(n => n.nodeType === Node.TEXT_NODE && n.nodeValue.trim());
  const node = nodes[nodes.length - 1];
  if (node) { if (node.nodeValue.trim() !== v) node.nodeValue = v; }
  else el.append(document.createTextNode(v));
}

/** Show/hide an optional chip together with a wrapper that only exists for it (e.g. "Headset found: [Use it]"). */
export function showWithWrapper(el, visible) {
  if (!el) return;
  show(el, visible);
  const parent = el.parentElement;
  if (parent && !parent.id && !parent.querySelector('[id]:not(#' + CSS.escape(el.id) + ')')) show(parent, visible);
}

/** A 0..1 progress value on either a <progress> or a styled element. */
export function progress(el, fraction) {
  if (!el) return;
  const f = Math.max(0, Math.min(1, Number(fraction) || 0));
  if (el.tagName === 'PROGRESS') { if (!el.max || el.max === 1) el.max = 1; el.value = f * (el.max || 1); }
  el.style.setProperty('--level', String(f));
  attr(el, 'aria-valuenow', Math.round(f * 100));
}

/** Set an attribute, or remove it when value is null/false. */
export function attr(el, name, value) {
  if (!el) return;
  if (value == null || value === false) { if (el.hasAttribute(name)) el.removeAttribute(name); return; }
  const v = value === true ? '' : String(value);
  if (el.getAttribute(name) !== v) el.setAttribute(name, v);
}

/** Update a form control unless the teacher is editing it right now. */
export function value(el, v) {
  if (!el || el === el.ownerDocument.activeElement) return;
  if (el.type === 'checkbox' || el.type === 'radio') { if (el.checked !== !!v) el.checked = !!v; return; }
  const s = v == null ? '' : String(v);
  if (el.value !== s) el.value = s;
}

/** Clone a <template> by id; returns its first element. */
export function clone(templateId, doc = document) {
  const t = doc.getElementById(templateId);
  return t.content.firstElementChild.cloneNode(true);
}

/** Fill [data-field] elements inside root from an object (img fields get src). */
export function fill(root, fields) {
  for (const [name, v] of Object.entries(fields)) {
    for (const el of root.querySelectorAll(`[data-field="${name}"]`)) {
      if (el.tagName === 'IMG') { if (v) el.src = v; show(el, !!v); }
      else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') value(el, v);
      else text(el, v);
    }
  }
  return root;
}

/** Delegate clicks on [data-action] inside root. */
export function onAction(root, handler) {
  root.addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (btn && root.contains(btn) && !btn.matches('[aria-disabled="true"]')) handler(btn.dataset.action, btn, e);
  });
}

/** Map dBFS to a 0..1 meter position (-60 dB = empty, 0 dB = full). */
export const dbToLevel = db => Math.max(0, Math.min(1, ((Number.isFinite(db) ? db : -100) + 60) / 60));

/** Voice-level zones used by every meter (RMS, dBFS). */
export function zoneFor(rmsDb, peakDb) {
  if (peakDb > -1.5 || rmsDb > -12) return 'loud';
  if (rmsDb >= -28) return 'good';
  return 'quiet';
}

/** Focus an element without scrolling it off-screen; makes headings focusable. */
export function focusEl(el) {
  if (!el) return;
  if (!el.hasAttribute('tabindex') && !/^(BUTTON|INPUT|SELECT|TEXTAREA|A)$/.test(el.tagName)) el.setAttribute('tabindex', '-1');
  el.focus({ preventScroll: false });
}
