// Composition root of the interface: builds every view, renders each Session
// snapshot into them, and shows the view that matches the phase.

import { $, show, focusEl, text } from './dom.js';
import { MeterLoop } from './meters.js';
import { Notices } from './notices.js';
import { createConfirm, wireDialog } from './dialogs.js';
import { SetupView } from './setup.js';
import { Stage } from './stage.js';
import { RecordingView } from './recording.js';
import { ReviewView } from './review.js';
import { SettingsView } from './settings.js';
import { Chrome } from './chrome.js';
import { Popout } from './popout.js';

const VIEW_FOR = {
  setup: 'viewSetup', ready: 'viewSetup', countdown: 'viewSetup', starting: 'viewSetup',
  recording: 'viewRecording', paused: 'viewRecording', stopping: 'viewRecording',
  review: 'viewReview',
};

// When the focused control disappears (it did its job), focus goes here
// rather than falling back to the top of the page.
const FOCUS_NEXT = {
  btnMicOn: ['micSelect', 'stepMic'],
  btnSoundCheck: ['scStep', 'btnScAgain'],
  btnScAgain: ['scStep', 'btnSoundCheck'],
  btnChooseScreenBig: ['btnChooseScreen'],
  btnResumeBig: ['btnPause'],
  btnDiscard: ['btnStart'],
  btnStop: ['reviewHeading', 'btnStart'],
  btnDeleteTake: ['btnStart'],
  btnFinish: ['btnNewTake'],
  btnNewTake: ['btnStart'],
  lessonName: ['lessonName'],
};
const PHASE_FOCUS = { setup: 'btnStart', ready: 'btnStart', countdown: 'btnStart', starting: 'btnStart', recording: 'btnStop', paused: 'btnResumeBig', stopping: 'recTimer', review: 'reviewHeading' };

const isShown = el => !!el && el.isConnected && !el.closest('[hidden]') && el.getClientRects().length > 0;
// A view can appear between the two clicks of a double-click (Start records within
// ~30 ms; Stop & save reaches Review within ~100 ms), and the second click would press
// whatever now sits under the pointer, e.g. Pause. Windows' default double-click time.
const VIEW_SETTLE_MS = 500;
const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

export function createUI(session) {
  const meters = new MeterLoop();
  const confirm = createConfirm();
  const notices = new Notices(session, { confirm });
  const render = () => renderAll(session.state);
  const popout = new Popout(session, { notices, toast: n => notices.toast(n), onClose: render });
  const settings = new SettingsView(session, { meters, confirm });
  const startOrStop = source => controller.startOrStop(source);
  const chrome = new Chrome(session, { settings, popout, startOrStop });
  popout.keyHandler = e => chrome.handleKey(e);
  popout.startOrStop = startOrStop;
  wireDialog('helpDialog', ['btnHelp'], 'btnHelpClose');

  const setup = new SetupView(session, { meters, notices, popout, settingsDialog: settings, startOrStop });
  const stage = new Stage(session, { notices });
  const recording = new RecordingView(session, { meters, notices, confirm, popout });
  const review = new ReviewView(session, { notices, confirm });
  const parts = [chrome, notices, setup, stage, recording, review, settings, popout];

  const controller = {
    /**
     * Start (or cancel the countdown, or stop). One path for the big button,
     * Alt+R and the floating Start, so the same microphone rule applies to all.
     * Must run inside the click/key event: the floating controls and the
     * folder prompt need its user activation.
     */
    startOrStop(source = 'button') {
      const st = session.state;
      const idle = ['setup', 'ready', 'review'].includes(st.phase) && !st.preparing;
      if (idle && st.startBlocker) {
        // Said where the press came from, and shown in Set up, where the fix is.
        if (source === 'popout') popout.explainBlocked(st.startBlocker);
        if (st.phase === 'review') {
          session.closeReview();
          requestAnimationFrame(() => setup.explainBlocked(session.state.startBlocker || st.startBlocker));
        } else {
          setup.explainBlocked(st.startBlocker);
        }
        return;
      }
      if (idle && st.prefs.floatingControls && st.screen && !popout.isOpen && popout.supported) popout.open();
      if (idle && !(st.prefs.floatingControls && st.screen)) offerPopoutOnStart = true;
      session.toggleRecord();
    },
  };

  // The floating controls could not open with this start (no screen chosen yet,
  // so the picker needed the click): offer them once recording runs.
  let offerPopoutOnStart = false;
  let prevPhase = null;
  function offerPopout(st) {
    if (prevPhase !== 'recording' && st.phase === 'recording' && offerPopoutOnStart) {
      offerPopoutOnStart = false;
      if (st.prefs.floatingControls && popout.supported && !popout.isOpen) {
        notices.toast({
          id: 'offer-popout', kind: 'info', title: 'Floating controls',
          text: 'Keep the timer, Pause and Stop & save on top of your slides.',
          actions: [{ label: 'Open floating controls', primary: true, run: () => popout.open() }],
          timeoutMs: 12000,
        });
      }
    }
    if (!['countdown', 'starting', 'recording'].includes(st.phase)) offerPopoutOnStart = false;
  }

  // Remember what had focus, so a control that disappears hands focus on.
  let lastFocused = null;
  document.addEventListener('focusin', e => { if (e.target !== document.body) lastFocused = e.target; });
  function rescueFocus(st) {
    const active = document.activeElement;
    const lost = !active || active === document.body || !isShown(active);
    if (!lost || !lastFocused || document.querySelector('dialog[open]')) return;
    if (isShown(lastFocused)) { if (active === document.body) return; lastFocused.focus(); return; }
    const candidates = (FOCUS_NEXT[lastFocused.id] || []).map(id => $(id));
    // Otherwise the nearest control in the same step or section.
    const section = lastFocused.closest?.('.step, section, .card');
    if (section && isShown(section)) candidates.push([...section.querySelectorAll(FOCUSABLE)].find(isShown), section.querySelector('h2, h3'));
    candidates.push($(PHASE_FOCUS[st.phase]));
    const target = candidates.find(isShown);
    if (target) { lastFocused = target; focusEl(target); }
  }

  // Pointer presses on a view in its first moments are ignored (keyboard presses are not).
  let shownView = null, shownAt = -Infinity;
  const settling = e => {
    if (!shownView || performance.now() - shownAt > VIEW_SETTLE_MS || !$(shownView).contains(e.target)) return;
    if (e.type === 'click' && e.detail === 0) return;    // Enter or Space
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  for (const type of ['pointerdown', 'mousedown', 'click']) document.addEventListener(type, settling, { capture: true });

  function renderAll(st) {
    const current = VIEW_FOR[st.phase] || 'viewSetup';
    if (current !== shownView) { if (shownView) shownAt = performance.now(); shownView = current; }
    for (const id of new Set(Object.values(VIEW_FOR))) show($(id), id === current);
    for (const p of parts) {
      try { p.render(st); } catch (e) { console.error('render failed in', p.constructor.name, e); }
    }
    offerPopout(st);
    prevPhase = st.phase;
    // After the browser has laid the new state out.
    requestAnimationFrame(() => rescueFocus(session.state));
  }

  session.on('change', renderAll);
  // Browsers start audio only after a gesture: resume on the first one.
  const gesture = () => { session.firstGesture(); };
  for (const evt of ['pointerdown', 'keydown']) document.addEventListener(evt, gesture, { capture: true, passive: true });
  // Video elements get names a screen reader can say.
  $('screenVideo')?.setAttribute('aria-label', 'Live preview of your screen');
  text($('recTimer'), '00:00');
  renderAll(session.state);
  return { render, popout, notices };
}
