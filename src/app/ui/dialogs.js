// In-page dialogs: confirm (never the native confirm(), which freezes the
// floating controls), settings and help. Focus returns to the opener.

import { $, text } from './dom.js';

export function createConfirm() {
  const dlg = $('confirmDialog');
  const title = $('confirmTitle'), body = $('confirmText');
  const ok = $('btnConfirmOk'), cancel = $('btnConfirmCancel');
  let pending = null;

  const finish = result => {
    if (!pending) return;
    const { resolve, opener } = pending;
    pending = null;
    if (dlg.open) dlg.close();
    opener?.focus?.();
    resolve(result);
  };
  ok.addEventListener('click', () => finish(true));
  cancel.addEventListener('click', () => finish(false));
  dlg.addEventListener('cancel', e => { e.preventDefault(); finish(false); });
  dlg.addEventListener('close', () => finish(false));

  /** @returns {Promise<boolean>} */
  return function confirm({ title: t, text: b = '', ok: okLabel = 'OK', cancel: cancelLabel = 'Cancel', danger = false }) {
    if (pending) finish(false);
    return new Promise(resolve => {
      pending = { resolve, opener: document.activeElement };
      text(title, t); text(body, b); text(ok, okLabel); text(cancel, cancelLabel);
      ok.classList.toggle('btn-danger', danger);
      dlg.showModal();
      cancel.focus();   // the safe choice is the default
    });
  };
}

/** Open/close wiring for a simple dialog with a close button. */
export function wireDialog(dialogId, openButtonIds, closeButtonId, { onOpen } = {}) {
  const dlg = $(dialogId);
  let opener = null;
  const open = () => { opener = document.activeElement; onOpen?.(); if (!dlg.open) dlg.showModal(); };
  for (const id of openButtonIds) $(id)?.addEventListener('click', open);
  $(closeButtonId)?.addEventListener('click', () => dlg.close());
  dlg.addEventListener('close', () => opener?.focus?.());
  // Click on the backdrop closes it.
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
  return { open, close: () => dlg.close(), get isOpen() { return dlg.open; } };
}
