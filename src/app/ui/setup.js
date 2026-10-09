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
  constructor(session, { meters, notices, popout, settingsDialog, startOrStop }) {
    this.session = session;
    this.notices = notices;
    this.popout = popout;
    this.settingsDialog = settingsDialog;
    this.startOrStop = startOrStop;
    this.expanded = new Set();     // steps the teacher re-opened with "Change"
    this.freshResult = false;      // a new sound-check verdict the teacher hasn't moved past
    this.lessonDone = false;       // the teacher confirmed the name this visit (then the step may fold)
    this.prevPhase = null;
    this.prevScPhase = null;
    this.prevResult = null;
    this.prevScreen = null;
    this.prevMicStatus = null;
    this.focusVerdict = false;

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
    const commitName = e => {
      if (!e.target.value.trim()) return;
      this.lessonDone = true;
      this.expanded.delete('stepLesson');
      requestAnimationFrame(() => this.render(s.state));
    };
    $('lessonName').addEventListener('change', commitName);
    $('lessonName').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); commitName(e); } });
    $('lessonSuggest').addEventListener('click', () => {
      const next = suggestNextName(s.state.lesson.name);
      if (next) { s.setLessonName(next); $('lessonName').value = next; this.lessonDone = true; this.expanded.delete('stepLesson'); }
    });
    $('notes').addEventListener('input', e => s.setNotes(e.target.value));

    $('btnMicOn').addEventListener('click', () => { if ($('btnMicOn').getAttribute('aria-disabled') !== 'true') s.enableMic(); });
    $('micSelect').addEventListener('change', e => s.setMicDevice(e.target.value));
    $('micSuggest').addEventListener('click', e => { const id = e.currentTarget.dataset.deviceId; if (id && e.currentTarget.getAttribute('aria-disabled') !== 'true') s.setMicDevice(id); });
    $('noiseToggle').addEventListener('change', e => s.setAudioMode(e.target.checked ? 'clean' : 'studio'));
    const check = () => { this.expanded.add('stepMic'); this.focusVerdict = true; s.startSoundCheck(); };
    $('btnSoundCheck').addEventListener('click', check);
    $('btnScAgain').addEventListener('click', check);
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

    $('btnChooseScreen').addEventListener('click', () => {
      if ($('btnChooseScreen').getAttribute('aria-disabled') === 'true') return;
      this.expanded.delete('stepScreen');
      s.chooseScreen();
    });
    $('btnChooseScreenBig').addEventListener('click', () => s.chooseScreen());
    this.#wireSummary('screenSummary', 'stepScreen');

    $('cameraToggle').addEventListener('change', e => s.setCamera(e.target.checked));
    $('cameraSelect').addEventListener('change', e => s.setCameraDevice(e.target.value));
    for (const r of document.querySelectorAll('input[name="bubbleShape"]')) r.addEventListener('change', e => e.target.checked && s.setBubble({ shape: e.target.value }));
    for (const r of document.querySelectorAll('input[name="bubbleSize"]')) r.addEventListener('change', e => e.target.checked && s.setBubble({ size: e.target.value }));
    $('bubbleMirror').addEventListener('change', e => s.setBubble({ mirror: e.target.checked }));
    for (const [id, pos] of Object.entries(CORNERS)) $(id).addEventListener('click', () => s.setBubble(pos));

    // While a take is starting the button is greyed out: a stray click (the second half of a
    // slow double-click) must not cancel it. Escape and Alt+R cancel.
    $('btnStart').addEventListener('click', () => { if ($('btnStart').dataset.state !== 'starting') this.startOrStop('button'); });

    // Helper buttons in the design: "Change" on a collapsed step, "Cancel" on the sound check.
    document.addEventListener('click', e => {
      const btn = e.target.closest('[data-action="expand-step"], [data-action="change"], [data-action="cancel-sound-check"]');
      if (!btn || btn.closest('template')) return;
      if (btn.dataset.action === 'cancel-sound-check') {
        s.cancelSoundCheck();
        requestAnimationFrame(() => focusEl($('btnSoundCheck')));
        return;
      }
      const step = btn.closest('section.step, .step');
      if (!step?.id) return;
      this.expanded.add(step.id);
      this.render(s.state);
      // Straight to the thing the teacher wants to change.
      const target = { stepLesson: 'lessonName', stepMic: 'micSelect' }[step.id];
      focusEl((target && $(target)?.getClientRects().length ? $(target) : null) || step.querySelector('h2'));
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

  /** Start was pressed (or Alt+R) while the microphone isn't ready: say why and go there. */
  explainBlocked(reason) {
    text($('startHint'), reason);
    show($('startHint'), true);
    this.expanded.add('stepMic');
    this.render(this.session.state);
    this.notices.shout(reason);
    // The control that fixes it: Turn on microphone, or the error card's Try again.
    const fix = [$('btnMicOn'), $('micMessage')?.querySelector('button')]
      .find(b => b && b.getClientRects().length && b.getAttribute('aria-disabled') !== 'true');
    if (fix) { fix.setAttribute('aria-describedby', 'startHint'); focusEl(fix); fix.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    else focusEl($('stepMic').querySelector('h2'));
  }

  render(st) {
    const inSetup = ['setup', 'ready', 'countdown', 'starting'].includes(st.phase);
    // Moving on to the screen folds a good sound check into its summary line.
    if (st.screen && !this.prevScreen) { this.freshResult = false; this.expanded.delete('stepMic'); }
    this.prevScreen = st.screen;
    this.#renderLesson(st);
    this.#renderMic(st);
    this.#renderScreen(st);
    this.#renderCamera(st);
    this.#renderTips(st);
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
    const preview = makeFilename({ lessonName: name, ext: st.estimate?.container || 'mp4', take: st.lesson.nextTake });
    text($('fileNamePreview'), `Will save as: ${displayFilename(preview)}`);
  }

  #renderMic(st) {
    const { mic, audio, soundCheck: sc } = st;
    const live = mic.status === 'live';
    const err = st.micError;
    const noVoice = st.prefs.noVoice;
    const locked = st.phase === 'countdown' || st.phase === 'starting' || st.preparing;
    attr($('stepMic'), 'data-mic', noVoice ? 'off' : mic.status);

    show($('micIntro'), !noVoice && ['needs-permission', 'starting', 'off'].includes(mic.status));
    attr($('btnMicOn'), 'aria-disabled', mic.status === 'starting' || !st.ready ? 'true' : null);
    label($('btnMicOn'), !st.ready ? 'Getting ready…' : mic.status === 'starting' ? 'Starting…' : 'Turn on microphone');
    // Busy or missing: the picker stays (to choose another mic); CSS hides the rest.
    show($('micControls'), live || ['lost', 'notfound', 'busy'].includes(mic.status));
    // From Start until the take begins, the microphone is not reopened under it.
    for (const id of ['micSelect', 'noiseToggle']) $(id).disabled = locked;
    attr($('micSuggest'), 'aria-disabled', locked ? 'true' : null);

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
    else if (live && st.micWarning) msg = { kind: 'warning', title: st.micWarning.title, text: `${st.micWarning.text} Pick your microphone in the list if it’s plugged in.` };
    else if (live && audio.clipping) msg = { kind: 'warning', title: 'Your mic is overloading', text: 'Lower the input volume in Windows, or move the mic a little further away.' };
    message($('micMessage'), msg, a => a.run());

    // Sound check: running panel and verdict card (never during a countdown).
    show($('btnSoundCheck'), live && !sc.running && !locked);
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
    show($('btnScAgain'), !locked);
    if (r && !sc.running) {
      text($('scHeadline'), r.headline);
      attr($('scHeadline'), 'data-status', r.status);
      attr($('scResult'), 'data-status', r.status);
      const worst = [r.voice, r.background].filter(Boolean).sort((a, b) => rank(b.level) - rank(a.level))[0];
      const lead = r.status === 'ideal' ? r.voice : worst;
      text($('scText'), lead?.advice || '');
      this.#renderVerdictTips(r, lead);
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

    // One meaning of "done" for the chip, the progress bar and the readiness
    // line: the mic is on (the sound check is recommended, not required); a
    // failed check or changed settings need attention.
    const cal = audio.calibration;
    const failed = r && ['novoice', 'clipping', 'notready'].includes(r.status);
    let status = 'todo', chip = 'To do', summary = '', unchecked = false;
    if (noVoice) { status = 'done'; chip = 'Voice off'; summary = 'Off – recording without your voice'; }
    else if (['blocked', 'notfound', 'busy', 'error', 'lost'].includes(mic.status)) { status = 'attention'; chip = mic.status === 'blocked' ? 'Blocked' : 'Needs attention'; }
    else if (live) {
      const name = shortLabel(mic.label);
      if (st.micWarning) { status = 'attention'; chip = 'Check the mic'; }
      else if (failed) { status = 'attention'; chip = 'Needs attention'; }
      else if (audio.checkStale) { status = 'attention'; chip = 'Settings changed – check again'; }
      else if (cal && (cal.status === 'ideal' || cal.status === 'usable')) {
        status = 'done'; chip = cal.status === 'ideal' ? 'Sounds great ✓' : 'Usable ✓';
        const at = cal.at ? new Date(cal.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '';
        summary = `${name} · ${at ? `Sound checked ${at} · ` : ''}${cal.status === 'ideal' ? 'Sounds great' : 'Usable'}`;
      } else { status = 'done'; chip = 'On – sound not checked'; summary = `${name} · sound not checked`; unchecked = true; }
    } else if (mic.status === 'starting') chip = 'Starting…';
    // An unchecked mic stays open (the sound check is offered) until the teacher moves on to the screen.
    const collapsed = status === 'done' && !this.expanded.has('stepMic') && !sc.running && !this.freshResult && !!summary && (!unchecked || !!st.screen);
    this.#step('stepMic', status, collapsed);
    text($('micChip'), chip);
    show($('micSummary'), collapsed);
    const summaryText = $('micSummary').querySelector('[data-field="summary"]') || null;
    if (summaryText) text(summaryText, summary); else if (!$('micSummary').querySelector('button')) text($('micSummary'), summary);
    this.micStepStatus = status;
  }

  /** The other findings, below the one sentence the card leads with. */
  #renderVerdictTips(r, lead) {
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
    attr($('btnChooseScreen'), 'aria-label', sc ? 'Choose a different screen' : null);
    show($('screenSummary'), !!sc);
    let status = 'todo', chip = 'To do', msg = null;
    if (sc) {
      text($('screenLabel'), surfaceName(sc.surface));
      text($('screenDetail'), `${sc.width}×${sc.height}${sc.surface !== 'monitor' && sc.label ? ` · ${sc.label}` : ''}`);
      if (sc.surface === 'monitor') { status = 'done'; chip = 'Done ✓'; }
      else {
        status = 'attention'; chip = 'Check this';
        msg = {
          kind: 'warning',
          title: sc.surface === 'browser' ? 'Only one browser tab will be recorded' : 'Only one window will be recorded',
          text: 'To record everything on a monitor (and include computer sound), choose the “Entire screen” tab.',
          actions: [{ label: 'Choose a different screen', run: () => this.session.chooseScreen() }],
        };
      }
    }
    message($('screenMessage'), msg, a => a.run());
    const sysChip = $('sysAudioChip');
    show(sysChip, !!sc);
    if (sc) {
      const included = sc.hasAudio && st.audio.systemAudio;
      text(sysChip, !st.audio.systemAudio ? 'Computer sound: off'
        : sc.hasAudio ? 'Computer sound: included ✓'
        : sc.surface === 'window' ? 'Computer sound: not included – windows can’t share sound'
        : 'Computer sound: not included – choose again and tick “Share system audio”');
      attr(sysChip, 'data-status', included ? 'done' : 'todo');
    }
    show($('screenTip'), !!sc && !!globalThis.screen?.isExtended && sc.surface === 'monitor');
    const collapsed = status === 'done' && !this.expanded.has('stepScreen');
    this.#step('stepScreen', status, collapsed);
    text($('screenChip'), chip);
    attr($('btnChooseScreen'), 'aria-disabled', ['countdown', 'starting'].includes(st.phase) || st.preparing ? 'true' : null);
  }

  #renderCamera(st) {
    const cam = st.camera;
    value($('cameraToggle'), cam.enabled);
    show($('cameraControls'), cam.enabled);
    attr($('stepCamera'), 'data-cam', cam.enabled ? cam.status : 'off');
    setOptions($('cameraSelect'), cam.devices.length ? cam.devices : [{ deviceId: cam.deviceId || '', label: cam.label || 'Camera' }], cam.deviceId, d => d.label || 'Camera');
    for (const r of document.querySelectorAll('input[name="bubbleShape"]')) value(r, r.value === cam.bubble.shape);
    for (const r of document.querySelectorAll('input[name="bubbleSize"]')) value(r, r.value === cam.bubble.size);
    value($('bubbleMirror'), cam.bubble.mirror);
    // Mark the corner button nearest the bubble.
    const corner = `btnCorner${cam.bubble.y < 0.5 ? 'T' : 'B'}${cam.bubble.x < 0.5 ? 'L' : 'R'}`;
    for (const id of Object.keys(CORNERS)) attr($(id), 'aria-pressed', id === corner ? 'true' : 'false');
    let status = 'todo', chip = 'Optional', msg = null;
    if (!cam.supported) msg = { kind: 'info', title: 'Camera bubble isn’t available here', text: 'Update Chrome or Edge to add your camera to lessons.' };
    if (cam.enabled) {
      const retry = [{ label: 'Try again', run: () => this.session.setCamera(true) }];
      if (cam.status === 'live') { status = 'done'; chip = 'On ✓'; }
      else if (cam.status === 'starting') chip = 'Starting…';
      else if (cam.status === 'blocked') { status = 'attention'; chip = 'Blocked'; msg = { kind: 'error', title: 'Camera blocked', text: cam.error || 'Click the icon at the left of the address bar, switch Camera on, then press Try again.', actions: retry }; }
      else if (cam.status === 'error') { status = 'attention'; chip = 'Needs attention'; msg = { kind: 'error', title: 'Camera didn’t start', text: cam.error || 'Another app may be using it. Close Teams, Zoom or the Camera app, then press Try again.', actions: cam.supported ? retry : [] }; }
    }
    message($('cameraMessage'), msg, a => a.run());
    this.#step('stepCamera', status, false);
    text($('cameraChip'), chip);
  }

  /** The "what happens when you press Start" card matches the settings. */
  #renderTips(st) {
    show($('tipCountdown'), st.lesson.countdown);
    show($('tipFloating'), st.prefs.floatingControls);
  }

  #renderStart(st) {
    const { mic, screen, lesson, prefs, folder } = st;
    const micReady = !st.startBlocker;
    const parts = [];
    if (prefs.noVoice) parts.push('✓ Voice off');
    else if (mic.status === 'blocked') parts.push('✗ Microphone blocked');
    else if (!micReady) parts.push('✗ Microphone not on yet');
    else parts.push(`✓ Microphone: ${shortLabel(mic.label)}${this.micStepStatus === 'attention' ? ' (check it)' : ''}`);
    if (screen) parts.push(`${screen.surface === 'monitor' ? '✓' : '!'} ${surfaceName(screen.surface)}`);
    else parts.push('Screen: you’ll pick it next');
    if (st.camera.enabled && st.camera.status === 'live') parts.push('✓ Camera');
    parts.push(`Lesson: ${lesson.name.trim() || 'Untitled'}`);
    parts.push(folder.status === 'ready' ? `Saves to “${folder.name}”` : folder.status === 'needs-permission' ? `Saves to “${folder.name}” (asks permission)` : 'Saves to Downloads');
    const allSet = micReady && screen && screen.surface === 'monitor' && this.micStepStatus === 'done';
    text($('readiness'), (allSet ? 'All set · ' : '') + parts.join(' · '));
    attr($('readiness'), 'data-ready', allSet ? 'true' : 'false');

    const btn = $('btnStart');
    const counting = st.phase === 'countdown';
    const starting = st.phase === 'starting' || st.preparing;
    label(btn, counting ? `Cancel (${st.countdown})` : st.cancelling ? 'Cancelling…' : starting ? 'Starting…' : 'Start recording');
    attr(btn, 'aria-disabled', (!counting && !micReady) || starting ? 'true' : null);
    attr(btn, 'data-state', counting ? 'countdown' : starting ? 'starting' : 'idle');
    if (micReady) show($('startHint'), false);
  }

  #announce(st, inSetup) {
    const sc = st.soundCheck;
    // Keep the test sentence on screen when a check starts.
    if (sc.running && !this.prevScPhase) requestAnimationFrame(() => $('scRun').scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
    if (sc.running && sc.phase !== this.prevScPhase) {
      const say = { background: 'Stay quiet for 3 seconds.', voice: `Now read this aloud: ${TEST_LINE}` }[sc.phase];
      if (say) this.notices.announce(say);
    }
    if (!sc.running && this.prevScPhase && sc.result) {
      // Move to the verdict only if the teacher is still on the microphone
      // step (or nowhere); otherwise just say it, so typing isn't interrupted.
      const a = document.activeElement;
      if (this.focusVerdict && (!a || a === document.body || $('stepMic').contains(a))) requestAnimationFrame(() => focusEl($('scHeadline')));
      else this.notices.announce(sc.result.headline);
      this.focusVerdict = false;
    }
    this.prevScPhase = sc.running ? sc.phase : null;
    // The microphone coming on, or failing.
    const ms = st.mic.status;
    if (ms !== this.prevMicStatus && this.prevMicStatus) {
      if (ms === 'live' && this.prevMicStatus === 'starting') this.notices.announce(`Microphone on: ${shortLabel(st.mic.label)}.`);
      if (['blocked', 'notfound', 'busy', 'error'].includes(ms) && st.micError) this.notices.shout(`${st.micError.title}. ${st.micError.text}`);
    }
    this.prevMicStatus = ms;
    if (st.phase === 'countdown' && this.prevPhase !== 'countdown') this.notices.announce(`Recording starts in ${st.countdown} seconds. Press Escape to cancel.`);
    if (st.cancelling && !this.prevCancelling) this.notices.announce('Cancelling.');
    this.prevCancelling = st.cancelling;
    if (!inSetup) this.expanded.clear();
  }
}

const surfaceName = surface => (surface === 'monitor' ? 'Whole screen' : surface === 'browser' ? 'A browser tab' : 'One window');
const rank = level => ({ good: 0, warn: 1, bad: 2 }[level] ?? 0);
