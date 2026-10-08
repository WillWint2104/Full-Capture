// Composition root of the interface: builds every view, renders each Session
// snapshot into them, and shows the view that matches the phase.

import { $, show } from './dom.js';
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
  setup: 'viewSetup', ready: 'viewSetup', countdown: 'viewSetup',
  recording: 'viewRecording', paused: 'viewRecording', stopping: 'viewRecording',
  review: 'viewReview',
};

export function createUI(session) {
  const meters = new MeterLoop();
  const confirm = createConfirm();
  const notices = new Notices(session, { confirm });
  const render = () => renderAll(session.state);
  const popout = new Popout(session, { meters, toast: n => notices.toast(n), onClose: render });
  const settings = new SettingsView(session, { meters, confirm });
  const chrome = new Chrome(session, { settings, popout });
  popout.keyHandler = e => chrome.handleKey(e);
  wireDialog('helpDialog', ['btnHelp'], 'btnHelpClose');

  const setup = new SetupView(session, { meters, notices, popout, settingsDialog: settings });
  const stage = new Stage(session);
  const recording = new RecordingView(session, { meters, notices, confirm, popout });
  const review = new ReviewView(session, { notices, confirm });
  const parts = [chrome, notices, setup, stage, recording, review, settings, popout];

  function renderAll(st) {
    const current = VIEW_FOR[st.phase] || 'viewSetup';
    for (const id of new Set(Object.values(VIEW_FOR))) show($(id), id === current);
    for (const p of parts) {
      try { p.render(st); } catch (e) { console.error('render failed in', p.constructor.name, e); }
    }
  }

  session.on('change', renderAll);
  // Browsers start audio only after a gesture: resume on the first one.
  const gesture = () => { session.firstGesture(); };
  for (const evt of ['pointerdown', 'keydown']) document.addEventListener(evt, gesture, { capture: true, passive: true });
  renderAll(session.state);
  return { render, popout, notices };
}
