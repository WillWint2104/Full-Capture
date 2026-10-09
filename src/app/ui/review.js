// The Review view (the take you just recorded, or one opened from the list)
// and the "Your takes" library.

import { $, show, text, attr, value, clone, fill, onAction, focusEl, label, displayFilename } from './dom.js';
import { formatDuration, formatBytes, formatTimestamp, formatClock } from '../lib/time.js';

const takeNumber = t => Number((t.filename || '').match(/take (\d+)\)/)?.[1] || 1);
const whenText = ms => new Date(ms).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function savedLine(t) {
  const name = displayFilename(t.filename);
  if (t.savedTo === 'folder') return `Saved to ${t.folderName || 'your folder'} › ${name} ✓`;
  return `Downloaded to your Downloads folder as ${name}`;
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

    const ready = id => $(id).getAttribute('aria-disabled') !== 'true';
    $('btnCopyChapters').addEventListener('click', () => { const r = session.state.review; if (r && ready('btnCopyChapters')) session.copyChapters(r.id); });
    $('btnSaveChapters').addEventListener('click', () => { const r = session.state.review; if (r && ready('btnSaveChapters')) session.saveChaptersFile(r.id); });
    $('btnNewTake').addEventListener('click', () => { session.closeReview(); requestAnimationFrame(() => focusEl($('btnStart'))); });
    $('btnDownloadTake').addEventListener('click', () => { const r = session.state.review; if (r) session.downloadTake(r.id); });
    $('btnDeleteTake').addEventListener('click', () => { const r = session.state.review; if (r) this.deleteTake(r); });
    $('btnFinish').addEventListener('click', () => {
      session.stopScreen();
      notices.toast({ kind: 'success', title: 'Screen sharing stopped', text: 'You’re all done. Your takes are listed below.', timeoutMs: 4000 });
    });

    onAction($('chapterList'), (action, btn, e) => {
      // A double click would delete the next chapter too once the first one goes.
      if (e.detail > 1) return;
      const r = session.state.review;
      const row = btn.closest('.chapter');
      if (r && row && action === 'delete' && !row.dataset.intro) session.deleteMarker(r.id, row.dataset.id);
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
    // "Saved – nice work!" only straight after recording; an older take shows when it was made.
    const kicker = $('reviewKicker');
    show(kicker.querySelector('.review-badge'), !!r.justSaved);
    label(kicker, r.justSaved ? 'Saved – nice work!' : `Recorded ${whenText(r.createdAt)}`);
    attr(kicker, 'data-just-saved', r.justSaved ? 'true' : 'false');
    value($('reviewName'), r.lessonName || '');
    attr($('reviewName'), 'placeholder', 'Untitled lesson');
    text($('reviewSaved'), savedLine(r));
    const help = $('reviewNameHelp');
    if (help) text(help, r.savedTo === 'folder' ? 'Changing the name also renames the file in your folder.' : 'Changes the name in this list. The downloaded file keeps its name.');
    attr($('reviewSaved'), 'data-saved', r.savedTo);

    const notes = [];
    if (r.endedBy === 'share-ended') notes.push(`Recording stopped because screen sharing ended. Everything up to ${formatClock(r.durationMs)} is saved.`);
    if (r.container === 'webm' && !st.formats.mp4) notes.push('Saved as WebM. YouTube and Google Drive accept it. Update Chrome or Edge to save MP4.');
    if (!r.url && !r.playable) notes.push('This take was downloaded in an earlier session, so it can’t be played here. Open it from your Downloads folder.');
    text($('reviewNotice'), notes.join(' '));
    show($('reviewNotice'), notes.length > 0);

    // Chapters: exactly what YouTube gets, including an added opening chapter.
    const list = $('chapterList');
    const hasMarkers = !!r.markers?.length;
    const chapters = hasMarkers ? r.chapters?.chapters || [] : [];
    const hours = r.durationMs >= 3_600_000;
    const sig = JSON.stringify(chapters.map(c => [c.id, c.startMs, c.title, !!c.moved]));
    if (list.dataset.sig !== sig || list.dataset.take !== r.id) {
      list.dataset.sig = sig;
      list.dataset.take = r.id;
      const focusedId = document.activeElement?.closest?.('#chapterList .chapter')?.dataset.id;
      list.replaceChildren(...chapters.map(c => {
        const at = formatTimestamp(c.startMs, hours);
        const el = fill(clone('tplChapter'), { time: at, title: c.title });
        el.dataset.id = c.id;
        if (c.intro) el.dataset.intro = 'true';
        const input = el.querySelector('[data-field="title"]');
        input?.setAttribute('aria-label', c.intro ? `Opening chapter title, at ${at}` : `Chapter title at ${at}`);
        if (c.moved) el.querySelector('[data-field="time"]')?.setAttribute('title', 'Moved to 0:00 – YouTube chapters must start at the beginning');
        const del = el.querySelector('[data-action="delete"]');
        if (del) del.setAttribute('aria-label', `Delete chapter “${c.title}”`);
        if (del && c.intro) { del.disabled = true; del.setAttribute('aria-hidden', 'true'); }
        return el;
      }));
      if (focusedId) list.querySelector(`.chapter[data-id="${CSS.escape(focusedId)}"] [data-field="title"]`)?.focus();
    }
    show($('chapterEmpty'), !hasMarkers);
    const issues = hasMarkers ? r.chapters?.issues || [] : [];
    text($('chapterIssues'), issues.join(' '));
    show($('chapterIssues'), issues.length > 0);
    for (const id of ['btnCopyChapters', 'btnSaveChapters']) {
      attr($(id), 'aria-disabled', hasMarkers ? null : 'true');
      attr($(id), 'aria-describedby', hasMarkers ? null : 'chapterEmpty');
    }

    show($('btnDownloadTake'), !!r.playable);
    label($('btnDownloadTake'), r.savedTo === 'folder' ? 'Download a copy' : 'Download again');
    show($('btnFinish'), !!st.screen);

    if (r.id !== this.prevReviewId) {
      this.prevReviewId = r.id;
      if (st.phase === 'review') {
        this.notices.announce(r.justSaved ? `Saved as ${r.filename}, ${formatDuration(r.durationMs)}.` : `Opened ${r.filename}, ${formatDuration(r.durationMs)}.`);
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
      const sig = JSON.stringify([t.lessonName, t.filename, t.durationMs, t.size, t.chapterCount, t.savedTo, t.folderName, t.thumbnail ? 1 : 0, t.playable, t.createdAt]);
      if (!el || el.dataset.sig !== sig) {
        const name = t.lessonName || t.filename;
        const when = whenText(t.createdAt);
        const n = t.chapterCount || 0;
        const fresh = fill(clone('tplTake'), {
          thumb: t.thumbnail || '',
          name,
          date: when,
          duration: formatDuration(t.durationMs),
          size: formatBytes(t.size),
          chapters: n ? `${n} chapter${n === 1 ? '' : 's'}` : '',
          saved: t.savedTo === 'folder' ? `In “${t.folderName || 'your folder'}”` : 'Downloaded',
        });
        fresh.dataset.id = t.id;
        fresh.dataset.sig = sig;
        fresh.dataset.saved = t.savedTo === 'folder' ? 'folder' : 'download';
        // Each row's buttons say which take they act on.
        const about = `${name}, ${when}`;
        const names = { open: `Play ${about}`, download: `Download ${about}`, 'copy-chapters': `Copy chapters of ${about}`, delete: `Delete ${about}` };
        for (const b of fresh.querySelectorAll('[data-action]')) if (names[b.dataset.action]) b.setAttribute('aria-label', names[b.dataset.action]);
        for (const b of fresh.querySelectorAll('[data-action="download"]')) show(b, !!t.playable);
        for (const b of fresh.querySelectorAll('[data-action="copy-chapters"]')) show(b, n > 0);
        for (const b of fresh.querySelectorAll('[data-field="chapters"]')) show(b, n > 0);
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
