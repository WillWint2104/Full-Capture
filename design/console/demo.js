/* Full Capture – "console" design: demo driver. NOT app logic.
   Fakes each state for review and screenshots:
     ?state=setup|ready|soundcheck|countdown|recording|paused|review|library|problems|popout
     ?theme=light|dark           (absent = follow the system)
     ?dialog=settings|help|confirm
     ?po=recording|paused|nosound|confirm|idle|countdown   (with state=popout)
   Images (screen, webcam, thumbnails) are drawn on a canvas: nothing external. */
(() => {
  'use strict';

  const params = new URLSearchParams(location.search);
  const STATE = params.get('state') || 'setup';
  const THEME = params.get('theme');
  const DIALOG = params.get('dialog');
  const PO = params.get('po') || 'recording';
  const html = document.documentElement;
  if (THEME === 'light' || THEME === 'dark') html.dataset.theme = THEME;

  // Meters animate for people; screenshots (webdriver) stay still and repeatable.
  const ANIMATE = !navigator.webdriver && !matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ── tiny DOM helpers (same spirit as src/app/ui/dom.js) ── */
  const $ = id => document.getElementById(id);
  const show = (el, on = true) => { if (el) el.toggleAttribute('hidden', !on); };
  const text = (el, t) => { if (el) el.textContent = t; };
  const clone = (id, doc = document) => doc.getElementById(id).content.firstElementChild.cloneNode(true);
  function fill(root, fields) {
    for (const [k, v] of Object.entries(fields)) {
      for (const el of root.querySelectorAll(`[data-field="${k}"]`)) {
        if (el.tagName === 'IMG') { if (v) el.src = v; show(el, !!v); }
        else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') el.value = v;
        else el.textContent = v;
      }
    }
    return root;
  }
  function step(id, status, collapsed = false) {
    const el = $(id);
    el.dataset.status = status;
    el.toggleAttribute('data-collapsed', collapsed);
  }
  function setPhase(phase) {
    html.dataset.phase = phase;
    const view = { setup: 'viewSetup', ready: 'viewSetup', countdown: 'viewSetup', recording: 'viewRecording', paused: 'viewRecording', stopping: 'viewRecording', review: 'viewReview' }[phase];
    for (const id of ['viewSetup', 'viewRecording', 'viewReview']) show($(id), id === view);
  }
  function buttons(box, list) {
    box.replaceChildren();
    show(box, list.length > 0);
    for (const a of list) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = a.primary ? 'btn btn-primary btn-small' : 'btn btn-secondary btn-small';
      b.textContent = a.label;
      box.append(b);
    }
  }

  /* ── meters ── */
  const dbToLevel = db => Math.max(0, Math.min(1, (db + 60) / 60));
  const zoneFor = (rms, peak) => (peak > -1.5 || rms > -12 ? 'loud' : rms >= -28 ? 'good' : 'quiet');
  const LABELS = {
    setup: { quiet: 'Too quiet', good: 'Good', loud: 'Too loud – move back a little', off: 'No sound' },
    rec: { quiet: 'Too quiet – speak up or move closer', good: 'We can hear you ✓', loud: 'Too loud – move back a little', off: 'No sound from your microphone' },
    po: { quiet: 'Too quiet', good: 'We can hear you ✓', loud: 'Too loud', off: 'No sound' },
  };
  function setMeter(el, label, rmsDb, peakDb, labels) {
    if (!el) return;
    el.style.setProperty('--good-from', dbToLevel(-28).toFixed(3));
    el.style.setProperty('--good-to', dbToLevel(-12).toFixed(3));
    el.style.setProperty('--level', dbToLevel(rmsDb).toFixed(3));
    el.style.setProperty('--peak', dbToLevel(peakDb).toFixed(3));
    const zone = rmsDb <= -70 ? 'off' : zoneFor(rmsDb, peakDb);
    el.dataset.zone = zone === 'off' ? 'quiet' : zone;
    el.setAttribute('aria-valuenow', Math.round(dbToLevel(rmsDb) * 100));
    if (labels) {
      el.setAttribute('aria-valuetext', labels[zone]);
      if (label) label.textContent = labels[zone];
    }
  }
  /** Speech-like movement around a base level (only when people look at the demo). */
  function animateMeter(el, label, baseDb, labels) {
    setMeter(el, label, baseDb, baseDb + 9, labels);
    if (!ANIMATE || !el) return;
    let peak = baseDb + 9, t = 0;
    setInterval(() => {
      t += 1;
      const syll = Math.sin(t * 0.9) * 3 + Math.sin(t * 0.37) * 4 + (Math.random() - 0.5) * 5;
      const pauseDip = (t % 38) > 32 ? -22 : 0;
      const rms = Math.min(-13, baseDb + syll + pauseDip);
      peak = Math.max(rms + 8 + Math.random() * 3, peak - 1.2);
      setMeter(el, label, rms, Math.min(-2, peak), labels);
    }, 80);
  }

  /* ── fake pictures ── */
  const FONT = '"Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif';
  function pie(g, x, y, r, parts, filled, color) {
    g.save();
    g.lineWidth = Math.max(2, r * 0.04);
    for (let i = 0; i < parts; i++) {
      const a0 = -Math.PI / 2 + (i / parts) * Math.PI * 2, a1 = -Math.PI / 2 + ((i + 1) / parts) * Math.PI * 2;
      g.beginPath(); g.moveTo(x, y); g.arc(x, y, r, a0, a1); g.closePath();
      g.fillStyle = i < filled ? color : '#ffffff'; g.fill();
      g.strokeStyle = '#2b2f36'; g.stroke();
    }
    g.restore();
  }
  /** A whole Windows screen showing a lesson slide (16:9). */
  function screenShot({ w = 1280, h = 720, title = 'Fractions – Week 3', sub = 'Adding fractions with different denominators', accent = '#2f6fde', bg = '#fbfaf6', kind = 'pies', n = 4 } = {}) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d');
    const tb = Math.round(h * 0.055);
    g.fillStyle = bg; g.fillRect(0, 0, w, h - tb);
    // slide header band
    g.fillStyle = accent; g.fillRect(0, 0, w, h * 0.012);
    g.fillStyle = '#1b1f27'; g.font = `600 ${Math.round(h * 0.072)}px ${FONT}`; g.textBaseline = 'alphabetic';
    g.fillText(title, w * 0.07, h * 0.19);
    g.fillStyle = '#5b6170'; g.font = `400 ${Math.round(h * 0.038)}px ${FONT}`;
    g.fillText(sub, w * 0.07, h * 0.265);
    if (kind === 'pies') {
      const r = h * 0.15, y = h * 0.56;
      pie(g, w * 0.2, y, r, 2, 1, '#f4a63a');
      pie(g, w * 0.45, y, r, 3, 1, '#4f8ef7');
      pie(g, w * 0.76, y, r, 6, 5, '#43b37a');
      g.fillStyle = '#2b2f36'; g.font = `600 ${Math.round(h * 0.09)}px ${FONT}`; g.textAlign = 'center';
      g.fillText('+', w * 0.325, y + h * 0.03); g.fillText('=', w * 0.605, y + h * 0.03);
      g.font = `600 ${Math.round(h * 0.05)}px ${FONT}`;
      g.fillText('1/2', w * 0.2, y + r + h * 0.08); g.fillText('1/3', w * 0.45, y + r + h * 0.08); g.fillText('5/6', w * 0.76, y + r + h * 0.08);
      g.textAlign = 'start';
    } else if (kind === 'bars') {
      const x0 = w * 0.07, y0 = h * 0.36, bw = w * 0.86, bh = h * 0.08;
      [[1, 2, '#f4a63a'], [2, 4, '#4f8ef7'], [3, 6, '#43b37a'], [4, 8, '#b072e8']].forEach(([a, b, col], i) => {
        const y = y0 + i * (bh + h * 0.035);
        for (let k = 0; k < b; k++) {
          g.fillStyle = k < a ? col : '#ffffff';
          g.fillRect(x0 + (bw / b) * k, y, bw / b, bh);
          g.strokeStyle = '#2b2f36'; g.lineWidth = 2; g.strokeRect(x0 + (bw / b) * k, y, bw / b, bh);
        }
      });
    } else {
      g.fillStyle = '#2b2f36'; g.font = `400 ${Math.round(h * 0.042)}px ${FONT}`;
      ['• Equivalent fractions name the same amount', '• Multiply top and bottom by the same number', '• 2/3 = 4/6 = 8/12'].forEach((l, i) => g.fillText(l, w * 0.09, h * (0.4 + i * 0.1)));
    }
    g.fillStyle = '#9aa0ab'; g.font = `400 ${Math.round(h * 0.03)}px ${FONT}`; g.textAlign = 'right';
    g.fillText(String(n), w * 0.95, h - tb - h * 0.035); g.textAlign = 'start';
    // Windows taskbar
    g.fillStyle = '#e9edf3'; g.fillRect(0, h - tb, w, tb);
    g.fillStyle = '#d5dbe3'; g.fillRect(0, h - tb, w, 1);
    const icons = ['#3b82f6', '#f5b400', '#0f9d58', '#d24726', '#2b579a', '#7a7a7a'];
    const s = tb * 0.52, gap = tb * 0.36, total = icons.length * s + (icons.length - 1) * gap;
    icons.forEach((col, i) => {
      g.fillStyle = col;
      const x = w / 2 - total / 2 + i * (s + gap), y = h - tb + (tb - s) / 2;
      g.beginPath(); g.roundRect(x, y, s, s, s * 0.22); g.fill();
    });
    g.fillStyle = '#4b5563'; g.font = `400 ${Math.round(tb * 0.34)}px ${FONT}`; g.textAlign = 'right';
    g.fillText('14:32', w - tb * 0.5, h - tb / 2 + tb * 0.12); g.textAlign = 'start';
    return c.toDataURL('image/jpeg', 0.86);
  }
  /** A friendly webcam frame: head and shoulders against a warm wall. */
  function webcam(size = 360) {
    const c = document.createElement('canvas'); c.width = c.height = size;
    const g = c.getContext('2d');
    const bg = g.createLinearGradient(0, 0, size, size);
    bg.addColorStop(0, '#d8c9b6'); bg.addColorStop(1, '#a8937e');
    g.fillStyle = bg; g.fillRect(0, 0, size, size);
    g.fillStyle = 'rgba(255,255,255,.18)'; g.fillRect(size * 0.62, size * 0.08, size * 0.26, size * 0.34); // window light
    g.fillStyle = '#3e5a78'; // jumper
    g.beginPath(); g.ellipse(size * 0.5, size * 1.04, size * 0.42, size * 0.3, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#d6a988'; // neck + head
    g.fillRect(size * 0.44, size * 0.56, size * 0.12, size * 0.16);
    g.beginPath(); g.ellipse(size * 0.5, size * 0.45, size * 0.15, size * 0.18, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#4a3326'; // hair
    g.beginPath(); g.ellipse(size * 0.5, size * 0.36, size * 0.165, size * 0.12, 0, Math.PI, 0); g.fill();
    g.fillRect(size * 0.335, size * 0.35, size * 0.04, size * 0.14); g.fillRect(size * 0.625, size * 0.35, size * 0.04, size * 0.14);
    g.fillStyle = '#2c2c2c'; // headset band + mic
    g.lineWidth = size * 0.018; g.strokeStyle = '#2c2c2c';
    g.beginPath(); g.arc(size * 0.5, size * 0.42, size * 0.185, Math.PI * 1.05, Math.PI * 1.95); g.stroke();
    g.beginPath(); g.ellipse(size * 0.33, size * 0.47, size * 0.03, size * 0.05, 0, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.moveTo(size * 0.33, size * 0.5); g.quadraticCurveTo(size * 0.36, size * 0.62, size * 0.45, size * 0.61); g.stroke();
    return c.toDataURL('image/jpeg', 0.86);
  }

  /* ── content shared by states ── */
  const LESSON = 'Fractions – Week 3';
  const MIC = 'Headset Microphone (Jabra Evolve2 30)';
  const NOTES = 'Start with the pizza example.\nAsk: which is bigger, 2/3 or 3/4?\nHomework: page 42, questions 1–6.';
  const TAKES = [
    { id: 't3', name: LESSON, date: 'Thu 8 Oct, 14:32', duration: '14 min 32 s', size: '412 MB', chapters: '4 chapters', saved: 'In “Lessons”', thumb: { title: LESSON, kind: 'pies', n: 4 } },
    { id: 't2', name: LESSON, date: 'Thu 8 Oct, 14:05', duration: '3 min 08 s', size: '89 MB', chapters: '', saved: 'In “Lessons”', thumb: { title: LESSON, kind: 'pies', n: 1, sub: 'Adding fractions with different denominators' } },
    { id: 't1', name: 'Fractions – Week 2', date: 'Thu 1 Oct, 10:12', duration: '38 min 51 s', size: '1.1 GB', chapters: '6 chapters', saved: 'Downloaded', thumb: { title: 'Fractions – Week 2', sub: 'Equivalent fractions', kind: 'bars', accent: '#b072e8', n: 7 } },
  ];

  function folderChip(status = 'ready') {
    const chip = $('btnFolder');
    chip.dataset.status = status;
    text(chip.querySelector('[data-field="label"]'), status === 'ready' ? 'Saving to “Lessons”' : status === 'needs-permission' ? 'Reconnect “Lessons”' : 'Choose a folder');
  }

  function library(currentId) {
    const list = $('takeList');
    list.replaceChildren();
    for (const t of TAKES) {
      const el = fill(clone('tplTake'), {
        thumb: screenShot({ w: 320, h: 180, ...t.thumb }),
        name: t.name, date: t.date, duration: t.duration, size: t.size, chapters: t.chapters, saved: t.saved,
      });
      el.dataset.id = t.id;
      el.dataset.saved = t.saved === 'Downloaded' ? 'download' : 'folder';
      for (const b of el.querySelectorAll('[data-action="copy-chapters"], [data-field="chapters"]')) show(b, !!t.chapters);
      if (t.id === currentId) el.setAttribute('aria-current', 'true');
      list.append(el);
    }
    show($('libraryEmpty'), false);
  }

  function lessonStep({ suggest = true } = {}) {
    $('lessonName').value = LESSON;
    step('stepLesson', 'done');
    text($('lessonChip'), 'Done ✓');
    show($('lessonSuggest'), suggest);
    text($('lessonSuggest'), 'Fractions – Week 4?');
    text($('fileNamePreview'), `Will save as: ${LESSON} (2026-10-08 14.32).mp4`);
    $('notes').value = NOTES;
  }

  function micOptions() {
    const sel = $('micSelect');
    sel.replaceChildren(
      new Option(MIC, 'jabra'),
      new Option('Microphone Array (Realtek Audio) (Windows default)', 'default'),
      new Option('Microphone (HD Pro Webcam C920)', 'c920'),
    );
    sel.value = 'jabra';
  }

  function micLive({ collapsed = false, chip = 'Sounds great ✓', status = 'done', db = -19 } = {}) {
    show($('micIntro'), false);
    show($('micControls'), true);
    micOptions();
    show($('micSuggest'), false);
    show($('btnSoundCheck'), true);
    text($('btnSoundCheck'), 'Check again');
    step('stepMic', status, collapsed);
    text($('micChip'), chip);
    show($('micSummary'), collapsed);
    text($('micSummary').querySelector('[data-field="summary"]'), 'Microphone · Headset Microphone · Sounds great · checked 14:02');
    animateMeter($('micMeter'), $('micMeterLabel'), db, LABELS.setup);
  }

  function screenChosen({ collapsed = true } = {}) {
    show($('screenIntro'), false);
    show($('screenSummary'), true);
    text($('screenLabel'), 'Whole screen');
    text($('screenDetail'), '1920×1080');
    text($('btnChooseScreen'), 'Change');
    const sys = $('sysAudioChip');
    show(sys, true);
    sys.dataset.status = 'done';
    text(sys, 'Computer sound: included ✓');
    show($('screenTip'), true);
    step('stepScreen', 'done', collapsed);
    text($('screenChip'), 'Done ✓');
  }

  function cameraOn() {
    $('cameraToggle').checked = true;
    show($('cameraControls'), true);
    const sel = $('cameraSelect');
    sel.replaceChildren(new Option('HD Pro Webcam C920', 'c920'), new Option('Integrated Camera', 'int'));
    step('stepCamera', 'done');
    text($('cameraChip'), 'On ✓');
    $('btnCornerBR').setAttribute('aria-pressed', 'true');
    for (const id of ['btnCornerTL', 'btnCornerTR', 'btnCornerBL']) $(id).setAttribute('aria-pressed', 'false');
  }

  function readiness(ready, line) {
    text($('readiness'), line);
    $('readiness').dataset.ready = ready ? 'true' : 'false';
    const btn = $('btnStart');
    if (ready) btn.removeAttribute('aria-disabled'); else btn.setAttribute('aria-disabled', 'true');
  }

  const SCREEN_IMG = screenShot();
  function stageLive({ bubble = true } = {}) {
    const st = $('stage');
    st.dataset.mode = 'live';
    const v = $('screenVideo');
    v.poster = SCREEN_IMG;
    show(v, true);
    show($('stageEmpty'), false);
    text($('stageLabel'), 'Live preview');
    if (bubble) {
      show($('bubblePreview'), true);
      $('cameraVideo').poster = webcam();
      text($('stageHint'), 'Drag the camera bubble to move it');
      show($('stageHint'), true);
    }
  }

  function banner({ kind, title, body, actions = [], dismissible = false, role = 'alert' }) {
    const el = fill(clone('tplBanner'), { title, text: body });
    el.dataset.kind = kind;
    el.setAttribute('role', role);
    buttons(el.querySelector('[data-actions]'), actions);
    for (const d of el.querySelectorAll('[data-action="dismiss"]')) show(d, dismissible);
    $('banners').append(el);
    show($('banners'), true);
    return el;
  }

  function toast({ kind, title, body = '', actions = [] }) {
    const el = fill(clone('tplToast'), { title, text: body });
    el.dataset.kind = kind;
    el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    buttons(el.querySelector('[data-actions]'), actions);
    $('toasts').prepend(el);
  }

  function message(slotId, { kind, title, body, actions = [] }) {
    const slot = $(slotId);
    const el = fill(clone('tplMessage'), { title, text: body });
    el.dataset.kind = kind;
    buttons(el.querySelector('[data-actions]'), actions);
    slot.replaceChildren(el);
    show(slot, true);
  }

  function recordingView(paused) {
    setPhase(paused ? 'paused' : 'recording');
    text($('recLesson'), LESSON);
    const pill = $('recPill');
    text(pill, paused ? '❚❚ Paused' : '● Recording');
    pill.dataset.state = paused ? 'paused' : 'recording';
    text($('recTimer'), '23:41');
    text($('recSafety'), 'Safety copy: on');
    $('recSafety').dataset.on = 'true';
    show($('recSysRow'), true);
    const btnPause = $('btnPause');
    text(btnPause.querySelector('[data-field="label"]'), paused ? 'Resume' : 'Pause');
    btnPause.setAttribute('aria-pressed', paused ? 'true' : 'false');
    text($('markerCount'), '3');
    show($('markerCount'), true);
    $('btnPopout').setAttribute('aria-pressed', 'true');
    text($('recNotes'), NOTES);
    show($('recNotes'), true);
    show($('recBanner'), paused);
    show($('recTalkingHint'), paused);
    animateMeter($('recMicMeter'), $('recMicLabel'), paused ? -24 : -18, LABELS.rec);
    animateMeter($('recSysMeter'), null, -31, null);
    // Stage: a still picture while recording (saves power, no mirror-in-mirror).
    const st = $('stage');
    st.dataset.mode = 'recording';
    show($('stageEmpty'), false);
    const thumb = $('stageThumb');
    thumb.src = SCREEN_IMG;
    thumb.alt = 'Recording in progress – preview hidden to save power';
    show(thumb, true);
    text($('stageLabel'), 'Recording – preview hidden');
    if (!paused) toast({ kind: 'success', title: 'Chapter 3 added', body: 'At 23:14. You can rename it after you stop.' });
    let s = 23 * 60 + 41;
    if (ANIMATE && !paused) setInterval(() => { s += 1; text($('recTimer'), `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`); }, 1000);
  }

  function reviewView() {
    setPhase('review');
    text($('reviewHeading'), 'Take 2 · 14 min 32 s · 412 MB');
    $('reviewName').value = LESSON;
    text($('reviewSaved'), `Saved to Lessons › ${LESSON} (2026-10-08 14.32).mp4 ✓`);
    $('reviewSaved').dataset.saved = 'folder';
    show($('reviewNotice'), false);
    const list = $('chapterList');
    list.replaceChildren(...[
      ['0:00', 'Introduction'], ['2:15', 'The pizza example'], ['6:40', 'Adding with different denominators'], ['11:05', 'Practice questions'],
    ].map(([time, title], i) => {
      const el = fill(clone('tplChapter'), { time, title });
      el.dataset.id = `m${i}`;
      el.querySelector('[data-field="title"]').setAttribute('aria-label', `Chapter title at ${time}`);
      return el;
    }));
    show($('chapterEmpty'), false);
    show($('chapterIssues'), false);
    show($('btnFinish'), true);
    text($('btnDownloadTake').querySelector('[data-field="label"]'), 'Download a copy');
    const st = $('stage');
    st.dataset.mode = 'playback';
    show($('stageEmpty'), false);
    const v = $('reviewVideo');
    v.poster = SCREEN_IMG;
    show(v, true);
    text($('stageLabel'), 'Playing back');
  }

  /* ── states ── */
  function setupState() {
    setPhase('setup');
    lessonStep();
    // Microphone: no permission yet, so only the explainer + "Turn on microphone".
    show($('micIntro'), true);
    show($('micControls'), false);
    show($('btnSoundCheck'), false);
    step('stepMic', 'todo');
    text($('micChip'), 'To do');
    readiness(false, '✗ Microphone: not on yet · • Screen: you’ll pick it next · Lesson: Fractions – Week 3');
    banner({
      kind: 'warning', role: 'region',
      title: 'We found a recording that didn’t finish',
      body: '“Fractions – Week 3”, 8 Oct at 14:32, about 12 minutes. Save it before it’s lost.',
      actions: [{ label: 'Save it', primary: true }, { label: 'Delete it…' }],
    });
  }

  function soundcheckState() {
    setPhase('setup');
    lessonStep({ suggest: false });
    micLive({ chip: 'Usable ✓', status: 'done', db: -19 });
    const r = $('scResult');
    r.dataset.status = 'usable';
    show(r, true);
    text($('scHeadline'), 'Usable – one tip below');
    $('scHeadline').dataset.status = 'usable';
    text($('scText'), 'Some background sound will be heard. Moving closer to the microphone lifts your voice over the room better than more volume does.');
    const tips = $('scTips');
    const tip = fill(clone('tplMessage'), { title: 'Your voice: a clear level (140%)', text: 'Your voice comes through clearly. Keep the microphone where it is.' });
    tip.dataset.kind = 'success';
    tip.querySelector('[data-actions]').setAttribute('hidden', '');
    tips.replaceChildren(tip);
    show(tips, true);
    text($('scApplied'), 'Mic level adjusted for your voice: set to 140%.');
    show($('scApplied'), true);
    show($('btnScPlay'), true);
    text($('btnScPlay'), 'Hear it back');
    const fix = $('scFix');
    show(fix, true);
    fix.open = true;
    const steps = (id, list) => {
      const ol = document.createElement('ol');
      for (const s of list) { const li = document.createElement('li'); li.textContent = s; ol.append(li); }
      $(id).querySelector('[data-field="steps"]').replaceChildren(ol);
    };
    steps('scFixWin11', ['Turn off fans or air conditioning, and close the door and windows.', 'For hiss: Settings › System › Sound › More sound settings › Recording › your microphone › Properties › Levels › set Microphone Boost to 0.']);
    steps('scFixWin10', ['Turn off fans or air conditioning, and close the door and windows.', 'For hiss: Settings › System › Sound › Sound Control Panel › Recording › your microphone › Properties › Levels › set Microphone Boost to 0.']);
    readiness(false, '✓ Microphone: Headset Microphone · • Screen: you’ll pick it next · Lesson: Fractions – Week 3');
    $('btnStart').removeAttribute('aria-disabled');
    // The app moves focus to the verdict heading; bring the step into view like that.
    requestAnimationFrame(() => {
      const panel = $('stepMic').closest('.panel');
      if (panel.scrollHeight > panel.clientHeight + 4) panel.scrollTop = $('stepMic').getBoundingClientRect().top - panel.getBoundingClientRect().top + panel.scrollTop;
      else $('stepMic').scrollIntoView({ block: 'start' });
    });
  }

  function readyState() {
    setPhase('ready');
    lessonStep({ suggest: false });
    micLive({ collapsed: true });
    screenChosen();
    cameraOn();
    readiness(true, 'All set · ✓ Microphone: Headset Microphone · ✓ Whole screen · ✓ Camera · Lesson: Fractions – Week 3');
    stageLive();
  }

  function countdownState() {
    readyState();
    setPhase('countdown');
    const btn = $('btnStart');
    btn.dataset.state = 'countdown';
    text(btn.querySelector('[data-field="label"]'), 'Cancel (3)');
    show($('countdown'), true);
    text($('countdownNum'), '3');
    show($('stageHint'), false);
  }

  function problemsState() {
    setPhase('setup');
    lessonStep({ suggest: false });
    show($('micIntro'), false);
    show($('micControls'), true);
    micOptions();
    setMeter($('micMeter'), $('micMeterLabel'), -100, -100, LABELS.setup);
    step('stepMic', 'attention');
    text($('micChip'), 'Needs attention');
    message('micMessage', { kind: 'error', title: 'Your microphone is in use by another app', body: 'Close Teams, Zoom or Skype, then try again.', actions: [{ label: 'Try again' }] });
    show($('screenIntro'), false);
    show($('screenSummary'), true);
    text($('screenLabel'), 'One window');
    text($('screenDetail'), '1280×720 · Fractions – Week 3.pptx');
    text($('btnChooseScreen'), 'Change');
    const sys = $('sysAudioChip');
    show(sys, true); sys.dataset.status = 'todo';
    text(sys, 'Computer sound: not included – choose again to include it');
    message('screenMessage', { kind: 'warning', title: 'Only one window will be recorded', body: 'To record everything on a monitor, click Change and use the “Entire screen” tab.', actions: [{ label: 'Change' }] });
    step('stepScreen', 'attention');
    text($('screenChip'), 'Check this');
    $('cameraToggle').checked = true;
    step('stepCamera', 'attention');
    text($('cameraChip'), 'Needs attention');
    message('cameraMessage', { kind: 'error', title: 'Camera blocked', body: 'Click the icon at the left of the address bar and allow the camera.', actions: [{ label: 'Try again' }] });
    readiness(false, '✗ Microphone: not on yet · ✓ One window · Lesson: Fractions – Week 3');
    text($('startHint'), 'Turn on your microphone first, or choose “Record without my voice” in Settings.');
    show($('startHint'), true);
    stageLive({ bubble: false });
    text($('stageHint'), 'Only one window is being recorded');
    show($('stageHint'), true);
    banner({ kind: 'error', title: 'No sound from your microphone', body: 'It may be muted. Check the mute switch on your headset cable.' });
    toast({ kind: 'warning', title: 'Your folder needs permission again', body: 'Click “Reconnect” at the top to keep saving there.', actions: [{ label: 'Reconnect', primary: true }] });
    folderChip('needs-permission');
  }

  function popoutState() {
    // Clone first: the template lives in the body that is about to be replaced.
    const root = clone('tplPopout', document);
    document.body.replaceChildren();
    document.body.className = 'popout';
    const part = n => root.querySelector(`[data-part="${n}"]`);
    const kind = PO;
    const active = ['recording', 'paused', 'nosound', 'confirm'].includes(kind);
    const phase = kind === 'paused' ? 'paused' : kind === 'idle' ? 'ready' : kind === 'countdown' ? 'countdown' : 'recording';
    document.body.dataset.phase = phase;
    if (kind === 'nosound') document.body.dataset.alert = 'nosound';
    show(part('idle'), kind === 'idle');
    show(part('active'), active && kind !== 'confirm');
    show(part('confirm'), kind === 'confirm');
    show(part('nosound'), kind === 'nosound');
    const pill = root.querySelector('[data-field="pill"]');
    pill.textContent = { paused: '❚❚ PAUSED', nosound: '⚠ NO SOUND', idle: 'READY', countdown: 'STARTING…' }[kind] || '● REC';
    pill.dataset.state = kind === 'nosound' ? 'nosound' : phase;
    fill(root, { lesson: LESSON, notes: NOTES, timer: '23:41', countdown: kind === 'countdown' ? '3' : '' });
    for (const el of root.querySelectorAll('[data-field="countdown"]')) show(el, kind === 'countdown');
    for (const el of root.querySelectorAll('[data-field="notes"]')) show(el, kind !== 'countdown');
    const pause = root.querySelector('[data-action="pause"]');
    text(pause.querySelector('[data-field="label"]'), kind === 'paused' ? 'Resume' : 'Pause');
    pause.setAttribute('aria-pressed', kind === 'paused' ? 'true' : 'false');
    const mc = root.querySelector('[data-field="markerCount"]');
    if (mc) { mc.textContent = '3'; show(mc, true); }
    text(root.querySelector('[data-field="confirmText"]'), 'Discard 23 min 41 s? This can’t be undone.');
    document.body.append(root);
    const m = root.querySelector('[data-field="meter"]');
    const ml = root.querySelector('[data-field="micLabel"]');
    if (kind === 'nosound') setMeter(m, ml, -100, -100, LABELS.po);
    else animateMeter(m, ml, kind === 'paused' ? -26 : -18, LABELS.po);
  }

  /* ── boot ── */
  folderChip('ready');
  if (STATE !== 'popout') library(STATE === 'review' ? 't3' : null);
  switch (STATE) {
    case 'ready': readyState(); break;
    case 'soundcheck': soundcheckState(); break;
    case 'countdown': countdownState(); break;
    case 'recording': recordingView(false); break;
    case 'paused': recordingView(true); break;
    case 'review': reviewView(); break;
    case 'library':
      readyState();
      requestAnimationFrame(() => $('library').scrollIntoView({ block: 'start' }));
      break;
    case 'problems': problemsState(); break;
    case 'popout': popoutState(); break;
    default: setupState();
  }

  if (DIALOG && STATE !== 'popout') {
    const d = { settings: 'settingsDialog', help: 'helpDialog', confirm: 'confirmDialog' }[DIALOG];
    if (DIALOG === 'confirm') {
      text($('confirmTitle'), 'Discard this take?');
      text($('confirmText'), '23 min 41 s will be deleted. This can’t be undone.');
      text($('btnConfirmOk'), 'Discard take');
      text($('btnConfirmCancel'), 'Keep recording');
    }
    if (DIALOG === 'settings') {
      text($('gainLabel'), '140%');
      $('gainSlider').value = 140;
      $('advancedAudio').open = params.has('advanced');
      $('detailMeters').open = params.has('advanced');
      text($('statFloor'), '−58 dB'); text($('statVoice'), '−19 dB'); text($('statSnr'), '31 dB'); text($('statPeak'), '−7 dB');
      text($('folderStatus'), 'New takes save straight into “Lessons”.');
      text($('btnChooseFolder'), 'Change folder');
      show($('btnForgetFolder'), true);
    }
    if (d) $(d).showModal();
  }

  if (STATE === 'popout') return;
  // Wire the dialogs so the demo can be clicked through.
  $('btnSettings').addEventListener('click', () => $('settingsDialog').showModal());
  $('btnHelp').addEventListener('click', () => $('helpDialog').showModal());
  $('btnSettingsClose').addEventListener('click', () => $('settingsDialog').close());
  $('btnHelpClose').addEventListener('click', () => $('helpDialog').close());
  for (const id of ['btnConfirmCancel', 'btnConfirmOk']) $(id).addEventListener('click', () => $('confirmDialog').close());
  for (const id of ['btnDiscard', 'btnDeleteTake']) $(id).addEventListener('click', () => $('confirmDialog').showModal());
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-action="dismiss"]');
    if (b) b.closest('.toast, .banner')?.remove();
  });
})();
