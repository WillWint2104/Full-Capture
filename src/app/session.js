// The Session owns every subsystem (audio, capture, recording, storage) and
// is the only thing the UI talks to. The UI calls actions and renders the
// immutable snapshots this emits; it never touches media APIs itself.
//
// Events:
//   'change'  snapshot (coalesced to one per microtask)
//   'meter'   engine meter data, ~25/s (not part of the snapshot)
//   'notice'  { id?, kind, title, text, actions?, timeoutMs? } for toasts

import { Emitter } from './lib/emitter.js';
import { loadSettings, saveSettings, resetSettings } from './lib/settings.js';
import { makeFilename, sidecarName, safeName } from './lib/names.js';
import { buildChapters, markerTitle } from './lib/chapters.js';
import { formatClock, formatBytes } from './lib/time.js';
import { downloadBlob, downloadUrl, captureThumbnail, copyText } from './lib/download.js';
import { detectFormats, recorderOptions, outputSize, bytesPerHour, QUALITY_PRESETS } from './media/formats.js';
import { AudioEngine } from './audio/engine.js';
import { SoundCheck, buildDesktopFixPrompt, recordClip, CHECK_TIMING } from './audio/soundcheck.js';
import { fixStepsText } from './audio/fixsteps.js';
import { pickScreen, openCamera, listDevices, onDeviceChange, CaptureError } from './video/sources.js';
import { Compositor, isCompositingSupported } from './video/compositor.js';
import { TakeRecorder } from './recording/recorder.js';
import { MemorySink, FolderSink } from './recording/sinks.js';
import { Journal, findLegacyRecording } from './recording/journal.js';
import { FolderStore } from './recording/folder.js';
import { TakesLibrary } from './recording/takes.js';

const COUNTDOWN_FROM = 3;
const TEST_CLIP_MS = 8000;
const LOW_STORAGE_BYTES = 2 * 1024 ** 3;
const TALKING_WHILE_PAUSED_S = 5;
const PREF_KEYS = ['beeps', 'floatingControls', 'hidePreview', 'shortcuts', 'theme'];

// getUserMedia failures, in the teacher's words.
const MIC_ERRORS = {
  NotAllowedError: { status: 'blocked', title: 'Microphone blocked', text: 'Click the icon at the left of the address bar, set Microphone to Allow, then reload this page.' },
  SecurityError: { status: 'blocked', title: 'Microphone blocked', text: 'Click the icon at the left of the address bar, set Microphone to Allow, then reload this page.' },
  NotFoundError: { status: 'notfound', title: 'No microphone found', text: 'Plug in your headset, then press Try again.' },
  NotReadableError: { status: 'busy', title: 'Your microphone is busy', text: 'Close Teams, Zoom or other apps using it, then press Try again.' },
  AbortError: { status: 'busy', title: 'Your microphone is busy', text: 'Close Teams, Zoom or other apps using it, then press Try again.' },
  OverconstrainedError: { status: 'notfound', title: 'Your saved microphone isn’t connected', text: 'Plug it in and press Try again, or pick another microphone.' },
};

const newId = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);

export class Session extends Emitter {
  // --- subsystems
  #settings = loadSettings();
  #formats = { mp4: null, webm: null, audio: null };
  #engine = null;
  #folder = null;
  #journal = null;
  #library = null;
  #soundCheck = null;
  #compositor = null;
  #recorder = null;

  // --- live state
  #phase = null;              // explicit phases only: 'countdown' | 'recording' | 'paused' | 'stopping'
  #countdown = null;
  #countdownTimer = null;
  #screen = null;             // { stream, videoTrack, audioTrack, surface, label, width, height }
  #mic = { status: 'off', deviceId: 'default', label: '', devices: [] };
  #audioStarted = false;
  #silent = false;
  #clipping = false;
  #sc = { running: false, phase: null, remainingMs: 0, fraction: 0, instruction: '', result: null, clipUrl: null };
  #scClipAbort = null;
  #micError = null;           // { status, title, text } for the inline card
  #talkingSince = null;       // audio-clock time speech started while paused
  #talkingWhilePaused = false;
  #lastMeterT = null;
  #endedBy = new Map();       // take id -> 'share-ended'
  #wakeLock = null;
  #testClip = { state: 'idle', remainingMs: 0, url: null, size: 0, abort: null, timer: null };
  #camera = { status: 'off', stream: null, label: '', devices: [] };
  #take = null;               // { id, filename, elapsedMs, bytes, markers, savingTo }
  #review = null;             // take id shown in review
  #takes = [];                // library rows
  #urls = new Map();          // take id -> object URL (this session only)
  #recovery = [];
  #legacy = null;
  #kept = new Set();          // take ids whose chunks the journal keeps as a safety copy of a download
  #alerts = new Map();
  #storage = null;
  #storageTimer = null;
  #dirty = false;
  #snapshot = null;
  #offDeviceChange = null;

  /** Current immutable snapshot. */
  get state() {
    if (!this.#snapshot) this.#snapshot = this.#buildSnapshot();
    return this.#snapshot;
  }

  /** True while a take is being recorded or saved (the UI warns before closing). */
  get busy() {
    return this.#phase === 'recording' || this.#phase === 'paused' || this.#phase === 'stopping';
  }

  // ------------------------------------------------------------------ boot

  async init() {
    this.#formats = detectFormats();

    this.#folder = new FolderStore();
    this.#folder.on('status', () => this.#changed());
    if (FolderStore.isSupported()) {
      try { await this.#folder.init(); } catch (e) { console.warn('folder init failed', e); }
    }

    this.#journal = await Journal.open().catch(() => null);
    this.#library = await TakesLibrary.open();
    this.#library.on('change', rows => { this.#takes = rows; this.#changed(); });
    this.#takes = await this.#library.list().catch(() => []);

    await this.#loadRecovery();
    const kept = this.#journal ? await this.#journal.listKept().catch(() => []) : [];
    this.#kept = new Set(kept.map(m => m.id));
    await this.#refreshDevices();
    this.#offDeviceChange = onDeviceChange(() => this.#refreshDevices());
    document.addEventListener('visibilitychange', () => { if (this.busy) this.#keepAwake(); });

    try { await navigator.storage?.persist?.(); } catch { /* best effort */ }

    this.#engine = new AudioEngine();
    this.#wireEngine();
    const s = this.#settings;
    // Only open the mic without asking when permission was already granted;
    // otherwise wait for the "Turn on microphone" click (no prompt on load).
    const permission = await this.#micPermission();
    const openMic = s.micEnabled && !s.noVoice && permission === 'granted';
    if (!openMic) this.#mic = { ...this.#mic, status: permission === 'denied' ? 'blocked' : (s.noVoice ? 'off' : 'needs-permission') };
    if (permission === 'denied' && !s.noVoice) this.#micError = MIC_ERRORS.NotAllowedError;
    try {
      await this.#engine.start({
        deviceId: s.micDeviceId, mode: s.audioMode, speakers: s.speakers, micEnabled: openMic,
        gain: s.micGain, gate: s.gate, autoLevel: s.autoLevel, systemAudioLevel: s.systemAudioLevel,
        calibration: null,
      });
    } catch (e) {
      this.#notice({ kind: 'error', title: 'The audio system could not start', text: e.message || String(e) });
    }
    this.#audioStarted = !!this.#engine.running;
    this.#applyCalibration();

    if (s.camera) this.setCamera(true);
    this.#checkStorage();
    this.#changed();
  }

  async #micPermission() {
    try {
      const st = await navigator.permissions.query({ name: 'microphone' });
      st.onchange = () => {
        if (st.state === 'denied') this.#setMicError(MIC_ERRORS.NotAllowedError);
        else if (st.state === 'granted' && this.#mic.status === 'blocked') this.enableMic();
      };
      return st.state;
    } catch {
      return 'prompt';
    }
  }

  #setMicError(err) {
    this.#micError = err;
    if (err) this.#mic = { ...this.#mic, status: err.status };
    this.#changed();
  }

  /** "Turn on microphone" / "Try again": opens the mic (the browser may ask permission). */
  async enableMic() {
    if (!this.#engine) return;
    this.#settings = saveSettings({ micEnabled: true, noVoice: false, micPermissionAsked: true });
    this.#micError = null;
    this.#mic = { ...this.#mic, status: 'starting' };
    this.#changed();
    await this.firstGesture();
    try {
      await this.#engine.setMicEnabled(true);
    } catch (e) {
      this.#setMicError(MIC_ERRORS[e?.name] || { status: 'error', title: 'The microphone didn’t start', text: e?.message || String(e) });
    }
    this.#changed();
  }

  /** Call from the first pointer/key event: browsers only start audio after a gesture. */
  async firstGesture() {
    if (!this.#engine || this.#engine.running) return;
    try { await this.#engine.resume(); } catch { /* reported via 'context' */ }
    this.#audioStarted = this.#engine.running;
    this.#changed();
  }

  #wireEngine() {
    const e = this.#engine;
    e.on('meter', m => {
      this.#trackTalkingWhilePaused(m);
      this.emit('meter', m);
    });
    e.on('mic', m => {
      // A mic that was never opened stays "needs permission"/"blocked", not "off".
      if (m.status === 'off' && ['needs-permission', 'blocked', 'notfound', 'busy', 'error'].includes(this.#mic.status)) return;
      const prev = this.#mic.status;
      this.#mic = { ...this.#mic, status: m.status, deviceId: m.deviceId ?? this.#mic.deviceId, label: m.label ?? this.#mic.label };
      if (m.status === 'lost') {
        this.#alert('mic-lost', 'error', 'Microphone disconnected',
          m.message || 'Your microphone stopped. Plug it back in; recording continues and the sound returns as soon as it reconnects.');
      } else if (m.status === 'live') {
        this.#clearAlert('mic-lost');
        if (prev === 'lost') this.#notice({ kind: 'success', title: 'Microphone is back', text: m.message || `Using ${m.label || 'your microphone'}.` });
        this.#applyCalibration();
        this.#refreshDevices();
      }
      if (m.status === 'live') this.#micError = null;
      else if (m.status === 'blocked' || m.status === 'error') {
        const err = MIC_ERRORS[m.errorName] || (m.status === 'blocked' ? MIC_ERRORS.NotAllowedError : null);
        this.#micError = err || { status: 'error', title: 'The microphone didn’t start', text: m.message || 'Press Try again, or pick another microphone.' };
        this.#mic = { ...this.#mic, status: this.#micError.status };
      }
      this.#changed();
    });
    e.on('gain', ({ gain }) => {
      this.#settings = saveSettings({ micGain: gain });
      this.#changed();
    });
    e.on('health', h => {
      this.#silent = !!h.digitalSilence;
      this.#clipping = !!h.clipping;
      if (h.digitalSilence && this.#settings.micEnabled) {
        this.#alert('no-audio', 'error', 'No sound from your microphone',
          'The microphone is sending pure silence. Check it is not muted (headset switch or Windows sound settings), or pick another microphone.');
      } else {
        this.#clearAlert('no-audio');
      }
      this.#changed();
    });
    e.on('context', ({ state }) => { this.#audioStarted = state === 'running'; this.#changed(); });
    // The engine switches Listen off by itself (recording with computer sound, speakers).
    e.on('monitor', ({ on, message }) => {
      this.#monitor = !!on;
      if (!on && message) this.#notice({ kind: 'info', title: 'Listening switched off', text: message, timeoutMs: 6000 });
      this.#changed();
    });
    e.on('error', ({ message }) => this.#notice({ kind: 'error', title: 'Audio problem', text: message }));
  }

  #trackTalkingWhilePaused(m) {
    if (this.#phase !== 'paused' || !m.speech) {
      if (this.#phase !== 'paused') { this.#talkingSince = null; if (this.#talkingWhilePaused) { this.#talkingWhilePaused = false; this.#changed(); } }
      else if (!m.speech && this.#lastMeterT != null && m.t - this.#lastMeterT > 1.5) this.#talkingSince = null;
      if (m.speech) this.#lastMeterT = m.t;
      return;
    }
    this.#lastMeterT = m.t;
    if (this.#talkingSince == null) this.#talkingSince = m.t;
    if (!this.#talkingWhilePaused && m.t - this.#talkingSince >= TALKING_WHILE_PAUSED_S) {
      this.#talkingWhilePaused = true;
      this.#changed();
    }
  }

  // --------------------------------------------------------------- devices

  async #refreshDevices() {
    try {
      const { mics, cameras } = await listDevices();
      this.#mic = { ...this.#mic, devices: mics };
      this.#camera = { ...this.#camera, devices: cameras };
      this.#changed();
    } catch { /* enumerateDevices unavailable */ }
  }

  // ---------------------------------------------------------------- screen

  /** Ask the teacher to pick a screen. Resolves true when one is shared. */
  async chooseScreen() {
    if (this.busy || this.#phase === 'countdown') return false;
    const preset = QUALITY_PRESETS[this.#settings.quality] || QUALITY_PRESETS.standard;
    let picked;
    try {
      picked = await pickScreen({ preset, systemAudio: this.#settings.systemAudio });
    } catch (e) {
      const code = e instanceof CaptureError ? e.code : 'failed';
      if (code === 'cancelled') {
        this.#notice({ kind: 'info', title: 'No screen chosen', text: 'Click “Choose screen” and pick a monitor on the “Entire screen” tab.', timeoutMs: 6000 });
      } else if (code === 'blocked') {
        this.#notice({ kind: 'error', title: 'Screen capture is blocked here', text: e.message || 'Open this file directly in Chrome or Edge (not inside another app’s preview), then try again.' });
      } else {
        this.#notice({ kind: 'error', title: 'Couldn’t start screen capture', text: e.message || String(e) });
      }
      return false;
    }
    this.#releaseScreen();
    this.#screen = picked;
    picked.videoTrack.addEventListener('ended', () => this.#onScreenEnded(picked));
    this.#engine?.setSystemAudioTrack(this.#settings.systemAudio ? picked.audioTrack : null);
    if (picked.surface !== 'monitor') {
      this.#alert('window-only', 'warning', 'Only one window is being recorded',
        'You picked a single window or tab. To record everything on a monitor, click “Change” and use the “Entire screen” tab.');
    } else {
      this.#clearAlert('window-only');
    }
    this.#changed();
    return true;
  }

  stopScreen() {
    if (this.busy) return;
    this.#releaseScreen();
    this.#changed();
  }

  #releaseScreen() {
    if (!this.#screen) return;
    this.#screen.stream.getTracks().forEach(t => t.stop());
    this.#engine?.setSystemAudioTrack(null);
    this.#screen = null;
    this.#clearAlert('window-only');
  }

  #onScreenEnded(picked) {
    if (this.#screen !== picked) return;
    if (this.#phase === 'recording' || this.#phase === 'paused') {
      if (this.#take) this.#endedBy.set(this.#take.id, 'share-ended');
      this.stop();
      return;
    }
    if (this.#phase === 'countdown') this.cancelCountdown();
    this.#releaseScreen();
    this.#changed();
  }

  // ------------------------------------------------------------ microphone

  async setMicEnabled(on) {
    if (on) return this.enableMic();
    this.#settings = saveSettings({ micEnabled: false });
    await this.#engine?.setMicEnabled(false);
    this.#clearAlert('no-audio'); this.#clearAlert('mic-lost');
    this.#changed();
  }

  /** Settings › Advanced › "Record without my voice". */
  async setNoVoice(on) {
    this.#settings = saveSettings({ noVoice: !!on });
    if (on) await this.setMicEnabled(false);
    else await this.enableMic();
  }

  async setMicDevice(deviceId) {
    this.#settings = saveSettings({ micDeviceId: deviceId });
    await this.#engine?.setDevice(deviceId);
    this.#applyCalibration();
    this.#changed();
  }

  async setAudioMode(mode) {
    if (mode !== 'clean' && mode !== 'studio') return;
    this.#settings = saveSettings({ audioMode: mode });
    await this.#engine?.setMode(mode);
    this.#applyCalibration();
    this.#changed();
  }

  async setSpeakers(on) {
    this.#settings = saveSettings({ speakers: !!on });
    await this.#engine?.setSpeakers(!!on);
    this.#changed();
  }

  setGain(gain) {
    this.#engine?.setGain(gain);
    this.#settings = saveSettings({ micGain: this.#engine ? this.#engine.gain : gain });
    this.#changed();
  }

  setGate(on) {
    this.#settings = saveSettings({ gate: !!on });
    this.#engine?.setGate(!!on);
    this.#changed();
  }

  setAutoLevel(on) {
    this.#settings = saveSettings({ autoLevel: !!on });
    this.#engine?.setAutoLevel(!!on);
    this.#changed();
  }

  setMonitor(on) {
    const ok = this.#engine ? this.#engine.setMonitor(!!on) !== false : false;
    if (on && !ok) { this.#monitor = false; this.#changed(); }
    if (on && !ok) {
      this.#notice({ kind: 'info', title: 'Listening is off while recording computer sound', text: 'Your voice would be recorded twice. Use Listen before you start, with headphones.' });
    } else if (on) {
      this.#notice({ kind: 'warning', title: 'Listening through your speakers?', text: 'Use headphones: through speakers this causes a loud squeal.', timeoutMs: 6000 });
    }
    this.#monitor = !!on && ok;
    this.#changed();
  }
  #monitor = false;

  setSystemAudio(on) {
    this.#settings = saveSettings({ systemAudio: !!on });
    this.#engine?.setSystemAudioTrack(on && this.#screen ? this.#screen.audioTrack : null);
    if (on && this.#screen && !this.#screen.audioTrack) {
      this.#notice({ kind: 'info', title: 'This share has no computer sound', text: 'To include sound, click “Change”, pick the screen again and tick “Also share system audio”.' });
    }
    this.#changed();
  }

  setSystemAudioLevel(v) {
    const level = Math.max(0, Math.min(1.5, Number(v) || 0));
    this.#settings = saveSettings({ systemAudioLevel: level });
    this.#engine?.setSystemAudioLevel(level);
    this.#changed();
  }

  #calibrationKey() {
    const label = this.#engine?.micInfo?.label || this.#mic.label || this.#settings.micDeviceId;
    return `${label}|${this.#settings.audioMode}`;
  }

  /** Load the stored calibration for the current mic + mode (or clear it). */
  #applyCalibration() {
    if (!this.#engine) return;
    const cal = this.#settings.calibrations?.[this.#calibrationKey()] || null;
    this.#engine.setCalibration(cal ? { noiseHiDb: cal.noiseHiDb, voiceLoDb: cal.voiceLoDb } : null);
    if (cal && Number.isFinite(cal.gain) && !this.busy) this.#engine.setGain(cal.gain);
  }

  // ------------------------------------------------------------ sound check

  async startSoundCheck() {
    if (!this.#engine || this.busy || this.#sc.running) return;
    if (!this.#settings.micEnabled) await this.setMicEnabled(true);
    await this.firstGesture();
    this.discardTestClip();
    this.#engine.setAutoLevel(false);
    this.#soundCheck?.cancel();
    const sc = new SoundCheck(this.#engine);
    this.#soundCheck = sc;
    if (this.#sc.clipUrl) URL.revokeObjectURL(this.#sc.clipUrl);
    this.#sc = { running: true, phase: 'countdown', remainingMs: 0, fraction: 0, instruction: '', result: null, clipUrl: null };
    sc.on('progress', p => {
      if (p.phase === 'voice' && this.#sc.phase !== 'voice') this.#recordCheckClip();
      this.#sc = { ...this.#sc, ...p, running: true };
      this.#changed();
    });
    sc.on('cancelled', () => {
      this.#scClipAbort?.abort();
      this.#sc = { ...this.#sc, running: false, phase: null };
      this.#changed();
    });
    sc.on('done', result => this.#onSoundCheckDone(result));
    sc.on('error', ({ message }) => {
      this.#scClipAbort?.abort();
      if (this.#soundCheck === sc) this.#soundCheck = null;
      this.#sc = { ...this.#sc, running: false, phase: null };
      this.#notice({ kind: 'warning', title: 'The sound check stopped', text: message });
      this.#changed();
    });
    sc.start();
    this.#changed();
  }

  cancelSoundCheck() {
    this.#soundCheck?.cancel();
    this.#soundCheck = null;
  }

  /** Record the voice phase so the verdict card can offer "Hear it back". */
  async #recordCheckClip() {
    this.#scClipAbort?.abort();
    const abort = new AbortController();
    this.#scClipAbort = abort;
    try {
      const blob = await recordClip(this.#engine.recordTrack, (CHECK_TIMING?.voiceMs || 5000) + 400, { mimeType: this.#formats.audio || undefined, signal: abort.signal });
      if (this.#scClipAbort !== abort || !blob?.size) return;
      if (this.#sc.clipUrl) URL.revokeObjectURL(this.#sc.clipUrl);
      this.#sc = { ...this.#sc, clipUrl: URL.createObjectURL(blob) };
      this.#changed();
    } catch { /* no clip: the card just hides "Hear it back" */ }
  }

  #onSoundCheckDone(result) {
    this.#soundCheck = null;
    // The check's own summary assumes it switches room-noise blocking on; the
    // session leaves that switch as the teacher set it, so describe what changed.
    const applied = result.calibration && Number.isFinite(result.recommendedGain)
      ? `Mic level set to ${Math.round(result.recommendedGain * 100)}% for your voice.${this.#settings.gate && result.gateEnabled ? ' Muting between sentences is tuned to your room.' : ''}`
      : '';
    result = { ...result, applied };
    this.#sc = { ...this.#sc, running: false, phase: null, remainingMs: 0, fraction: 1, instruction: '', result };
    if (result.calibration && Number.isFinite(result.recommendedGain)) {
      // Apply what the check found; the gate stays as the teacher set it.
      this.#engine.setGain(result.recommendedGain);
      this.#engine.setCalibration(result.calibration);
      const calibrations = { ...(this.#settings.calibrations || {}) };
      calibrations[this.#calibrationKey()] = {
        ...result.calibration, gain: result.recommendedGain, status: result.status, headline: result.headline,
        label: this.#engine.micInfo?.label || '', at: Date.now(),
      };
      this.#settings = saveSettings({ calibrations, micGain: result.recommendedGain, autoLevel: false });
    }
    this.#changed();
  }

  /** Freeze the settings the check chose and run it again to confirm. */
  lockAndRetest() {
    this.setAutoLevel(false);
    this.startSoundCheck();
  }

  dismissSoundCheck() {
    this.#scClipAbort?.abort();
    if (this.#sc.clipUrl) URL.revokeObjectURL(this.#sc.clipUrl);
    this.#sc = { running: false, phase: null, remainingMs: 0, fraction: 0, instruction: '', result: null, clipUrl: null };
    this.#changed();
  }

  /** "Copy these steps" under "How to fix this in Windows". */
  async copyFixSteps() {
    const ok = await copyText(fixStepsText(this.#sc.result));
    this.#notice(ok
      ? { kind: 'success', title: 'Steps copied', text: 'Paste them anywhere to keep them handy.', timeoutMs: 4000 }
      : { kind: 'error', title: 'Couldn’t copy', text: 'Your browser blocked the clipboard.' });
  }

  /** Copies the "fix my Windows mic settings" prompt; resolves the text. */
  async copyDesktopPrompt() {
    const text = buildDesktopFixPrompt(this.#sc.result);
    const ok = await copyText(text);
    this.#notice(ok
      ? { kind: 'success', title: 'Prompt copied', text: 'Paste it into Claude Code on this computer.', timeoutMs: 4000 }
      : { kind: 'error', title: 'Couldn’t copy', text: 'Your browser blocked the clipboard.' });
    return text;
  }

  // -------------------------------------------------------------- test clip

  async startTestClip() {
    if (!this.#engine || this.busy || this.#testClip.state === 'recording') return;
    await this.firstGesture();
    this.discardTestClip();
    const abort = new AbortController();
    const started = performance.now();
    const timer = setInterval(() => {
      this.#testClip = { ...this.#testClip, remainingMs: Math.max(0, TEST_CLIP_MS - (performance.now() - started)) };
      this.#changed();
    }, 250);
    this.#testClip = { state: 'recording', remainingMs: TEST_CLIP_MS, url: null, size: 0, abort, timer };
    this.#changed();
    try {
      const blob = await recordClip(this.#engine.recordTrack, TEST_CLIP_MS, { mimeType: this.#formats.audio || undefined, signal: abort.signal });
      clearInterval(timer);
      if (this.#testClip.abort !== abort) return;   // discarded meanwhile
      if (!blob || !blob.size) {
        this.#testClip = { state: 'idle', remainingMs: 0, url: null, size: 0, abort: null, timer: null };
        this.#notice({ kind: 'error', title: 'The test caught no sound', text: 'Check the microphone is on, then try again.' });
      } else {
        this.#testClip = { state: 'ready', remainingMs: 0, url: URL.createObjectURL(blob), size: blob.size, abort: null, timer: null };
      }
    } catch (e) {
      clearInterval(timer);
      if (this.#testClip.abort === abort) this.#testClip = { state: 'idle', remainingMs: 0, url: null, size: 0, abort: null, timer: null };
      if (e?.name !== 'AbortError') this.#notice({ kind: 'error', title: 'Test recording failed', text: e.message || String(e) });
    }
    this.#changed();
  }

  /** Stop the test early; whatever was recorded so far is kept for playback. */
  stopTestClip() {
    this.#testClip.abort?.abort();
  }

  discardTestClip() {
    const t = this.#testClip;
    if (t.timer) clearInterval(t.timer);
    if (t.url) URL.revokeObjectURL(t.url);
    const abort = t.abort;
    this.#testClip = { state: 'idle', remainingMs: 0, url: null, size: 0, abort: null, timer: null };
    abort?.abort();
    this.#changed();
  }

  // ----------------------------------------------------------------- camera

  async setCamera(on) {
    this.#settings = saveSettings({ camera: !!on });
    if (!on) {
      this.#stopCamera();
      this.#compositor?.setCameraVisible(false);
      this.#compositor?.setCameraTrack(null);
      this.#changed();
      return;
    }
    if (!isCompositingSupported()) {
      this.#camera = { ...this.#camera, status: 'error' };
      this.#notice({ kind: 'warning', title: 'Camera bubble isn’t available', text: 'This browser can’t add the camera to the video. Update Chrome or Edge to use it.' });
      this.#changed();
      return;
    }
    await this.#startCamera();
  }

  async setCameraDevice(deviceId) {
    this.#settings = saveSettings({ cameraDeviceId: deviceId });
    if (this.#settings.camera) await this.#startCamera();
  }

  async #startCamera() {
    this.#stopCamera();
    this.#camera = { ...this.#camera, status: 'starting', error: '' };
    this.#changed();
    try {
      const stream = await openCamera(this.#settings.cameraDeviceId || undefined);
      const track = stream.getVideoTracks()[0];
      track.addEventListener('ended', () => {
        if (this.#camera.stream !== stream) return;
        this.#camera = { ...this.#camera, status: 'error', stream: null };
        this.#compositor?.setCameraTrack(null);
        this.#alert('camera-lost', 'warning', 'Camera disconnected', 'The camera stopped. The recording continues without the bubble; turn the camera off and on again once it is reconnected.');
        this.#changed();
      });
      this.#camera = { ...this.#camera, status: 'live', stream, label: track.label };
      this.#clearAlert('camera-lost');
      if (this.#compositor) {
        this.#compositor.setCameraTrack(track);
        this.#compositor.setCameraVisible(true);
      } else if (this.busy) {
        this.#notice({ kind: 'info', title: 'The camera joins from your next take', text: 'This take started without the camera bubble.' });
      }
      this.#refreshDevices();
    } catch (e) {
      const code = e instanceof CaptureError ? e.code : (e?.name === 'NotAllowedError' ? 'blocked' : 'failed');
      if (code === 'cancelled') {
        this.#settings = saveSettings({ camera: false });
        this.#camera = { ...this.#camera, status: 'off', stream: null };
      } else {
        this.#camera = { ...this.#camera, status: code === 'blocked' ? 'blocked' : 'error', stream: null, error: e?.message || '' };
        this.#notice({ kind: 'error', title: code === 'blocked' ? 'Camera blocked' : 'Camera didn’t start', text: e?.message || 'Switch the camera off and on to try again.' });
      }
    }
    this.#changed();
  }

  #stopCamera() {
    const s = this.#camera.stream;
    if (s) s.getTracks().forEach(t => t.stop());
    this.#camera = { ...this.#camera, status: 'off', stream: null };
    this.#clearAlert('camera-lost');
  }

  setBubble(patch) {
    const bubble = { ...this.#settings.bubble, ...patch };
    this.#settings = saveSettings({ bubble });
    this.#compositor?.setBubble(bubble);
    this.#changed();
  }

  // ----------------------------------------------------------------- lesson

  setLessonName(name) { this.#settings = saveSettings({ lessonName: String(name ?? '').slice(0, 120) }); this.#changed(); }
  setFormat(format) { if (['auto', 'mp4', 'webm'].includes(format)) { this.#settings = saveSettings({ format }); this.#changed(); } }
  setCountdown(on) { this.#settings = saveSettings({ countdown: !!on }); this.#changed(); }
  setNotes(notes) { this.#settings = saveSettings({ notes: String(notes ?? '') }); this.#changed(); }
  /** Simple preferences: beeps, floatingControls, hidePreview, shortcuts, theme. */
  setPref(key, value) {
    if (!PREF_KEYS.includes(key)) return;
    if (key === 'theme' && !['system', 'light', 'dark'].includes(value)) return;
    this.#settings = saveSettings({ [key]: key === 'theme' ? value : !!value });
    this.#changed();
  }

  /** Settings › Reset all settings. The UI reloads the page afterwards. */
  resetSettings() {
    this.#settings = resetSettings();
    this.#changed();
  }

  async setQuality(quality) {
    if (!QUALITY_PRESETS[quality]) return;
    this.#settings = saveSettings({ quality });
    // The share was sized for the old preset; re-fit the live track.
    const track = this.#screen?.videoTrack;
    if (track && !this.busy) {
      const p = QUALITY_PRESETS[quality];
      try {
        track.contentHint = p.contentHint;
        const size = outputSize(this.#screen.nativeWidth || this.#screen.width, this.#screen.nativeHeight || this.#screen.height, p.maxHeight);
        await track.applyConstraints({ width: { max: size.width }, height: { max: size.height }, frameRate: { max: p.fps } });
        const st = track.getSettings();
        this.#screen = { ...this.#screen, width: st.width || this.#screen.width, height: st.height || this.#screen.height };
      } catch { /* keep the current size */ }
    }
    this.#changed();
  }

  // -------------------------------------------------------------- recording

  /** The big button: start (or cancel the countdown, or stop). */
  async toggleRecord(opts) {
    if (this.#phase === 'countdown') return this.cancelCountdown();
    if (this.#phase === 'recording' || this.#phase === 'paused') return this.stop();
    if (this.#phase === 'stopping') return;
    return this.record(opts);
  }

  /** Start a take: pick a screen if needed, check sound, count down, record. */
  async record({ withoutSound = false } = {}) {
    if (this.#phase) return;
    await this.firstGesture();
    if (!this.#screen && !(await this.chooseScreen())) return;
    if (this.#sc.running) this.cancelSoundCheck();
    if (this.#testClip.state === 'recording') this.discardTestClip();

    if (!withoutSound && !this.#hasSound()) {
      this.#notice({
        id: 'no-sound-source', kind: 'warning', title: 'Nothing would be heard',
        text: this.#settings.micEnabled
          ? 'The microphone isn’t working yet. Fix it in the Microphone panel, or record without sound.'
          : 'The microphone is off and the shared screen has no sound.',
        actions: [{ label: 'Record without sound', action: 'record', args: [{ withoutSound: true }] }],
      });
      return;
    }

    if (!this.#settings.countdown) return this.#startTake();
    this.#phase = 'countdown';
    this.#countdown = COUNTDOWN_FROM;
    this.#changed();
    this.#countdownTimer = setInterval(() => {
      this.#countdown -= 1;
      if (this.#countdown > 0) { this.#changed(); return; }
      clearInterval(this.#countdownTimer);
      this.#countdownTimer = null;
      this.#countdown = null;
      this.#phase = null;
      this.#startTake();
    }, 1000);
  }

  #hasSound() {
    const e = this.#engine;
    if (!e || !e.running) return false;
    const micOk = this.#settings.micEnabled && this.#mic.status === 'live';
    const sysOk = this.#settings.systemAudio && !!this.#screen?.audioTrack;
    // "Record without my voice" is a deliberate choice, not a mistake.
    return micOk || sysOk || this.#settings.noVoice;
  }

  cancelCountdown() {
    if (this.#phase !== 'countdown') return;
    clearInterval(this.#countdownTimer);
    this.#countdownTimer = null;
    this.#countdown = null;
    this.#phase = null;
    this.#changed();
  }

  async #startTake() {
    const screen = this.#screen;
    if (!screen || screen.videoTrack.readyState !== 'live') {
      this.#notice({ kind: 'error', title: 'The shared screen has gone', text: 'Choose a screen again, then press record.' });
      this.#releaseScreen();
      this.#changed();
      return;
    }
    const s = this.#settings;
    const preset = QUALITY_PRESETS[s.quality] || QUALITY_PRESETS.standard;
    const st = screen.videoTrack.getSettings();
    const { width, height } = outputSize(st.width || screen.width, st.height || screen.height, preset.maxHeight);
    const fps = preset.fps;

    // Camera bubble: composite only when the camera is live at the start.
    let videoTrack = screen.videoTrack;
    const camTrack = this.#camera.stream?.getVideoTracks()[0];
    if (s.camera && camTrack && camTrack.readyState === 'live' && isCompositingSupported()) {
      try {
        this.#compositor = new Compositor({ screenTrack: screen.videoTrack, cameraTrack: camTrack, width, height, fps, bubble: s.bubble });
        this.#compositor.on('warning', w => this.#notice({ kind: 'warning', title: 'Camera bubble', text: w.message }));
        videoTrack = this.#compositor.start();
      } catch (e) {
        this.#compositor = null;
        videoTrack = screen.videoTrack;
        this.#notice({ kind: 'warning', title: 'Recording without the camera bubble', text: e.message || String(e) });
      }
    }

    const options = recorderOptions({ format: s.format, width, height, fps, supported: this.#formats });
    if (options.note) this.#notice({ kind: 'info', title: 'Recording as WebM', text: options.note, timeoutMs: 6000 });
    const id = newId();
    const startedAt = Date.now();
    const filename = makeFilename({ lessonName: s.lessonName, date: new Date(startedAt), ext: options.ext, take: this.#nextTakeNumber(s.lessonName) });

    const begin = async sink => {
      const rec = new TakeRecorder({
        id, videoTrack, audioTrack: this.#engine.recordTrack, options, sink, journal: this.#journal,
        meta: { lessonName: s.lessonName, filename, startedAt },
      });
      await rec.start();
      return rec;
    };

    let savingTo = this.#folder?.status === 'ready' ? 'folder' : 'memory';
    let recorder;
    try {
      recorder = await begin(savingTo === 'folder' ? new FolderSink(this.#folder) : new MemorySink());
    } catch (e) {
      if (savingTo === 'folder') {
        // The folder may have lost permission; don't lose the take over it.
        this.#notice({ kind: 'warning', title: 'Couldn’t write to your folder', text: `${e.message || e}. This take will download when you stop instead.` });
        savingTo = 'memory';
        try { recorder = await begin(new MemorySink()); } catch (e2) { e = e2; recorder = null; }
      }
      if (!recorder) {
        this.#compositor?.stop();
        this.#compositor = null;
        this.#notice({ kind: 'error', title: 'Recording couldn’t start', text: e.message || String(e) });
        this.#changed();
        return;
      }
    }

    this.#recorder = recorder;
    this.#take = { id, filename, elapsedMs: 0, bytes: 0, markers: [], savingTo, startedAt, thumbnail: '', safetyCopy: !!this.#journal };
    this.#phase = 'recording';
    this.#review = null;
    this.#engine.setRecording(true);
    if (this.#monitor && this.#screen?.audioTrack && s.systemAudio) this.setMonitor(false);

    recorder.on('state', ({ state }) => {
      if (state === 'paused') this.#phase = 'paused';
      else if (state === 'recording') this.#phase = 'recording';
      this.#changed();
    });
    recorder.on('tick', ({ elapsedMs, bytes }) => {
      if (this.#take?.id !== id) return;
      this.#take = { ...this.#take, elapsedMs, bytes };
      this.#changed();
    });
    recorder.on('warning', w => {
      if (/crash protection|safety copy/i.test(w.message || '') && this.#take?.id === id) this.#take = { ...this.#take, safetyCopy: false };
      this.#notice({ kind: 'warning', title: 'Recording', text: w.message });
    });
    recorder.on('error', err => {
      this.#notice({ kind: 'error', title: err.fatal ? 'Recording stopped unexpectedly' : 'Recording problem', text: err.message });
      if (err.fatal && this.#recorder === recorder && (this.#phase === 'recording' || this.#phase === 'paused')) this.stop();
    });

    this.#startStorageWatch();
    this.#keepAwake();
    // A thumbnail for the takes list, once the first frames are in.
    setTimeout(async () => {
      if (this.#take?.id !== id) return;
      const thumb = await captureThumbnail(videoTrack);
      if (this.#take?.id === id) this.#take = { ...this.#take, thumbnail: thumb };
    }, 1500);
    this.#changed();
  }

  #nextTakeNumber(lessonName) {
    const today = new Date().toDateString();
    const same = this.#takes.filter(t => (t.lessonName || '') === (lessonName || '') && new Date(t.createdAt).toDateString() === today);
    return same.length + 1;
  }

  togglePause() {
    const r = this.#recorder;
    if (!r) return;
    if (this.#phase === 'recording') r.pause();
    else if (this.#phase === 'paused') r.resume();
  }

  addMarker(title) {
    const r = this.#recorder;
    if (!r || (this.#phase !== 'recording' && this.#phase !== 'paused')) return null;
    const m = r.addMarker(title || markerTitle(r.markers.length + 1));
    this.#take = { ...this.#take, markers: [...r.markers] };
    this.#notice({ kind: 'info', title: `${m.title} marked`, text: `at ${formatClock(m.atMs)}`, timeoutMs: 2000 });
    this.#changed();
    return m;
  }

  /** Stop and save the take. */
  async stop() {
    if (this.#phase === 'countdown') return this.cancelCountdown();
    if (this.#phase !== 'recording' && this.#phase !== 'paused') return;
    const recorder = this.#recorder;
    const take = this.#take;
    this.#phase = 'stopping';
    this.#changed();

    let result = null;
    try {
      result = await recorder.stop();
    } catch (e) {
      if (e?.code === 'empty') {
        this.#notice({ kind: 'info', title: 'That take was too short to save', text: 'Nothing had been recorded yet. Press Start recording when you’re ready.', timeoutMs: 6000 });
      } else {
        const why = String(e?.message || e).replace(/\.?$/, '.');
        this.#notice({ kind: 'error', title: 'Saving failed', text: `${why} Reload this page: your recording will be offered for recovery.` });
      }
    }
    this.#afterTake();
    if (!result) { this.#changed(); return; }

    const row = {
      id: result.id,
      lessonName: this.#settings.lessonName,
      filename: result.filename,
      container: result.container,
      mimeType: result.mimeType,
      durationMs: result.durationMs,
      size: result.size,
      createdAt: result.startedAt || take.startedAt,
      markers: result.markers || [],
      savedTo: result.savedTo === 'folder' ? 'folder' : 'download',
      folderName: result.folderName || '',
      thumbnail: take.thumbnail || '',
    };
    if (result.blob) {
      // The journal keeps this take's chunks until the next take is saved.
      this.#kept = new Set([row.id]);
      this.#urls.set(row.id, URL.createObjectURL(result.blob));
      // Nothing is lost if the tab closes: hand the file over right away.
      downloadUrl(this.#urls.get(row.id), row.filename);
    }
    try { await this.#library.add(row); } catch (e) { console.warn('library add failed', e); }
    // Folder takes play back from the saved file.
    if (!result.blob) await this.#ensureUrl(row).catch(() => {});
    if (row.savedTo === 'folder' && row.markers.length) this.saveChaptersFile(row.id, { quiet: true });
    this.#review = row.id;
    if (this.#endedBy.get(row.id) === 'share-ended') this.#releaseScreen();
    this.#notice({
      kind: 'success',
      title: 'Take saved',
      text: row.savedTo === 'folder'
        ? `${row.filename} is in your “${row.folderName}” folder.`
        : `${row.filename} is in your Downloads folder.`,
      timeoutMs: 6000,
    });
    this.#changed();
  }

  /** Stop and throw the take away (the UI confirms first). */
  async cancelTake() {
    if (this.#phase === 'countdown') return this.cancelCountdown();
    if (this.#phase !== 'recording' && this.#phase !== 'paused') return;
    const recorder = this.#recorder;
    this.#phase = 'stopping';
    this.#changed();
    try { await recorder.cancel(); } catch (e) { console.warn('cancel failed', e); }
    this.#afterTake();
    this.#notice({ kind: 'info', title: 'Take discarded', text: 'Nothing was saved.', timeoutMs: 4000 });
    this.#changed();
  }

  #afterTake() {
    this.#compositor?.stop();
    this.#compositor = null;
    this.#recorder = null;
    this.#take = null;
    this.#phase = null;
    this.#engine?.setRecording(false);
    this.#stopStorageWatch();
    this.#releaseWakeLock();
  }

  /**
   * Stop Windows from sleeping or dimming mid-lesson. Browsers drop the lock
   * while the tab is hidden, so it is re-taken when the tab is shown again
   * (the floating controls take their own lock as well).
   */
  async #keepAwake() {
    if (!navigator.wakeLock || this.#wakeLock || document.visibilityState !== 'visible') return;
    try {
      const lock = await navigator.wakeLock.request('screen');
      if (!this.busy) { lock.release().catch(() => {}); return; }
      this.#wakeLock = lock;
      lock.addEventListener('release', () => { if (this.#wakeLock === lock) this.#wakeLock = null; });
    } catch { /* not allowed right now (hidden tab, battery saver) */ }
  }

  #releaseWakeLock() {
    const lock = this.#wakeLock;
    this.#wakeLock = null;
    lock?.release().catch(() => {});
  }

  // ---------------------------------------------------------------- library

  #findTake(id) { return this.#takes.find(t => t.id === id) || null; }

  async openTake(id) {
    const t = this.#findTake(id);
    if (!t || this.busy) return;
    await this.#ensureUrl(t);
    if (!this.#urls.has(id)) {
      this.#notice({ kind: 'info', title: 'Open it from your Downloads folder', text: `${t.filename} was downloaded in an earlier session, so it can’t be played here.` });
    }
    this.#review = id;
    this.#changed();
  }

  closeReview() { this.#review = null; this.#changed(); }

  /** Make an object URL for a take from wherever its bytes still are. */
  async #ensureUrl(t) {
    if (this.#urls.has(t.id)) return;
    let blob = null;
    if (t.savedTo === 'folder') blob = await this.#folderFile(t);
    else if (this.#kept.has(t.id) && this.#journal) blob = await this.#journal.assemble(t.id).catch(() => null);
    if (blob) this.#urls.set(t.id, URL.createObjectURL(blob));
  }

  async #folderFile(t) {
    if (!this.#folder || this.#folder.status === 'unsupported') return null;
    if (this.#folder.status === 'needs-permission') {
      try { await this.#folder.reconnect(); } catch { return null; }
    }
    if (this.#folder.status !== 'ready' || (t.folderName && this.#folder.name !== t.folderName)) return null;
    try { return await this.#folder.getFile(t.filename); } catch { return null; }
  }

  async downloadTake(id) {
    const t = this.#findTake(id);
    if (!t) return;
    await this.#ensureUrl(t);
    const url = this.#urls.get(id);
    if (url) downloadUrl(url, t.filename);
    else this.#notice({ kind: 'info', title: 'File not available here', text: `Look for ${t.filename} in your Downloads folder.` });
  }

  /** Remove a take from the list, and delete its file when it lives in the folder. */
  async deleteTake(id) {
    const t = this.#findTake(id);
    if (!t) return;
    let fileNote = '';
    if (t.savedTo === 'folder' && this.#folder?.status === 'ready' && (!t.folderName || this.#folder.name === t.folderName)) {
      try {
        await this.#folder.remove(t.filename);
        await this.#folder.remove(sidecarName(t.filename, 'chapters.txt')).catch(() => {});
      } catch { fileNote = ' The file itself couldn’t be deleted; remove it from the folder yourself.'; }
    } else if (t.savedTo === 'download') {
      fileNote = ' If it was downloaded, delete it from your Downloads folder too.';
    }
    const url = this.#urls.get(id);
    if (url) { URL.revokeObjectURL(url); this.#urls.delete(id); }
    if (this.#review === id) this.#review = null;
    try { await this.#library.remove(id); } catch { /* list refreshes on next change */ }
    this.#notice({ kind: 'info', title: 'Take deleted', text: `${t.filename} was removed.${fileNote}`, timeoutMs: 6000 });
    this.#changed();
  }

  /** Rename a take (and its file when it lives in the chosen folder). */
  async renameTake(id, lessonName) {
    const t = this.#findTake(id);
    if (!t) return;
    const name = String(lessonName ?? '').trim();
    if (!name || name === t.lessonName) return;
    // Keep the original date/take stamp: "New name (2026-10-08 14.32).mp4".
    const stamp = t.filename.match(/ \([^)]*\)\.\w+$/);
    let filename = stamp ? `${safeName(name)}${stamp[0]}` : makeFilename({ lessonName: name, date: new Date(t.createdAt), ext: t.container });
    if (t.savedTo === 'folder' && this.#folder?.status === 'ready' && (!t.folderName || this.#folder.name === t.folderName)) {
      try {
        filename = await this.#folder.rename(t.filename, filename);
        if (t.markers?.length) await this.#folder.rename(sidecarName(t.filename, 'chapters.txt'), sidecarName(filename, 'chapters.txt')).catch(() => {});
      } catch (e) {
        this.#notice({ kind: 'error', title: 'Couldn’t rename the file', text: e.message || String(e) });
        return;
      }
    }
    await this.#library.update(id, { lessonName: name, filename });
    this.#notice({ kind: 'success', title: 'Renamed', text: filename, timeoutMs: 3000 });
  }

  async renameMarker(takeId, markerId, title) {
    const t = this.#findTake(takeId);
    if (!t) return;
    const markers = t.markers.map(m => (m.id === markerId ? { ...m, title: String(title ?? '').slice(0, 100) } : m));
    await this.#library.update(takeId, { markers });
  }

  async deleteMarker(takeId, markerId) {
    const t = this.#findTake(takeId);
    if (!t) return;
    await this.#library.update(takeId, { markers: t.markers.filter(m => m.id !== markerId) });
  }

  chaptersFor(takeId) {
    const t = this.#findTake(takeId);
    if (!t) return { chapters: [], text: '', issues: [], youtubeReady: false };
    return buildChapters(t.markers, t.durationMs);
  }

  async copyChapters(takeId) {
    const { text, issues } = this.chaptersFor(takeId);
    const ok = await copyText(text);
    this.#notice(ok
      ? { kind: issues.length ? 'warning' : 'success', title: 'Chapters copied', text: issues.length ? issues.join(' ') : 'Paste them into your YouTube description.', timeoutMs: 6000 }
      : { kind: 'error', title: 'Couldn’t copy', text: 'Your browser blocked the clipboard.' });
  }

  async saveChaptersFile(takeId, { quiet = false } = {}) {
    const t = this.#findTake(takeId);
    if (!t) return;
    const { text } = this.chaptersFor(takeId);
    const name = sidecarName(t.filename, 'chapters.txt');
    if (t.savedTo === 'folder' && this.#folder?.status === 'ready') {
      try {
        await this.#folder.writeText(name, text + '\n');
        if (!quiet) this.#notice({ kind: 'success', title: 'Chapters saved', text: `${name} is next to the video.`, timeoutMs: 4000 });
        return;
      } catch { /* fall back to a download */ }
    }
    downloadBlob(new Blob([text + '\n'], { type: 'text/plain' }), name);
  }

  // ----------------------------------------------------------------- folder

  async chooseFolder() {
    if (!this.#folder || !FolderStore.isSupported()) {
      this.#notice({ kind: 'info', title: 'Folder saving isn’t available', text: 'This browser saves recordings to your Downloads folder.' });
      return;
    }
    try {
      await this.#folder.choose();
      this.#notice({ kind: 'success', title: 'Folder chosen', text: `New takes save straight into “${this.#folder.name}”.`, timeoutMs: 5000 });
    } catch (e) {
      if (e?.name !== 'AbortError') this.#notice({ kind: 'error', title: 'Couldn’t use that folder', text: e.message || String(e) });
    }
    this.#changed();
  }

  async reconnectFolder() {
    try { await this.#folder?.reconnect(); } catch { /* status stays needs-permission */ }
    this.#changed();
  }

  async forgetFolder() {
    await this.#folder?.forget();
    this.#changed();
  }

  // --------------------------------------------------------------- recovery

  async #loadRecovery() {
    const pending = this.#journal ? await this.#journal.listPending().catch(() => []) : [];
    this.#recovery = pending.map(p => ({
      id: p.meta.id, lessonName: p.meta.lessonName || '', filename: p.meta.filename || '',
      elapsedMs: p.meta.elapsedMs || 0, bytes: p.bytes || 0, startedAt: p.meta.startedAt || 0, legacy: false,
    }));
    this.#legacy = await findLegacyRecording().catch(() => null);
    if (this.#legacy) {
      const m = this.#legacy.meta || {};
      this.#recovery.push({ id: 'legacy', lessonName: m.name || '', filename: '', elapsedMs: m.elapsedMs || 0, bytes: 0, startedAt: m.startTime || 0, legacy: true });
    }
  }

  /** Rebuild an unfinished recording from the crash journal and save it. */
  async recover(id) {
    const item = this.#recovery.find(r => r.id === id);
    if (!item) return;
    try {
      const blob = item.legacy ? await this.#legacy.assemble() : await this.#journal.assemble(id);
      const ext = /mp4/.test(blob.type) ? 'mp4' : 'webm';
      const base = item.filename ? item.filename.replace(/\.(mp4|webm)$/i, '') : makeFilename({ lessonName: item.lessonName, date: new Date(item.startedAt || Date.now()), ext }).replace(/\.\w+$/, '');
      const filename = `RECOVERED_${base}.${ext}`;
      let savedTo = 'download', folderName = '';
      if (this.#folder?.status === 'ready') {
        try {
          const { writable, name } = await this.#folder.createFile(filename);
          await writable.write(blob);
          await writable.close();
          savedTo = 'folder'; folderName = this.#folder.name;
          item.savedName = name;
        } catch { savedTo = 'download'; }
      }
      const rowId = item.legacy ? newId() : id;
      if (savedTo === 'download') {
        this.#urls.set(rowId, URL.createObjectURL(blob));
        downloadUrl(this.#urls.get(rowId), filename);
      }
      await this.#library.add({
        id: rowId, lessonName: item.lessonName, filename: item.savedName || filename, container: ext, mimeType: blob.type,
        durationMs: item.elapsedMs, size: blob.size, createdAt: item.startedAt || Date.now(), markers: [],
        savedTo, folderName, thumbnail: '',
      });
      if (item.legacy) await this.#legacy.discard(); else await this.#journal.discard(id);
      this.#recovery = this.#recovery.filter(r => r !== item);
      this.#notice({ kind: 'success', title: 'Recording recovered', text: savedTo === 'folder' ? `${filename} is in “${folderName}”.` : `${filename} is in your Downloads folder.` });
    } catch (e) {
      this.#notice({ kind: 'error', title: 'Recovery failed', text: e.message || String(e) });
    }
    this.#changed();
  }

  async discardRecovery(id) {
    const item = this.#recovery.find(r => r.id === id);
    if (!item) return;
    try {
      if (item.legacy) await this.#legacy.discard(); else await this.#journal.discard(id);
    } catch { /* already gone */ }
    this.#recovery = this.#recovery.filter(r => r !== item);
    this.#changed();
  }

  // ---------------------------------------------------------------- storage

  async #checkStorage() {
    const est = this.#journal ? await this.#journal.estimate().catch(() => null) : null;
    this.#storage = est;
    if (est && est.quota && est.quota - est.usage < LOW_STORAGE_BYTES) {
      this.#alert('storage-low', 'warning', 'Storage is nearly full',
        `About ${formatBytes(est.quota - est.usage)} left for the safety copy of your recording. Free up disk space before a long lesson.`);
    } else {
      this.#clearAlert('storage-low');
    }
    this.#changed();
  }

  #startStorageWatch() {
    this.#stopStorageWatch();
    this.#storageTimer = setInterval(() => this.#checkStorage(), 30_000);
  }

  #stopStorageWatch() {
    if (this.#storageTimer) clearInterval(this.#storageTimer);
    this.#storageTimer = null;
  }

  // ---------------------------------------------------------------- notices

  #notice(n) { this.emit('notice', n); }

  #alert(id, kind, title, text) {
    const prev = this.#alerts.get(id);
    if (prev && prev.title === title && prev.text === text) return;
    this.#alerts.set(id, { id, kind, title, text });
    this.#changed();
  }

  #clearAlert(id) {
    if (this.#alerts.delete(id)) this.#changed();
  }

  dismissAlert(id) { this.#clearAlert(id); }

  // --------------------------------------------------------------- snapshot

  #changed() {
    this.#snapshot = null;
    if (this.#dirty) return;
    this.#dirty = true;
    queueMicrotask(() => {
      this.#dirty = false;
      this.emit('change', this.state);
    });
  }

  #phaseName() {
    if (this.#phase) return this.#phase;
    if (this.#review) return 'review';
    return this.#screen ? 'ready' : 'setup';
  }

  #takeView(t) {
    const chapters = buildChapters(t.markers || [], t.durationMs || 0);
    const playable = this.#urls.has(t.id) || t.savedTo === 'folder' || this.#kept.has(t.id);
    return { ...t, url: this.#urls.get(t.id) || null, playable, chapters };
  }

  #checkStale(gain) {
    const cal = this.#settings.calibrations?.[this.#calibrationKey()];
    return !!cal && Number.isFinite(cal.gain) && Math.abs(gain - cal.gain) / cal.gain > 0.03;
  }

  #estimate() {
    const preset = QUALITY_PRESETS[this.#settings.quality] || QUALITY_PRESETS.standard;
    const w = this.#screen?.nativeWidth || this.#screen?.width || 1920;
    const h = this.#screen?.nativeHeight || this.#screen?.height || 1080;
    const size = outputSize(w, h, preset.maxHeight);
    const opts = recorderOptions({ format: this.#settings.format, ...size, fps: preset.fps, supported: this.#formats });
    return { bytesPerHour: bytesPerHour(opts), container: opts.container, width: size.width, height: size.height };
  }

  #buildSnapshot() {
    const s = this.#settings;
    const e = this.#engine;
    const review = this.#review ? this.#findTake(this.#review) : null;
    return Object.freeze({
      phase: this.#phaseName(),
      countdown: this.#countdown,
      audioStarted: this.#audioStarted,
      screen: this.#screen && {
        label: this.#screen.label, surface: this.#screen.surface, width: this.#screen.width, height: this.#screen.height,
        hasAudio: !!this.#screen.audioTrack, stream: this.#screen.stream,
      },
      mic: { enabled: s.micEnabled, status: s.micEnabled ? this.#mic.status : 'off', deviceId: s.micDeviceId, label: this.#mic.label, devices: this.#mic.devices },
      audio: {
        mode: s.audioMode, speakers: s.speakers, gain: e ? e.gain : s.micGain, gate: s.gate, autoLevel: s.autoLevel, monitor: this.#monitor,
        systemAudio: s.systemAudio, systemAudioLevel: s.systemAudioLevel,
        calibrated: !!s.calibrations?.[this.#calibrationKey()], calibration: s.calibrations?.[this.#calibrationKey()] || null,
        checkStale: this.#checkStale(e ? e.gain : s.micGain),
        silent: this.#silent, clipping: this.#clipping,
      },
      soundCheck: { ...this.#sc },
      micError: this.#micError,
      testClip: { state: this.#testClip.state, remainingMs: this.#testClip.remainingMs, url: this.#testClip.url, size: this.#testClip.size },
      camera: {
        enabled: s.camera, status: s.camera ? this.#camera.status : 'off', deviceId: s.cameraDeviceId, label: this.#camera.label,
        devices: this.#camera.devices, bubble: { ...s.bubble }, supported: isCompositingSupported(), previewStream: this.#camera.stream, error: this.#camera.error || '',
        inTake: !!this.#compositor,
      },
      lesson: { name: s.lessonName, format: s.format, quality: s.quality, countdown: s.countdown, notes: s.notes },
      prefs: { beeps: s.beeps, floatingControls: s.floatingControls, hidePreview: s.hidePreview, shortcuts: s.shortcuts, noVoice: s.noVoice, theme: s.theme },
      theme: s.theme,
      estimate: this.#estimate(),
      formats: { mp4: this.#formats.mp4, webm: this.#formats.webm },
      take: this.#take && { ...this.#take, markers: [...this.#take.markers], talkingWhilePaused: this.#talkingWhilePaused },
      review: review && { ...this.#takeView(review), endedBy: this.#endedBy.get(review.id) || null },
      library: this.#takes.map(t => this.#takeView(t)),
      folder: { supported: FolderStore.isSupported(), status: this.#folder ? this.#folder.status : 'unsupported', name: this.#folder?.name || '' },
      recovery: this.#recovery.map(r => ({ ...r })),
      alerts: [...this.#alerts.values()],
      storage: this.#storage,
    });
  }

  /** AnalyserNode for the optional spectrum view (Settings › Advanced › detailed meters). */
  getAnalyser() {
    try { return this.#engine?.getAnalyser() || null; } catch { return null; }
  }

  /** The AudioContext, for UI sounds such as countdown beeps. */
  get audioContext() { return this.#engine?.context || null; }

  /** Release everything (page unload). */
  async dispose() {
    this.cancelCountdown();
    this.#offDeviceChange?.();
    this.#stopStorageWatch();
    this.discardTestClip();
    this.#stopCamera();
    this.#releaseScreen();
    for (const url of this.#urls.values()) URL.revokeObjectURL(url);
    await this.#engine?.stop();
  }
}
