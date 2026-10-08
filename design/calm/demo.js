// Demo only — not app logic. Fills the static design with realistic content
// for one state so it can be screenshotted:
//   index.html?state=setup|ready|soundcheck|recording|paused|review|library|popout&theme=light|dark
// Extra states for design review: checking, countdown, blocked, nosound,
// settings, help, confirm (and popout with &part=idle|confirm|nosound).
(() => {
  'use strict';

  const params = new URLSearchParams(location.search);
  const state = params.get('state') || 'setup';
  const theme = params.get('theme');
  const root = document.documentElement;
  const $ = id => document.getElementById(id);

  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;

  // ── helpers ─────────────────────────────────────────────

  const show = (id, on = true) => { $(id).hidden = !on; };
  const hide = id => show(id, false);
  const text = (id, value) => { $(id).textContent = value; };

  function clone(tplId) {
    return $(tplId).content.firstElementChild.cloneNode(true);
  }

  function fill(node, fields) {
    for (const [name, value] of Object.entries(fields)) {
      const el = node.querySelector(`[data-field="${name}"]`);
      if (!el) continue;
      if (el.tagName === 'IMG') el.src = value;
      else if (el.tagName === 'INPUT') el.value = value;
      else el.textContent = value;
    }
    return node;
  }

  function addActions(node, labels) {
    const box = node.querySelector('[data-actions]');
    for (const label of labels) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      box.append(b);
    }
    return node;
  }

  function toast(kind, title, body, actions = []) {
    const t = fill(clone('tplToast'), { title, text: body });
    t.dataset.kind = kind;
    addActions(t, actions);
    $('toasts').append(t);
  }

  function banner(kind, title, body, actions = []) {
    const b = fill(clone('tplBanner'), { title, text: body });
    b.dataset.kind = kind;
    if (kind === 'recovery') b.setAttribute('role', 'region');
    addActions(b, actions);
    $('banners').append(b);
  }

  function message(slotId, kind, title, body, actions = []) {
    const m = fill(clone('tplMessage'), { title, text: body });
    m.dataset.kind = kind;
    addActions(m, actions);
    $(slotId).append(m);
  }

  const zoneOf = level => (level < 0.53 ? 'quiet' : level > 0.8 ? 'loud' : 'good');
  function meter(id, level, peak, el = $(id)) {
    el.style.setProperty('--level', level);
    el.style.setProperty('--peak', peak);
    el.dataset.zone = zoneOf(level);
    el.setAttribute('aria-valuenow', String(Math.round(level * 100)));
    const db = Math.round(level * 60 - 60);
    el.setAttribute('aria-valuetext', `${db} dB, ${{ quiet: 'too quiet', good: 'good', loud: 'too loud' }[zoneOf(level)]}`);
  }

  function step(id, status, chip, collapsed = false) {
    const s = $(id);
    s.dataset.status = status;
    s.toggleAttribute('data-collapsed', collapsed);
    s.querySelector('.chip').textContent = chip;
  }

  // ── fake imagery (inline SVG, no network) ───────────────

  const svgUrl = svg => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  const FONT = "Segoe UI, Inter, Helvetica, Arial, sans-serif";

  function slide({ title = 'Fractions – Week 3', sub = 'Equivalent fractions', accent = '#e07a35', filled = 6, n = 4 } = {}) {
    const cx = 540, cy = 650, r = 230;
    let pie = '';
    for (let i = 0; i < 8; i++) {
      const a0 = (-90 + i * 45) * Math.PI / 180, a1 = (-90 + (i + 1) * 45) * Math.PI / 180;
      const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
      const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
      pie += `<path d="M${cx} ${cy}L${x0.toFixed(1)} ${y0.toFixed(1)}A${r} ${r} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)}Z" fill="${i < filled ? accent : '#f0e6d8'}" stroke="#fbf8f2" stroke-width="8"/>`;
    }
    const bar = (y, parts, shaded) => {
      let s = '';
      const w = 640 / parts;
      for (let i = 0; i < parts; i++) s += `<rect x="${1080 + i * w}" y="${y}" width="${w - 6}" height="64" rx="8" fill="${i < shaded ? accent : '#f0e6d8'}"/>`;
      return s;
    };
    const frac = (x, top, bottom) =>
      `<text x="${x}" y="520" text-anchor="middle" font-family="${FONT}" font-size="132" font-weight="600" fill="#1f2a44">${top}</text>` +
      `<rect x="${x - 56}" y="548" width="112" height="10" rx="5" fill="#1f2a44"/>` +
      `<text x="${x}" y="690" text-anchor="middle" font-family="${FONT}" font-size="132" font-weight="600" fill="#1f2a44">${bottom}</text>`;
    let icons = '';
    for (let i = 0; i < 6; i++) icons += `<rect x="${852 + i * 40}" y="1044" width="24" height="24" rx="6" fill="${['#2f6fde', '#e0a52a', '#3a9e65', '#c43c2e', '#6b6d72', '#8a5cd6'][i]}" opacity=".85"/>`;
    return svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <rect width="1920" height="1080" fill="#fbf8f2"/>
      <rect width="1920" height="14" fill="${accent}"/>
      <text x="120" y="190" font-family="${FONT}" font-size="86" font-weight="700" fill="#1f2a44">${title}</text>
      <text x="122" y="262" font-family="${FONT}" font-size="44" fill="#68708a">${sub}</text>
      ${pie}
      ${frac(1180, '3', '4')}
      <text x="1370" y="640" text-anchor="middle" font-family="${FONT}" font-size="120" fill="#1f2a44">=</text>
      ${frac(1560, n === 4 ? '6' : '2', n === 4 ? '8' : '4')}
      ${bar(790, 4, 3)}
      ${bar(880, 8, filled)}
      <text x="1800" y="990" text-anchor="end" font-family="${FONT}" font-size="30" fill="#9aa0b0">Year 5 Maths · 4</text>
      <rect y="1032" width="1920" height="48" fill="#eceef3"/>
      ${icons}
      <text x="1872" y="1064" text-anchor="end" font-family="${FONT}" font-size="22" fill="#3b3f4a">14:32</text>
    </svg>`);
  }

  const avatar = svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">
    <defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#d9dfe4"/><stop offset="1" stop-color="#aab7c3"/></linearGradient></defs>
    <rect width="400" height="400" fill="url(#bg)"/>
    <rect x="18" y="60" width="90" height="150" rx="6" fill="#c3ccd4"/><rect x="292" y="40" width="96" height="120" rx="6" fill="#c7cfd6"/>
    <rect x="28" y="72" width="16" height="60" fill="#8fa3b6"/><rect x="48" y="80" width="14" height="52" fill="#b7826a"/><rect x="66" y="70" width="18" height="62" fill="#7c9a83"/>
    <ellipse cx="200" cy="440" rx="168" ry="150" fill="#3f5f8a"/>
    <path d="M150 312 Q200 352 250 312 L250 330 Q200 372 150 330Z" fill="#e9eef4"/>
    <rect x="174" y="250" width="52" height="66" rx="20" fill="#cf9a7d"/>
    <ellipse cx="200" cy="196" rx="70" ry="84" fill="#e2b293"/>
    <path d="M128 196 C122 118 170 92 206 96 C252 98 284 130 274 196 C266 160 246 140 214 136 C182 150 150 150 128 196Z" fill="#4a3426"/>
    <ellipse cx="174" cy="204" rx="6" ry="7" fill="#3a2a22"/><ellipse cx="226" cy="204" rx="6" ry="7" fill="#3a2a22"/>
    <path d="M182 246 Q200 258 218 246" stroke="#a3604a" stroke-width="5" fill="none" stroke-linecap="round"/>
  </svg>`);

  const THUMB_A = slide();
  const THUMB_B = slide({ sub: 'Halves and quarters', accent: '#3a7bd5', filled: 4, n: 2 });
  const THUMB_C = slide({ title: 'Fractions – Week 2', sub: 'What is a fraction?', accent: '#3a9e65', filled: 3, n: 2 });

  // ── common content ──────────────────────────────────────

  const LESSON = 'Fractions – Week 3';
  const FILE = 'Fractions – Week 3 (2026-10-08 14.32).mp4';
  const NOTES = 'Start with the pizza example.\nAsk: is 2/4 the same as 1/2?\nHomework: worksheet 3B, due Friday.';
  const MIC = 'Headset Microphone (Jabra Evolve2 30)';

  $('btnFolder').textContent = 'Saving to Lessons';
  $('folderStatus').textContent = 'New takes are saved straight into the folder “Lessons”.';
  $('lessonName').value = LESSON;
  $('lessonSuggest').textContent = 'Fractions – Week 4?';
  text('fileNamePreview', `Will save as: ${FILE}`);
  $('notes').value = NOTES;

  $('micSelect').innerHTML = '';
  for (const [value, label] of [['jabra', MIC], ['default', 'Microphone Array (Realtek Audio) (Windows default)'], ['cam', 'Microphone (HD Pro Webcam C920)']]) {
    $('micSelect').append(new Option(label, value));
  }
  $('micSuggest').textContent = 'Use Jabra Evolve2 30';
  $('cameraSelect').innerHTML = '';
  $('cameraSelect').append(new Option('HD Pro Webcam C920', 'c920'), new Option('Integrated Camera', 'int'));

  const takes = [
    { thumb: THUMB_A, name: 'Fractions – Week 3', date: 'Today, 14:32', duration: '14 min 32 s', size: '412 MB', chapters: '4 chapters', saved: 'In Lessons' },
    { thumb: THUMB_B, name: 'Fractions – Week 3', date: 'Today, 14:05', duration: '3 min 08 s', size: '89 MB', chapters: 'No chapters', saved: 'In Lessons' },
    { thumb: THUMB_C, name: 'Fractions – Week 2', date: '1 Oct, 09:15', duration: '41 min 20 s', size: '1.2 GB', chapters: '6 chapters', saved: 'Downloaded to your Downloads folder' },
  ];
  for (const t of takes) $('takeList').append(fill(clone('tplTake'), t));
  hide('libraryEmpty');

  const chapters = [['00:00', 'Introduction'], ['02:15', 'Halves and quarters'], ['06:40', 'Equivalent fractions'], ['11:05', 'Practice questions']];
  for (const [time, title] of chapters) $('chapterList').append(fill(clone('tplChapter'), { time, title }));

  const fixSteps = {
    win11: [
      'Keep the microphone a hand-span from your mouth and speak at your normal teaching voice.',
      'For hiss: Settings › System › Sound › More sound settings › Recording › your microphone › Properties › Levels › set Microphone Boost to 0.',
    ],
    win10: [
      'Keep the microphone a hand-span from your mouth and speak at your normal teaching voice.',
      'For hiss: Settings › System › Sound › Sound Control Panel › Recording › your microphone › Properties › Levels › set Microphone Boost to 0.',
    ],
  };
  for (const os of ['win11', 'win10']) {
    const list = $(os === 'win11' ? 'scFixWin11' : 'scFixWin10');
    for (const s of fixSteps[os]) { const li = document.createElement('li'); li.textContent = s; list.append(li); }
  }

  $('recNotes').textContent = NOTES;
  text('recLesson', LESSON);
  text('sizeEstimate', 'About 1.7 GB per hour');
  $('formatSelect').value = 'mp4';
  text('gainLabel', '140%');
  $('gainSlider').value = '140';

  // ── building blocks per state ───────────────────────────

  function micReady({ collapsed = true, status = 'done', chip = 'Done ✓' } = {}) {
    step('stepMic', status, chip, collapsed);
    hide('micIntro');
    show('micControls');
    $('micSelect').value = 'jabra';
    $('micSuggest').hidden = true;
    meter('micMeter', 0.66, 0.74);
    text('micMeterLabel', 'Good level');
    text('micSummary', `${MIC} · Sound checked 14:02 · Sounds great`);
    show('micSummary');
  }

  function screenReady({ collapsed = true } = {}) {
    step('stepScreen', 'done', 'Done ✓', collapsed);
    hide('screenIntro');
    show('screenSummary');
    text('screenLabel', 'Whole screen');
    text('screenDetail', '1920×1080 · Screen 1 of 2');
    show('sysAudioChip');
    $('sysAudioChip').dataset.status = 'ok';
    text('sysAudioChip', 'Computer sound: Included ✓');
    show('screenTip');
    $('btnChooseScreen').textContent = collapsed ? 'Change' : 'Choose again';
  }

  function liveStage({ bubble = false } = {}) {
    hide('stageEmpty');
    show('screenVideo');
    $('screenVideo').poster = THUMB_A;
    text('stageLabel', 'Live preview');
    show('stageLabel');
    if (bubble) {
      show('bubblePreview');
      $('cameraVideo').poster = avatar;
      text('stageHint', 'Drag the bubble to move it. This is exactly what will be recorded.');
    } else {
      text('stageHint', 'This is exactly what will be recorded.');
    }
  }

  function readyBase() {
    root.dataset.phase = 'ready';
    step('stepLesson', 'done', 'Done ✓');
    micReady();
    screenReady();
    step('stepCamera', 'todo', 'Optional');
    text('readiness', `✓ Microphone: Jabra headset · ✓ Whole screen · Lesson: ${LESSON}`);
    $('btnStart').removeAttribute('aria-disabled');
    liveStage();
  }

  function recordingBase() {
    root.dataset.phase = 'recording';
    hide('viewSetup');
    show('viewRecording');
    text('recPill', '● Recording');
    text('recTimer', '12:34');
    text('recSafety', 'Safety copy: on');
    meter('recMicMeter', 0.64, 0.72);
    text('recMicLabel', 'We can hear you ✓');
    meter('recSysMeter', 0.4, 0.5);
    text('markerCount', '3');
    hide('stageEmpty');
    show('stageThumb');
    $('stageThumb').src = THUMB_A;
    text('stageLabel', 'Still image');
    show('stageLabel');
    text('stageHint', 'Preview paused to save power – your whole screen is still being recorded.');
    show('bubblePreview');
    $('cameraVideo').poster = avatar;
    $('btnCornerBR').setAttribute('aria-pressed', 'true');
    document.title = `● 12:34 Recording – ${LESSON}`;
  }

  function reviewBase() {
    root.dataset.phase = 'review';
    hide('viewSetup');
    show('viewReview');
    text('reviewHeading', 'Take 2 · 14 min 32 s · 412 MB');
    $('reviewName').value = LESSON;
    text('reviewSaved', `Saved to Lessons › ${FILE} ✓`);
    show('chapterIssues');
    $('chapterIssues').dataset.kind = 'success';
    text('chapterIssues', '✓ Ready for YouTube – starts at 0:00, 4 chapters, each at least 10 seconds.');
    hide('stageEmpty');
    show('reviewVideo');
    $('reviewVideo').poster = THUMB_A;
    text('stageLabel', 'Playing back');
    show('stageLabel');
    text('stageHint', '');
    $('takeList').firstElementChild.setAttribute('aria-current', 'true');
  }

  const idle0 = part => part === 'idle' || part === 'countdown';
  function renderPopout(part = 'active') {
    const pop = clone('tplPopout');
    fill(pop, {
      pill: idle0(part) ? 'Ready' : '● Recording',
      timer: '12:34',
      lesson: LESSON,
      micLabel: 'We can hear you ✓',
      notes: NOTES,
      countdown: part === 'countdown' ? '3' : '',
    });
    meter(null, 0.64, 0.72, pop.querySelector('.meter'));
    const idle = part === 'idle' || part === 'countdown';
    const parts = { idle, active: !idle, confirm: part === 'confirm', nosound: part === 'nosound' };
    for (const [name, on] of Object.entries(parts)) pop.querySelector(`[data-part="${name}"]`).hidden = !on;
    if (part === 'nosound') {
      meter(null, 0, 0.02, pop.querySelector('.meter'));
      pop.querySelector('[data-field="micLabel"]').textContent = 'No sound for 6 seconds';
    }
    if (part === 'countdown') pop.querySelector('[data-field="pill"]').textContent = 'Starting…';
    root.removeAttribute('data-theme');
    root.removeAttribute('data-phase');
    document.body.replaceChildren(pop);
    document.body.className = 'popout';
    if (theme) document.body.dataset.theme = theme;
    document.title = 'Floating controls';
  }

  // ── states ──────────────────────────────────────────────

  const states = {
    setup() {
      root.dataset.phase = 'setup';
      banner('recovery', 'We found a recording that didn’t finish',
        '‘Fractions – Week 3’, 8 Oct at 14:32, about 12 minutes. Save it before you record again.',
        ['Save it', 'Delete it…']);
      step('stepLesson', 'done', 'Done ✓');
      step('stepMic', 'todo', 'To do');
      step('stepScreen', 'todo', 'To do');
      step('stepCamera', 'todo', 'Optional');
      text('readiness', 'Still to do: turn on your microphone · choose a screen');
      $('btnStart').setAttribute('aria-disabled', 'true');
      hide('stageLabel');
      text('stageHint', '');
    },

    ready() {
      readyBase();
      step('stepCamera', 'done', 'On ✓');
      $('cameraToggle').checked = true;
      show('cameraControls');
      $('btnCornerBR').setAttribute('aria-pressed', 'true');
      liveStage({ bubble: true });
      text('readiness', `✓ Microphone: Jabra headset · ✓ Whole screen · ✓ Camera · Lesson: ${LESSON}`);
    },

    soundcheck() {
      readyBase();
      micReady({ collapsed: false });
      show('scResult');
      $('scHeadline').dataset.status = 'usable';
      text('scHeadline', 'Usable – one tip below');
      text('scText', 'Your voice comes through clearly, but there’s a little hiss behind it.');
      const li = document.createElement('li');
      li.innerHTML = '<strong>Background: a little hiss</strong>The room sounds quiet, so the hiss probably comes from “Microphone Boost” in Windows. Turning it down gives a cleaner sound.';
      $('scTips').append(li);
      text('scApplied', 'Mic level adjusted for your voice (140%) and room-noise blocking turned on.');
      show('scFix');
      $('scFix').open = true;
      text('micSummary', `${MIC} · Sound checked 14:02 · Usable`);
    },

    checking() {
      readyBase();
      micReady({ collapsed: false, status: 'todo', chip: 'Checking…' });
      show('scRun');
      text('scStep', 'Step 3 of 3 · Read this aloud');
      text('scInstruction', 'Read this at your normal teaching voice:');
      show('scLine');
      $('scProgress').value = 0.45;
      meter('micMeter', 0.7, 0.78);
    },

    blocked() {
      root.dataset.phase = 'setup';
      step('stepLesson', 'done', 'Done ✓');
      step('stepMic', 'attention', 'Needs attention');
      hide('micIntro');
      message('micMessage', 'error', 'Your browser blocked the microphone',
        'Click the camera-and-mic icon at the right of the address bar, choose “Always allow”, then try again.', ['Try again']);
      step('stepScreen', 'attention', 'Needs attention');
      hide('screenIntro');
      show('screenSummary');
      text('screenLabel', 'One window');
      text('screenDetail', 'PowerPoint – Fractions Week 3.pptx');
      show('sysAudioChip');
      $('sysAudioChip').dataset.status = 'missing';
      text('sysAudioChip', 'Computer sound: Not included – Choose again to include it');
      message('screenMessage', 'warning', 'You’re sharing one window',
        'If you switch to another app, students will see a frozen image. To show everything, choose again and pick “Entire screen”.');
      $('btnChooseScreen').textContent = 'Choose again';
      step('stepCamera', 'todo', 'Optional');
      text('readiness', 'Still to do: microphone · screen');
      $('btnStart').setAttribute('aria-disabled', 'true');
      show('startHint');
      text('startHint', 'Turn on your microphone first – step 2.');
      hide('stageLabel');
      text('stageHint', '');
    },

    countdown() {
      states.ready();
      root.dataset.phase = 'countdown';
      show('countdown');
      text('countdownNum', '3');
      $('btnStart').textContent = 'Cancel (3)';
      document.title = 'Starting in 3…';
    },

    recording() {
      recordingBase();
      toast('success', 'Chapter 3 marked', 'at 11:05 – you can rename it after you stop.');
    },

    paused() {
      recordingBase();
      root.dataset.phase = 'paused';
      show('recBanner');
      show('recTalkingHint');
      text('recPill', '❚❚ Paused');
      $('btnPause').setAttribute('aria-pressed', 'true');
      $('btnPause').textContent = 'Resume';
      meter('recMicMeter', 0.6, 0.7);
      text('recMicLabel', 'You’re talking – press Resume');
      document.title = `❚❚ Paused – ${LESSON}`;
    },

    nosound() {
      recordingBase();
      banner('error', 'No sound from your microphone',
        'Nothing has come through for 6 seconds. Check the headset is plugged in and not muted – the recording carries on.', ['Check microphone']);
      meter('recMicMeter', 0, 0.02);
      text('recMicLabel', 'No sound');
      document.title = `⚠ No sound! – ${LESSON}`;
    },

    review() {
      reviewBase();
    },

    library() {
      readyBase();
      requestAnimationFrame(() => $('library').scrollIntoView({ block: 'start' }));
    },

    settings() {
      readyBase();
      $('settingsDialog').showModal();
      if (params.get('advanced')) { $('advancedAudio').open = true; $('detailMeters').open = true; }
    },

    help() {
      readyBase();
      $('helpDialog').showModal();
    },

    confirm() {
      reviewBase();
      text('confirmTitle', 'Delete this take?');
      text('confirmText', '“Fractions – Week 3” (14 min 32 s) will be removed from your Lessons folder. This can’t be undone.');
      text('btnConfirmOk', 'Delete take');
      text('btnConfirmCancel', 'Keep it');
      $('confirmDialog').showModal();
    },

    popout() {
      renderPopout(params.get('part') || 'active');
    },
  };

  (states[state] || states.setup)();
})();
