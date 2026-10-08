// The Review view (the take you just recorded, or one opened from the list)
// and the "Your takes" library.

import { $, show, text, attr, value, clone, fill, onAction, focusEl } from './dom.js';
import { formatDuration, formatBytes, formatTimestamp, formatClock } from '../lib/time.js';

const takeNumber = t => Number((t.filename || '').match(/take (\d+)\)/)?.[1] || 1);

function savedLine(t) {
  if (t.savedTo === 'folder') return `Saved to ${t.folderName || 'your folder'} › ${t.filename} ✓`;
  return `Downloaded to your Downloads folder as ${t.filename}`;
}

export class ReviewView {
  constructor(session, { notices, confirm }) {
    this.session = session;
    this.notices = notices;
    this.confirm = confirm;
    this.prevReviewId = null;
    this.takeEls = new Map();

    const name = $('reviewName');
    const commit = () => {
      const r = session.state.review;
      if (r && name.value.trim() && name.value.trim() !== r.lessonName) session.renameTake(r.id, name.value.trim());
    };
    name.addEventListener('change', commit);
    name.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); name.blur(); } });

    $('btnCopyChapters').addEventListener('click', () => { const r = session.state.review; if (r) session.copyChapters(r.id); });
    $('btnSaveChapters').addEventListener('click', () => { const r = session.state.review; if (r) session.saveChaptersFile(r.id); });
    $('btnNewTake').addEventListener('click', () => { session.closeReview(); requestAnimationFrame(() => focusEl($('btnStart'))); });
    $('btnDownloadTake').addEventListener('click', () => { const r = session.state.review; if (r) session.downloadTake(r.id); });
    $('btnDeleteTake').addEventListener('click', () => { const r = session.state.review; if (r) this.deleteTake(r); });
    $('btnFinish').addEventListener('click', () => {
      session.stopScreen();
      notices.toast({ kind: 'success', title: 'Screen sharing stopped', text: 'You’re all done. Your takes are listed below.', timeoutMs: 4000 });
    });

    onAction($('chapterList'), (action, btn) => {
      const r = session.state.review;
      const row = btn.closest('.chapter');
      if (r && row && action === 'delete') session.deleteMarker(r.id, row.dataset.id);
    });
    $('chapterList').addEventListener('change', e => {
      const r = session.state.review;
      const row = e.target.closest('.chapter');
      if (r && row && e.target.matches('[data-field="title"]')) session.renameMarker(r.id, row.dataset.id, e.target.value);
    });

    onAction($('takeList'), (action, btn) => {
      const id = btn.closest('.take')?.dataset.id;
      const t = session.state.library.find(x => x.id === id);
      if (!t) return;
      if (action === 'open') { session.openTake(id); requestAnimationFrame(() => $('stage').scrollIntoView({ block: 'nearest', behavior: 'smooth' })); }
      if (action === 'download') session.downloadTake(id);
      if (action === 'copy-chapters') session.copyChapters(id);
      if (action === 'delete') this.deleteTake(t);
    });
  }

  async deleteTake(t) {
    const inFolder = t.savedTo === 'folder';
    const ok = await this.confirm({
      title: 'Delete this take?',
      text: inFolder
        ? `${t.filename} will be deleted from “${t.folderName || 'your folder'}”. This can’t be undone.`
        : `It will be removed from this list. Delete ${t.filename} from your Downloads folder too.`,
      ok: 'Delete take', cancel: 'Keep it', danger: true,
    });
    if (ok) this.session.deleteTake(t.id);
  }

  render(st) {
    this.#renderReview(st);
    this.#renderLibrary(st);
  }

  #renderReview(st) {
    const r = st.review;
    if (!r) { this.prevReviewId = null; return; }
    text($('reviewHeading'), `Take ${takeNumber(r)} · ${formatDuration(r.durationMs)} · ${formatBytes(r.size)}`);
    value($('reviewName'), r.lessonName || '');
    attr($('reviewName'), 'placeholder', 'Untitled lesson');
    text($('reviewSaved'), savedLine(r));
    attr($('reviewSaved'), 'data-saved', r.savedTo);

    const notes = [];
    if (r.endedBy === 'share-ended') notes.push(`Recording stopped because screen sharing ended. Everything up to ${formatClock(r.durationMs)} is saved.`);
    if (r.container === 'webm' && !st.formats.mp4) notes.push('Saved as WebM. YouTube and Google Drive accept it. Update Chrome or Edge to save MP4.');
    if (!r.url && !r.playable) notes.push('This take was downloaded in an earlier session, so it can’t be played here. Open it from your Downloads folder.');
    text($('reviewNotice'), notes.join(' '));
    show($('reviewNotice'), notes.length > 0);

    // Chapters.
    const list = $('chapterList');
    const markers = [...(r.markers || [])].sort((a, b) => a.atMs - b.atMs);
    const sig = JSON.stringify(markers.map(m => [m.id, m.atMs, m.title]));
    if (list.dataset.sig !== sig || list.dataset.take !== r.id) {
      list.dataset.sig = sig;
      list.dataset.take = r.id;
      const focusedId = document.activeElement?.closest?.('.chapter')?.dataset.id;
      list.replaceChildren(...markers.map(m => {
        const el = fill(clone('tplChapter'), { time: formatTimestamp(m.atMs, r.durationMs >= 3_600_000), title: m.title });
        el.dataset.id = m.id;
        el.querySelector('[data-field="title"]')?.setAttribute('aria-label', `Chapter title at ${formatTimestamp(m.atMs)}`);
        return el;
      }));
      if (focusedId) list.querySelector(`.chapter[data-id="${CSS.escape(focusedId)}"] [data-field="title"]`)?.focus();
    }
    show($('chapterEmpty'), markers.length === 0);
    const issues = markers.length ? r.chapters?.issues || [] : [];
    text($('chapterIssues'), issues.join(' '));
    show($('chapterIssues'), issues.length > 0);
    attr($('btnCopyChapters'), 'aria-disabled', markers.length ? null : 'true');
    attr($('btnSaveChapters'), 'aria-disabled', markers.length ? null : 'true');

    show($('btnDownloadTake'), !!r.playable);
    text($('btnDownloadTake').querySelector('[data-field="label"]') || $('btnDownloadTake'), r.savedTo === 'folder' ? 'Download a copy' : 'Download again');
    show($('btnFinish'), !!st.screen);

    if (r.id !== this.prevReviewId) {
      this.prevReviewId = r.id;
      if (st.phase === 'review') {
        this.notices.announce(`Saved as ${r.filename}, ${formatDuration(r.durationMs)}.`);
        requestAnimationFrame(() => focusEl($('reviewHeading')));
      }
    }
  }

  #renderLibrary(st) {
    const list = $('takeList');
    const rows = st.library;
    show($('libraryEmpty'), rows.length === 0);
    const seen = new Set();
    let before = null;
    for (let i = rows.length - 1; i >= 0; i--) {
      const t = rows[i];
      seen.add(t.id);
      let el = this.takeEls.get(t.id);
      const sig = JSON.stringify([t.lessonName, t.filename, t.durationMs, t.size, t.markers?.length, t.savedTo, t.thumbnail ? 1 : 0, t.playable]);
      if (!el || el.dataset.sig !== sig) {
        const fresh = fill(clone('tplTake'), {
          thumb: t.thumbnail || '',
          name: t.lessonName || t.filename,
          date: new Date(t.createdAt).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
          duration: formatDuration(t.durationMs),
          size: formatBytes(t.size),
          chapters: t.markers?.length ? `${t.markers.length} chapter${t.markers.length === 1 ? '' : 's'}` : '',
          saved: t.savedTo === 'folder' ? `In “${t.folderName || 'your folder'}”` : 'Downloaded',
        });
        fresh.dataset.id = t.id;
        fresh.dataset.sig = sig;
        for (const b of fresh.querySelectorAll('[data-action="download"]')) show(b, !!t.playable);
        for (const b of fresh.querySelectorAll('[data-action="copy-chapters"]')) show(b, !!t.markers?.length);
        for (const b of fresh.querySelectorAll('[data-field="chapters"]')) show(b, !!t.markers?.length);
        if (el) el.replaceWith(fresh); else list.insertBefore(fresh, before);
        el = fresh;
        this.takeEls.set(t.id, el);
      } else if (el.nextElementSibling !== before) {
        list.insertBefore(el, before);
      }
      attr(el, 'aria-current', st.review?.id === t.id ? 'true' : null);
      before = el;
    }
    for (const [id, el] of this.takeEls) if (!seen.has(id)) { el.remove(); this.takeEls.delete(id); }
  }
}
