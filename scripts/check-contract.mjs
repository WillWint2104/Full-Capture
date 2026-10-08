// Checks that a markup file provides every id and template the UI code
// relies on (docs/ARCHITECTURE.md › UI contract).
//   node scripts/check-contract.mjs [file.html]   (default: src/index.html)
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './bundler.mjs';

export const REQUIRED_IDS = `
btnFolder btnSettings btnHelp srStatus srAlert banners toasts viewSetup viewRecording viewReview
stepLesson lessonChip lessonName lessonSuggest fileNamePreview notes
stepMic micChip micIntro btnMicOn micControls micSelect micSuggest micMeter micMeterLabel noiseToggle micMessage
btnSoundCheck scRun scStep scInstruction scLine scProgress scResult scHeadline scText scTips scApplied btnScPlay scAudio btnScAgain
scFix scFixWin11 scFixWin10 btnScCopySteps btnScCopyPrompt micSummary
stepScreen screenChip screenIntro btnChooseScreen screenSummary screenLabel screenDetail sysAudioChip screenMessage screenTip
stepCamera cameraChip cameraToggle cameraControls cameraSelect bubbleMirror btnCornerTL btnCornerTR btnCornerBL btnCornerBR cameraMessage
readiness btnStart startHint
stage stageLabel screenVideo reviewVideo stageThumb stageEmpty btnChooseScreenBig bubblePreview cameraVideo countdown countdownNum stageHint
recBanner btnResumeBig recLesson recPill recTimer recSafety recMicMeter recMicLabel recSysRow recSysMeter btnStop btnPause btnMarker markerCount btnPopout btnDiscard recNotes recTalkingHint
reviewHeading reviewName reviewSaved reviewNotice chapterList chapterEmpty chapterIssues btnCopyChapters btnSaveChapters btnNewTake btnDownloadTake btnDeleteTake btnFinish
library takeList libraryEmpty
settingsDialog formatSelect formatNote qualitySelect qualityNote sizeEstimate countdownToggle beepsToggle floatingToggle hidePreviewToggle shortcutsToggle themeSelect
folderStatus btnChooseFolder btnForgetFolder advancedAudio rawMicToggle speakersToggle gateToggle autoLevelToggle gainSlider gainLabel sysAudioLevel noVoiceToggle
detailMeters spectrum statFloor statVoice statSnr statPeak btnResetSettings btnSettingsClose
helpDialog btnHelpClose confirmDialog confirmTitle confirmText btnConfirmCancel btnConfirmOk
tplToast tplBanner tplMessage tplTake tplChapter tplPopout
`.trim().split(/\s+/);

export const RADIOS = { bubbleShape: ['circle', 'rounded'], bubbleSize: ['s', 'm', 'l'] };
export const SELECT_VALUES = { formatSelect: ['auto', 'mp4', 'webm'], qualitySelect: ['standard', 'high', 'smooth', 'small'], themeSelect: ['system', 'light', 'dark'] };
export const TEMPLATE_PARTS = {
  tplToast: { fields: ['title', 'text'], actions: ['dismiss'], selectors: ['.toast', '[data-actions]'] },
  tplBanner: { fields: ['title', 'text'], actions: ['dismiss'], selectors: ['.banner', '[data-actions]'] },
  tplMessage: { fields: ['title', 'text'], actions: [], selectors: ['.message', '[data-actions]'] },
  tplTake: { fields: ['thumb', 'name', 'date', 'duration', 'size', 'chapters', 'saved'], actions: ['open', 'download', 'copy-chapters', 'delete'], selectors: ['.take'] },
  tplChapter: { fields: ['time', 'title'], actions: ['delete'], selectors: ['.chapter'] },
  tplPopout: {
    fields: ['pill', 'timer', 'lesson', 'micLabel', 'notes', 'countdown', 'meter'],
    actions: ['start', 'stop', 'pause', 'marker', 'more', 'discard-yes', 'discard-no'],
    selectors: ['[data-part="idle"]', '[data-part="active"]', '[data-part="confirm"]', '[data-part="nosound"]', '.meter'],
  },
};

/** Returns a list of problems (empty when the markup satisfies the contract). Runs in a browser page. */
export function checkDocument(doc) {
  const problems = [];
  for (const id of REQUIRED_IDS) {
    const n = doc.querySelectorAll(`[id="${id}"]`).length;
    if (n !== 1) problems.push(`#${id}: found ${n}`);
  }
  for (const [name, values] of Object.entries(RADIOS)) {
    for (const v of values) if (!doc.querySelector(`input[type=radio][name="${name}"][value="${v}"]`)) problems.push(`radio ${name}=${v} missing`);
  }
  for (const [id, values] of Object.entries(SELECT_VALUES)) {
    const el = doc.getElementById(id);
    for (const v of values) if (el && !el.querySelector(`option[value="${v}"]`)) problems.push(`#${id} option ${v} missing`);
  }
  for (const [id, parts] of Object.entries(TEMPLATE_PARTS)) {
    const t = doc.getElementById(id);
    if (!t || t.tagName !== 'TEMPLATE') { problems.push(`${id} is not a <template>`); continue; }
    const c = t.content;
    for (const f of parts.fields) if (!c.querySelector(`[data-field="${f}"]`)) problems.push(`${id}: [data-field=${f}] missing`);
    for (const a of parts.actions) if (!c.querySelector(`[data-action="${a}"]`)) problems.push(`${id}: [data-action=${a}] missing`);
    for (const s of parts.selectors) if (!c.querySelector(s)) problems.push(`${id}: ${s} missing`);
  }
  for (const d of ['settingsDialog', 'helpDialog', 'confirmDialog']) {
    const el = doc.getElementById(d);
    if (el && el.tagName !== 'DIALOG') problems.push(`#${d} must be a <dialog>`);
  }
  for (const m of ['micMeter', 'recMicMeter', 'recSysMeter']) {
    const el = doc.getElementById(m);
    if (el && !el.classList.contains('meter')) problems.push(`#${m} needs class "meter"`);
  }
  return problems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = path.resolve(process.argv[2] || path.join(ROOT, 'src/index.html'));
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent(await readFile(file, 'utf8'), { waitUntil: 'domcontentloaded' });
  const problems = await page.evaluate(`(${checkDocument.toString()})(document)`.replace(/REQUIRED_IDS|RADIOS|SELECT_VALUES|TEMPLATE_PARTS/g, m => JSON.stringify({ REQUIRED_IDS, RADIOS, SELECT_VALUES, TEMPLATE_PARTS }[m])));
  await browser.close();
  if (problems.length) { console.log(`${problems.length} contract problems in ${path.relative(ROOT, file)}:\n- ` + problems.join('\n- ')); process.exit(1); }
  console.log(`contract OK: ${path.relative(ROOT, file)}`);
}
