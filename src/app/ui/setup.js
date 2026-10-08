// The Set up view: numbered steps (lesson, microphone + sound check, screen,
// camera), the readiness line and the Start recording button.

import { $, show, text, attr, value, clone, fill, onAction, focusEl, label, showWithWrapper, progress, displayFilename } from './dom.js';
import { Meter } from './meters.js';
import { makeFilename, suggestNextName } from '../lib/names.js';
import { fixSteps } from '../audio/fixsteps.js';
import { TEST_LINE } from '../audio/soundcheck.js';

const HEADSET = /headset|headphone|earphone|earbud|airpods|buds|jabra|plantronics|poly|logitech h|hyperx|steelseries/i;
const CORNERS = { btnCornerTL: { x: 0.1, y: 0.15 }, btnCornerTR: { x: 0.9, y: 0.15 }, btnCornerBL: { x: 0.1, y: 0.85 }, btnCornerBR: { x: 0.9, y: 0.85 } };

/** "Default - Headset Microphone (Jabra)" -> "Headset Microphone (Jabra) (Windows default)". */
export function friendlyMicLabel(d) {
  const label = (d.label || '').replace(/^(Default|Communications) - /, '');
  if (d.deviceId === 'default') return `${label || 'Microphone'} (Windows default)`;
  if (d.deviceId === 'communications') return `${label || 'Microphone'} (Windows communications)`;
  return label || 'Microphone';
}

const shortLabel = l => (l || '').replace(/^(Default|Communications) - /, '').replace(/\s*\([^)]*\)\s*$/, '') || 'Microphone';

function setOptions(select, items, selected, labelOf) {
  const sig = JSON.stringify(items.map(i => [i.deviceId, i.label]));
  if (select.dataset.sig !== sig) {
    select.dataset.sig = sig;
    select.replaceChildren(...items.map(i => new Option(labelOf(i), i.deviceId)));
  }
  value(select, selected);
  // An id from an earlier visit (or none yet) shows the device actually in use, never a blank box.
  if (select.selectedIndex < 0 && select.options.length) select.selectedIndex = 0;
}

function message(container, msg, onAct) {
  if (!container) return;
  const sig = msg ? JSON.stringify([msg.kind, msg.title, msg.text, (msg.actions || []).map(a => a.label)]) : '';
  if (container.dataset.sig === sig) return;
  container.dataset.sig = sig;
  container.replaceChildren();
  show(container, !!msg);
  if (!msg) return;
  const el = fill(clone('tplMessage'), { title: msg.title, text: msg.text });
  el.dataset.kind = msg.kind || 'info';
  const box = el.querySelector('[data-actions]');
  if (box) {
    box.replaceChildren();
    show(box, !!msg.actions?.length);
    for (const a of msg.actions || []) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn-secondary btn-small';
      b.textContent = a.label;
      b.addEventListener('click', () => onAct(a));
      box.append(b);
    }
  }
  container.append(el);
}

export class SetupView {
  constructor(session, { meters, notices, popout, settingsDialog }) {
    this.session = session;
    this.notices = notices;
    this.popout = popout;
    this.settingsDialog = settingsDialog;
    this.expanded = new Set();     // steps the teacher re-opened with "Change"
    this.freshResult = false;      // a new sound-check verdict the teacher hasn't moved past
    this.lessonDone = false;       // the teacher confirmed the name this visit (then the step may fold)
    this.prevPhase = null;
    this.prevScPhase = null;
    this.prevResult = null;
    this.prevScreen = null;

    this.micMeter = new Meter($('micMeter'), $('micMeterLabel'));
    meters.add(this.micMeter);
    session.on('meter', m => this.micMeter.set(m.voice?.rmsDb ?? -100, m.voice?.peakDb ?? -100));

    this.#wire();
  }

  #wire() {
    const s = this.session;
    $('lessonName').addEventListener('input', e => s.setLessonName(e.target.value));
    // Fold the lesson step once the teacher has settled on a name this visit
    // (a name remembered from last time stays open, so it gets a second look).
    $('lessonName').addEventListener('change', e => {
      if (!e.target.value.trim()) return;
      this.lessonDone = true;
      this.expanded.delete('stepLesson');
      requestAnimationFrame(() => this.render(s.state));
    });
    $('lessonName').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });
    $('lessonSuggest').addEventListener('click', () => {
      const next = suggestNextName(s.state.lesson.name);
      if (next) { s.setLessonName(next); $('lessonName').value = next; this.lessonDone = true; this.expanded.delete('stepLesson'); }
    });
    $('notes').addEventListener('input', e => s.setNotes(e.target.value));

    $('btnMicOn').addEventListener('click', () => s.enableMic());
    $('micSelect').addEventListener('change', e => s.setMicDevice(e.target.value));
    $('micSuggest').addEventListener('click', e => { const id = e.currentTarget.dataset.deviceId; if (id) s.setMicDevice(id); });
    $('noiseToggle').addEventListener('change', e => s.setAudioMode(e.target.checked ? 'clean' : 'studio'));
    $('btnSoundCheck').addEventListener('click', () => { this.expanded.add('stepMic'); s.startSoundCheck(); });
    $('btnScAgain').addEventListener('click', () => s.startSoundCheck());
    $('btnScPlay').addEventListener('click', () => {
      const a = $('scAudio');
      if (!a.src) return;
      if (a.paused) { a.currentTime = 0; a.play().catch(() => {}); } else a.pause();
    });
    $('scAudio').addEventListener('play', () => label($('btnScPlay'), 'Stop'));
    $('scAudio').addEventListener('pause', () => label($('btnScPlay'), 'Hear it back'));
    $('scAudio').addEventListener('ended', () => label($('btnScPlay'), 'Hear it back'));
    $('btnScCopySteps').addEventListener('click', () => s.copyFixSteps());
    $('btnScCopyPrompt').addEventListener('click', () => s.copyDesktopPrompt());
    this.#wireSummary('micSummary', 'stepMic');

    $('btnChooseScreen').addEventListener('click', () => { this.expanded.delete('stepScreen'); s.chooseScreen(); });
    $('btnChooseScreenBig').addEventListener('click', () => s.chooseScreen());
    this.#wireSummary('screenSummary', 'stepScreen');

    $('cameraToggle').addEventListener('change', e => s.setCamera(e.target.checked));
    $('cameraSelect').addEventListener('change', e => s.setCameraDevice(e.target.value));
    for (const r of document.querySelectorAll('input[name="bubbleShape"]')) r.addEventListener('change', e => e.target.checked && s.setBubble({ shape: e.target.value }));
    for (const r of document.querySelectorAll('input[name="bubbleSize"]')) r.addEventListener('change', e => e.target.checked && s.setBubble({ size: e.target.value }));
    $('bubbleMirror').addEventListener('change', e => s.setBubble({ mirror: e.target.checked }));
    for (const [id, pos] of Object.entries(CORNERS)) $(id).addEventListener('click', () => s.setBubble(pos));

    $('btnStart').addEventListener('click', () => this.#onStart());

    // Helper buttons a design may add: "Change" on a collapsed step, "Cancel" on the sound check.
    document.addEventListener('click', e => {
      const btn = e.target.closest('[data-action="expand-step"], [data-action="change"], [data-action="cancel-sound-check"]');
      if (!btn || btn.closest('template')) return;
      if (btn.dataset.action === 'cancel-sound-check') { s.cancelSoundCheck(); return; }
      const step = btn.closest('section.step, .step');
      if (!step?.id) return;
      this.expanded.add(step.id);
      this.render(s.state);
      focusEl(step.querySelector('h2'));
    });
  }

  /** A collapsed step's summary line without its own "Change" button re-opens the step when clicked. */
  #wireSummary(summaryId, stepId) {
    const el = $(summaryId);
    el.addEventListener('click', e => {
      if (e.target.closest('button, a, [data-action]') || el.querySelector('button, [data-action]')) return;
      this.expanded.add(stepId);
      this.render(this.session.state);
      focusEl($(stepId).querySelector('h2'));
    });
  }

  #onStart() {
    const st = this.session.state;
    const btn = $('btnStart');
    if (btn.getAttribute('aria-disabled') === 'true') {
      text($('startHint'), 'Turn on your microphone first, or choose “Record without my voice” in Settings.');
      show($('startHint'), true);
      this.expanded.add('stepMic');
      this.render(st);
      focusEl($('stepMic').querySelector('h2'));
      ($('btnMicOn').offsetParent ? $('btnMicOn') : $('stepMic'))?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    show($('startHint'), false);
    // The floating controls need this click's user activation, so open them
    // before anything async (only when the screen is already chosen: the
    // screen picker needs the activation otherwise).
    if (st.phase !== 'countdown' && st.prefs.floatingControls && st.screen && !this.popout.isOpen) this.popout.open();
    this.session.toggleRecord();
  }

  render(st) {
    const inSetup = ['setup', 'ready', 'countdown'].includes(st.phase);
    if (st.screen && !this.prevScreen) this.freshResult = false;
    this.prevScreen = st.screen;
    this.#renderLesson(st);
    this.#renderMic(st);
    this.#renderScreen(st);
    this.#renderCamera(st);
    this.#renderStart(st);
    this.#announce(st, inSetup);
    this.prevPhase = st.phase;
  }

  #step(id, status, collapsed) {
    const el = $(id);
    attr(el, 'data-status', status);
    attr(el, 'data-collapsed', collapsed ? '' : null);
  }

  #renderLesson(st) {
    const name = st.lesson.name;
    value($('lessonName'), name);
    value($('notes'), st.lesson.notes);
    const editing = $('stepLesson').contains(document.activeElement) && document.activeElement !== document.body;
    this.#step('stepLesson', name.trim() ? 'done' : 'todo', !!name.trim() && this.lessonDone && !editing && !this.expanded.has('stepLesson'));
    text($('lessonChip'), name.trim() ? 'Done ✓' : 'To do');
    // Suggest the next lesson in a series once this one has been recorded.
    const next = suggestNextName(name);
    const recorded = next && st.library.some(t => (t.lessonName || '').trim() === name.trim());
    showWithWrapper($('lessonSuggest'), !!recorded);
    if (recorded) label($('lessonSuggest'), `${next}?`);
    text($('fileNamePreview'), `Will save as: ${displayFilename(makeFilename({ lessonName: name, ext: st.estimate?.container || 'mp4' }))}`);
  }

  #renderMic(st) {
    const { mic, audio, soundCheck: sc } = st;
    const live = mic.status === 'live';
    const err = st.micError;
    const noVoice = st.prefs.noVoice;

    show($('micIntro'), !noVoice && (mic.status === 'needs-permission' || mic.status === 'starting'));
    attr($('btnMicOn'), 'aria-disabled', mic.status === 'starting' ? 'true' : null);
    label($('btnMicOn'), mic.status === 'starting' ? 'Starting…' : 'Turn on microphone');
    show($('micControls'), live || mic.status === 'lost' || mic.status === 'notfound' || mic.status === 'busy');

    setOptions($('micSelect'), mic.devices.length ? mic.devices : [{ deviceId: 'default', label: mic.label || '' }], mic.deviceId, friendlyMicLabel);
    const headset = mic.devices.find(d => HEADSET.test(d.label) && d.deviceId !== 'default' && d.deviceId !== 'communications');
    const usingHeadset = HEADSET.test(mic.label || '');
    showWithWrapper($('micSuggest'), live && !!headset && !usingHeadset);
    if (headset) { $('micSuggest').dataset.deviceId = headset.deviceId; label($('micSuggest'), `Use ${shortLabel(headset.label)}`); attr($('micSuggest'), 'title', 'A headset usually sounds clearer'); }
    value($('noiseToggle'), audio.mode === 'clean');

    // Inline problem card.
    let msg = null;
    if (noVoice) msg = { kind: 'info', title: 'Recording without your voice', text: 'Your microphone is off on purpose.', actions: [{ label: 'Turn on microphone', run: () => this.session.setNoVoice(false) }] };
    else if (err && !live) msg = { kind: err.status === 'notfound' ? 'warning' : 'error', title: err.title, text: err.text, actions: [{ label: 'Try again', run: () => this.session.enableMic() }] };
    else if (mic.status === 'lost') msg = { kind: 'error', title: 'Microphone disconnected', text: 'Plug it back in. Sound returns as soon as it reconnects.' };
    else if (live && audio.clipping) msg = { kind: 'warning', title: 'Your mic is overloading', text: 'Lower the input volume in Windows, or move the mic a little further away.' };
    message($('micMessage'), msg, a => a.run());

    // Sound check: running panel and verdict card.
    show($('btnSoundCheck'), live && !sc.running);
    label($('btnSoundCheck'), sc.result || audio.calibrated ? 'Check again' : 'Check my sound');
    show($('scRun'), sc.running);
    if (sc.running) {
      const steps = { countdown: 'Get ready', background: 'Step 1 of 2 · Stay quiet', voice: 'Step 2 of 2 · Read this aloud' };
      text($('scStep'), steps[sc.phase] || 'Sound check');
      attr($('scStep'), 'data-phase', sc.phase);
      const secs = Math.max(0, Math.ceil((sc.remainingMs || 0) / 1000));
      const fallback = { countdown: 'Starting… stay quiet', background: `Stay quiet… measuring your room (${secs})`, voice: `Read aloud in your normal teaching voice (${secs})` };
      // The sentence itself is shown once, in large type, in #scLine.
      text($('scInstruction'), fallback[sc.phase] || '');
      text($('scLine'), TEST_LINE);
      show($('scLine'), sc.phase === 'voice');
      progress($('scProgress'), sc.fraction);
    }
    const r = sc.result;
    if (r && r !== this.prevResult) { this.freshResult = true; this.expanded.add('stepMic'); }
    show($('scResult'), !!r && !sc.running);
    if (r && !sc.running) {
      text($('scHeadline'), r.headline);
      attr($('scHeadline'), 'data-status', r.status);
      attr($('scResult'), 'data-status', r.status);
      const worst = [r.voice, r.background].filter(Boolean).sort((a, b) => rank(b.level) - rank(a.level))[0];
      const lead = r.status === 'ideal' ? r.voice : worst;
      text($('scText'), lead?.advice || '');
      this.#renderTips(r, lead);
      text($('scApplied'), r.applied || '');
      show($('scApplied'), !!r.applied);
      const audioEl = $('scAudio');
      if (sc.clipUrl && audioEl.dataset.src !== sc.clipUrl) { audioEl.dataset.src = sc.clipUrl; audioEl.src = sc.clipUrl; }
      show($('btnScPlay'), !!sc.clipUrl);
      const needsFix = r.status !== 'ideal';
      show($('scFix'), needsFix);
      if (needsFix && r !== this.prevResult) $('scFix').open = r.status !== 'usable';
      this.#renderFixSteps(r);
    }
    this.prevResult = r;

    // Step status, chip and collapsed summary.
    const cal = audio.calibration;
    let status = 'todo', chip = 'To do', summary = '';
    if (noVoice) { status = 'done'; chip = 'Voice off'; summary = 'Off – recording without your voice'; }
    else if (['blocked', 'notfound', 'busy', 'error', 'lost'].includes(mic.status)) { status = 'attention'; chip = 'Needs attention'; }
    else if (live) {
      const label = shortLabel(mic.label);
      if (audio.checkStale) { status = 'attention'; chip = 'Settings changed – check again'; }
      else if (cal && (cal.status === 'ideal' || cal.status === 'usable')) {
        status = 'done'; chip = cal.status === 'ideal' ? 'Sounds great ✓' : 'Usable ✓';
        const at = cal.at ? new Date(cal.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '';
        summary = `${label} · ${cal.status === 'ideal' ? 'Sounds great' : 'Usable'}${at ? ` · checked ${at}` : ''}`;
      } else if (cal) { status = 'attention'; chip = 'Needs attention'; }
      else { status = 'todo'; chip = 'On · check your sound'; summary = label; }
    } else if (mic.status === 'starting') chip = 'Starting…';
    const collapsed = status === 'done' && !this.expanded.has('stepMic') && !sc.running && !this.freshResult;
    this.#step('stepMic', status, collapsed);
    text($('micChip'), chip);
    show($('micSummary'), collapsed);
    const summaryText = $('micSummary').querySelector('[data-field="summary"]') || null;
    if (summaryText) text(summaryText, summary); else if (!$('micSummary').querySelector('button')) text($('micSummary'), summary);
  }

  /** The other findings, below the one sentence the card leads with. */
  #renderTips(r, lead) {
    const box = $('scTips');
    const sig = JSON.stringify([r.background, r.voice, lead?.advice]);
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    box.replaceChildren();
    for (const row of [r.voice, r.background].filter(Boolean)) {
      if (row === lead || (r.status === 'ideal' && row.level === 'good')) continue;
      const el = fill(clone('tplMessage'), { title: row.title, text: row.advice });
      el.dataset.kind = row.level === 'good' ? 'success' : row.level === 'warn' ? 'warning' : 'error';
      el.querySelector('[data-actions]')?.setAttribute('hidden', '');
      box.append(el);
    }
    show(box, box.children.length > 0);
  }

  #renderFixSteps(r) {
    const { win11, win10 } = fixSteps(r);
    for (const [id, steps] of [['scFixWin11', win11], ['scFixWin10', win10]]) {
      const el = $(id);
      const sig = JSON.stringify(steps);
      if (el.dataset.sig === sig) continue;
      el.dataset.sig = sig;
      const ol = document.createElement('ol');
      for (const step of steps) { const li = document.createElement('li'); li.textContent = step; ol.append(li); }
      const target = el.querySelector('[data-field="steps"]') || el;
      target.replaceChildren(ol);
    }
  }

  #renderScreen(st) {
    const sc = st.screen;
    show($('screenIntro'), !sc);
    label($('btnChooseScreen'), sc ? 'Change' : 'Choose screen');
    show($('screenSummary'), !!sc);
    let status = 'todo', chip = 'To do', msg = null;
    if (sc) {
      const kind = sc.surface === 'monitor' ? 'Whole screen' : sc.surface === 'browser' ? 'A browser tab' : 'One window';
      text($('screenLabel'), kind);
      text($('screenDetail'), `${sc.width}×${sc.height}${sc.surface !== 'monitor' && sc.label ? ` · ${sc.label}` : ''}`);
      if (sc.surface === 'monitor') { status = 'done'; chip = 'Done ✓'; }
      else {
        status = 'attention'; chip = 'Check this';
        msg = { kind: 'warning', title: 'Only one window will be recorded', text: 'To record everything on a monitor, click Change and use the “Entire screen” tab.', actions: [{ label: 'Change', run: () => this.session.chooseScreen() }] };
      }
    }
    message($('screenMessage'), msg, a => a.run());
    const sysChip = $('sysAudioChip');
    show(sysChip, !!sc);
    if (sc) {
      const included = sc.hasAudio && st.audio.systemAudio;
      text(sysChip, !st.audio.systemAudio ? 'Computer sound: off' : sc.hasAudio ? 'Computer sound: included ✓' : 'Computer sound: not included – choose again to include it');
      attr(sysChip, 'data-status', included ? 'done' : 'todo');
    }
    show($('screenTip'), !!sc && !!globalThis.screen?.isExtended && sc.surface === 'monitor');
    const collapsed = status === 'done' && !this.expanded.has('stepScreen');
    this.#step('stepScreen', status, collapsed);
    text($('screenChip'), chip);
    attr($('btnChooseScreen'), 'aria-disabled', st.phase === 'countdown' ? 'true' : null);
  }

  #renderCamera(st) {
    const cam = st.camera;
    value($('cameraToggle'), cam.enabled);
    show($('cameraControls'), cam.enabled);
    setOptions($('cameraSelect'), cam.devices.length ? cam.devices : [{ deviceId: cam.deviceId || '', label: cam.label || 'Camera' }], cam.deviceId, d => d.label || 'Camera');
    for (const r of document.querySelectorAll('input[name="bubbleShape"]')) value(r, r.value === cam.bubble.shape);
    for (const r of document.querySelectorAll('input[name="bubbleSize"]')) value(r, r.value === cam.bubble.size);
    value($('bubbleMirror'), cam.bubble.mirror);
    let status = 'todo', chip = 'Optional', msg = null;
    if (!cam.supported) msg = { kind: 'info', title: 'Camera bubble isn’t available here', text: 'Update Chrome or Edge to add your camera to lessons.' };
    if (cam.enabled) {
      if (cam.status === 'live') { status = 'done'; chip = 'On ✓'; }
      else if (cam.status === 'starting') chip = 'Starting…';
      else if (cam.status === 'blocked') { status = 'attention'; chip = 'Needs attention'; msg = { kind: 'error', title: 'Camera blocked', text: cam.error || 'Click the icon at the left of the address bar and allow the camera.', actions: [{ label: 'Try again', run: () => this.session.setCamera(true) }] }; }
      else if (cam.status === 'error') { status = 'attention'; chip = 'Needs attention'; msg = msg || { kind: 'error', title: 'Camera didn’t start', text: cam.error || 'Another app may be using it. Close Teams, Zoom or the Camera app.', actions: [{ label: 'Try again', run: () => this.session.setCamera(true) }] }; }
    }
    message($('cameraMessage'), msg, a => a.run());
    this.#step('stepCamera', status, false);
    text($('cameraChip'), chip);
  }

  #renderStart(st) {
    const { mic, screen, lesson, prefs } = st;
    const micReady = mic.status === 'live' || prefs.noVoice;
    const parts = [];
    parts.push(prefs.noVoice ? '✓ Voice off' : micReady ? `✓ Microphone: ${shortLabel(mic.label)}` : '✗ Microphone: not on yet');
    parts.push(screen ? `✓ ${screen.surface === 'monitor' ? 'Whole screen' : 'One window'}` : '• Screen: you’ll pick it next');
    if (st.camera.enabled && st.camera.status === 'live') parts.push('✓ Camera');
    parts.push(`Lesson: ${lesson.name.trim() || 'Untitled'}`);
    const allSet = micReady && screen;
    text($('readiness'), allSet ? `All set · ${parts.slice(0, -1).join(' · ')} · ${parts[parts.length - 1]}` : parts.join(' · '));
    attr($('readiness'), 'data-ready', allSet ? 'true' : 'false');

    const btn = $('btnStart');
    const counting = st.phase === 'countdown';
    label(btn, counting ? `Cancel (${st.countdown})` : 'Start recording');
    attr(btn, 'aria-disabled', !counting && !micReady ? 'true' : null);
    attr(btn, 'data-state', counting ? 'countdown' : 'idle');
    attr(btn, 'aria-keyshortcuts', 'Alt+R');
    if (micReady) show($('startHint'), false);
  }

  #announce(st, inSetup) {
    const sc = st.soundCheck;
    // Keep the test sentence on screen when a check starts.
    if (sc.running && !this.prevScPhase) requestAnimationFrame(() => $('scRun').scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
    if (sc.running && sc.phase !== this.prevScPhase) {
      const say = { background: 'Stay quiet for 3 seconds.', voice: 'Now read the sentence aloud.' }[sc.phase];
      if (say) this.notices.announce(say);
    }
    if (!sc.running && this.prevScPhase && sc.result) {
      this.notices.announce(sc.result.headline);
      requestAnimationFrame(() => focusEl($('scHeadline')));
    }
    this.prevScPhase = sc.running ? sc.phase : null;
    if (st.phase === 'countdown' && this.prevPhase !== 'countdown') this.notices.announce('Recording starts in 3 seconds. Press Escape to cancel.');
    if (!inSetup) this.expanded.clear();
  }
}

const rank = level => ({ good: 0, warn: 1, bad: 2 }[level] ?? 0);
