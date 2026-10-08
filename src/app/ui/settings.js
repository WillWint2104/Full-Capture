// Settings dialog: file type, quality, behaviour switches, theme, save
// location, and Advanced audio with detailed meters.

import { $, show, text, attr, value, label } from './dom.js';
import { QUALITY_PRESETS } from '../media/formats.js';
import { formatBytes } from '../lib/time.js';
import { wireDialog } from './dialogs.js';

const fmtDb = db => (Number.isFinite(db) && db > -99 ? `${db >= 0 ? '+' : '−'}${Math.abs(db).toFixed(0)} dB` : '—');

export class SettingsView {
  constructor(session, { meters, confirm }) {
    this.session = session;
    this.confirm = confirm;
    this.dialog = wireDialog('settingsDialog', ['btnSettings'], 'btnSettingsClose', { onOpen: () => this.render(session.state) });
    this.lastMeter = null;
    session.on('meter', m => { this.lastMeter = m; });
    meters.onFrame(() => this.#drawDetails());
    this.#wire();
  }

  open() { this.dialog.open(); }

  #wire() {
    const s = this.session;
    const on = (id, evt, fn) => $(id).addEventListener(evt, fn);
    on('formatSelect', 'change', e => s.setFormat(e.target.value));
    on('qualitySelect', 'change', e => s.setQuality(e.target.value));
    on('countdownToggle', 'change', e => s.setCountdown(e.target.checked));
    on('beepsToggle', 'change', e => s.setPref('beeps', e.target.checked));
    on('floatingToggle', 'change', e => s.setPref('floatingControls', e.target.checked));
    on('hidePreviewToggle', 'change', e => s.setPref('hidePreview', e.target.checked));
    on('shortcutsToggle', 'change', e => s.setPref('shortcuts', e.target.checked));
    on('themeSelect', 'change', e => s.setPref('theme', e.target.value));
    on('btnChooseFolder', 'click', () => s.chooseFolder());
    on('btnForgetFolder', 'click', async () => {
      const ok = await this.confirm({ title: 'Stop saving to this folder?', text: 'Your recordings stay where they are. New takes will download to your Downloads folder until you choose a folder again.', ok: 'Stop using folder' });
      if (ok) s.forgetFolder();
    });
    on('rawMicToggle', 'change', e => s.setAudioMode(e.target.checked ? 'studio' : 'clean'));
    on('speakersToggle', 'change', e => s.setSpeakers(e.target.checked));
    on('gateToggle', 'change', e => s.setGate(e.target.checked));
    on('autoLevelToggle', 'change', e => s.setAutoLevel(e.target.checked));
    on('gainSlider', 'input', e => { s.setGain(Number(e.target.value) / 100); text($('gainLabel'), `${e.target.value}%`); });
    on('sysAudioLevel', 'input', e => s.setSystemAudioLevel(Number(e.target.value) / 100));
    on('noVoiceToggle', 'change', e => s.setNoVoice(e.target.checked));
    on('btnResetSettings', 'click', async () => {
      const ok = await this.confirm({ title: 'Reset all settings?', text: 'Your sound checks, choices and saved folder go back to the defaults. Your recordings are not touched.', ok: 'Reset settings', danger: true });
      if (ok) { s.resetSettings(); location.reload(); }
    });
  }

  render(st) {
    const recording = ['countdown', 'recording', 'paused', 'stopping'].includes(st.phase);
    const mp4Option = $('formatSelect').querySelector('option[value="mp4"]');
    if (mp4Option) mp4Option.disabled = !st.formats.mp4;
    value($('formatSelect'), st.lesson.format === 'mp4' && !st.formats.mp4 ? 'auto' : st.lesson.format);
    text($('formatNote'), st.formats.mp4
      ? 'MP4 plays almost everywhere and imports cleanly into video editors. WebM files are a little smaller.'
      : 'This browser can’t record MP4 – update Chrome or Edge to get it. WebM still uploads to YouTube and Google Drive.');
    value($('qualitySelect'), st.lesson.quality);
    text($('qualityNote'), QUALITY_PRESETS[st.lesson.quality]?.note || '');
    const e = st.estimate;
    text($('sizeEstimate'), e ? `About ${formatBytes(e.bytesPerHour)} per hour of recording (${e.width}×${e.height}, ${e.container.toUpperCase()}).` : '');
    for (const id of ['formatSelect', 'qualitySelect', 'rawMicToggle', 'speakersToggle', 'noVoiceToggle']) $(id).disabled = recording;

    value($('countdownToggle'), st.lesson.countdown);
    value($('beepsToggle'), st.prefs.beeps);
    value($('floatingToggle'), st.prefs.floatingControls);
    value($('hidePreviewToggle'), st.prefs.hidePreview);
    value($('shortcutsToggle'), st.prefs.shortcuts);
    value($('themeSelect'), st.prefs.theme);

    const f = st.folder;
    const statusText = !f.supported ? 'This browser saves recordings to your Downloads folder.'
      : f.status === 'ready' ? `New takes save straight into “${f.name}”.`
      : f.status === 'needs-permission' ? `“${f.name}” needs your permission again. Click Reconnect folder at the top of the page.`
      : 'Recordings go to your Downloads folder. Choose a folder to save them straight there, with no download step.';
    text($('folderStatus'), statusText);
    show($('btnChooseFolder'), f.supported);
    label($('btnChooseFolder'), f.status === 'ready' || f.status === 'needs-permission' ? 'Change folder' : 'Choose a folder');
    show($('btnForgetFolder'), f.supported && (f.status === 'ready' || f.status === 'needs-permission'));

    const a = st.audio;
    value($('rawMicToggle'), a.mode === 'studio');
    value($('speakersToggle'), a.speakers);
    value($('gateToggle'), a.gate);
    value($('autoLevelToggle'), a.autoLevel);
    const pct = Math.round(a.gain * 100);
    value($('gainSlider'), pct);
    if (document.activeElement !== $('gainSlider')) text($('gainLabel'), `${pct}%`);
    attr($('gainSlider'), 'aria-valuetext', `Mic level ${pct} percent`);
    value($('sysAudioLevel'), Math.round(a.systemAudioLevel * 100));
    attr($('sysAudioLevel'), 'aria-valuetext', `Computer sound ${Math.round(a.systemAudioLevel * 100)} percent`);
    value($('noVoiceToggle'), st.prefs.noVoice);

    const cal = a.calibration;
    text($('statFloor'), cal ? fmtDb(cal.noiseHiDb) : '—');
    text($('statSnr'), cal ? `${Math.round(cal.voiceLoDb - cal.noiseHiDb)} dB` : '—');
  }

  /** Spectrum and live numbers, only while the detailed meters are open. */
  #drawDetails() {
    const details = $('detailMeters');
    if (!this.dialog.isOpen || !details?.open) return;
    const m = this.lastMeter;
    if (m) {
      text($('statVoice'), fmtDb(m.voice?.rmsDb));
      text($('statPeak'), fmtDb(m.raw?.peakDb));
    }
    const canvas = $('spectrum');
    const analyser = this.session.getAnalyser();
    if (!canvas || !analyser) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const ctx = canvas.getContext('2d');
    const bins = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatFrequencyData(bins);
    const css = getComputedStyle(canvas);
    const bar = css.getPropertyValue('--spectrum-bar').trim() || css.color || '#2e8b57';
    const low = css.getPropertyValue('--spectrum-low').trim() || '#d99a1f';
    ctx.clearRect(0, 0, w, h);
    const BARS = 56;
    const nyquist = analyser.context.sampleRate / 2;
    // Log-spaced bands from 50 Hz to 12 kHz: speech detail is in the low/mid range.
    for (let i = 0; i < BARS; i++) {
      const f0 = 50 * Math.pow(12000 / 50, i / BARS), f1 = 50 * Math.pow(12000 / 50, (i + 1) / BARS);
      const b0 = Math.floor((f0 / nyquist) * bins.length), b1 = Math.max(b0 + 1, Math.floor((f1 / nyquist) * bins.length));
      let peak = -140;
      for (let b = b0; b < b1 && b < bins.length; b++) peak = Math.max(peak, bins[b]);
      const frac = Math.max(0, Math.min(1, (peak + 100) / 80));
      const bw = w / BARS;
      ctx.fillStyle = f1 < 120 ? low : bar;
      ctx.fillRect(i * bw + dpr, h - frac * h, bw - 2 * dpr, frac * h);
    }
  }
}
