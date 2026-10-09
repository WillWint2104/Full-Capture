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
import { buildChapters, markerTitle, INTRO_ID } from './lib/chapters.js';
import { formatClock, formatBytes } from './lib/time.js';
import { downloadBlob, downloadUrl, captureThumbnail, copyText } from './lib/download.js';
import { detectFormats, recorderOptions, outputSize, bytesPerHour, QUALITY_PRESETS } from './media/formats.js';
import { AudioEngine } from './audio/engine.js';
import { SoundCheck, buildDesktopFixPrompt, recordClip, CHECK_TIMING } from './audio/soundcheck.js';
import { fixStepsText } from './audio/fixsteps.js';
import { pickScreen, openCamera, listDevices, onDeviceChange, CaptureError, deliveredSize } from './video/sources.js';
import { Compositor, isCompositingSupported } from './video/compositor.js';
import { TakeRecorder } from './recording/recorder.js';
import { MemorySink, FolderSink } from './recording/sinks.js';
import { Journal, findLegacyRecording } from './recording/journal.js';
import { FolderStore } from './recording/folder.js';
import { TakesLibrary } from './recording/takes.js';

const COUNTDOWN_FROM = 3;
const LOW_STORAGE_BYTES = 2 * 1024 ** 3;
const TALKING_WHILE_PAUSED_S = 5;
// Ignore a second press of Start/Stop or Pause this soon after the first
// (double clicks, a held key).
const TOGGLE_GUARD_MS = 400;
const CAMERA_WAIT_MS = 3000;     // how long Start waits for a camera that is still opening
const PREF_KEYS = ['beeps', 'floatingControls', 'hidePreview', 'shortcuts', 'theme'];
const ACTIVE_PHASES = ['starting', 'recording', 'paused', 'stopping'];

// getUserMedia failures, in the teacher's words. The blocked text matches the
// illustrated steps in the Microphone step.
const BLOCKED = { status: 'blocked', title: 'Microphone blocked', text: 'Click the icon at the left of the address bar, switch Microphone on, then click Reload.' };
const MIC_ERRORS = {
  NotAllowedError: BLOCKED,
  SecurityError: BLOCKED,
  NotFoundError: { status: 'notfound', title: 'No microphone found', text: 'Plug in your headset, then press Try again.' },
  NotReadableError: { status: 'busy', title: 'Your microphone is busy', text: 'Close Teams, Zoom or other apps using it, then press Try again.' },
  AbortError: { status: 'busy', title: 'Your microphone is busy', text: 'Close Teams, Zoom or other apps using it, then press Try again.' },
  OverconstrainedError: { status: 'notfound', title: 'Your saved microphone isn’t connected', text: 'Plug it in and press Try again, or pick another microphone.' },
};

// The engine's error kinds, mapped onto the cards above.
const MIC_ERROR_FOR_KIND = { blocked: BLOCKED, missing: MIC_ERRORS.NotFoundError, busy: MIC_ERRORS.NotReadableError };
// Exact digital silence this long means a dead or muted device, not a pause
// (some headsets and noise-cancelling apps send exact zeros between phrases).
const DEAD_MIC_ALERT_MS = 6000;

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
  #phase = null;              // explicit phases only: 'countdown' | 'starting' | 'recording' | 'paused' | 'stopping'
  #preparing = false;         // record() is checking things before the countdown (picker open, folder prompt)
  #abortStart = false;        // Stop/Cancel pressed while a take was still starting
  #lastToggle = -Infinity;
  #lastPauseToggle = -Infinity;
  #countdown = null;
  #countdownTimer = null;
  #screen = null;             // { stream, videoTrack, audioTrack, surface, label, width, height, nativeWidth, nativeHeight }
  #screenPick = null;         // the screen pick in progress; shared so a second press never opens a second picker
  #mic = { status: 'off', deviceId: 'default', label: '', devices: [] };
  #audioStarted = false;
  #silent = false;
  #clipping = false;
  #sc = { running: false, phase: null, remainingMs: 0, fraction: 0, instruction: '', result: null, clipUrl: null };
  #scClipAbort = null;
  #micError = null;           // { status, title, text } for the inline card
  #micWarning = null;         // { title, text } while a stand-in mic is in use
  #talkingSince = null;       // audio-clock time speech started while paused
  #talkingWhilePaused = false;
  #lastMeterT = null;
  #endedBy = new Map();       // take id -> 'share-ended'
  #lastSaved = null;          // id of the take saved this visit (Review says "Saved – nice work!")
  #wakeLock = null;
  #deadMicTimer = null;
  #camera = { status: 'off', stream: null, label: '', devices: [], activeId: '', error: '' };
  #cameraGen = 0;             // bumps on every camera change, so a slow open can't resurrect an old one
  #cameraOpening = null;      // the camera open in progress (Start waits a moment for it)
  #take = null;               // { id, filename, lessonName, elapsedMs, bytes, markers, savingTo, ... }
  #review = null;             // take id shown in review
  #takes = [];                // library rows
  #urls = new Map();          // take id -> object URL (this session only)
  #urlJobs = new Map();       // take id -> in-flight #ensureUrl promise
  #chapterCache = new WeakMap();
  #recovery = [];
  #recovering = new Set();
  #legacy = null;
  #kept = new Set();          // take ids whose chunks the journal keeps as a safety copy of a download
  #alerts = new Map();
  #dismissed = new Map();     // alert id -> value at dismissal (storage-low: free bytes)
  #storage = null;
  #storageTimer = null;
  #dirty = false;
  #snapshot = null;

  /** Current immutable snapshot. */
  get state() {
    if (!this.#snapshot) this.#snapshot = this.#buildSnapshot();
    return this.#snapshot;
  }

  /** True while a take is starting, recording or saving (the UI warns before closing). */
  get busy() {
    return ACTIVE_PHASES.includes(this.#phase);
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
    onDeviceChange(() => this.#refreshDevices());
    document.addEventListener('visibilitychange', () => { if (this.busy) this.#keepAwake(); });

    try { await navigator.storage?.persist?.(); } catch { /* best effort */ }

    this.#engine = new AudioEngine();
    this.#wireEngine();
    const s = this.#settings;
    // Only open the mic without asking when permission was already granted;
    // otherwise wait for the "Turn on microphone" click (no prompt on load).
    const permission = await this.#micPermission();
    const openMic = s.micEnabled && !s.noVoice && permission === 'granted';
    if (!openMic) this.#mic = { ...this.#mic, status: s.noVoice ? 'off' : permission === 'denied' ? 'blocked' : 'needs-permission' };
    if (permission === 'denied' && !s.noVoice) this.#micError = BLOCKED;
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
        if (this.#settings.noVoice) return;   // "Record without my voice" stays as chosen
        if (st.state === 'denied') this.#setMicError(BLOCKED);
        // Allowed again in the browser: open the mic, but never in the middle of a take.
        else if (st.state === 'granted' && this.#mic.status === 'blocked' && !this.busy) this.enableMic();
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
        this.#micError = null;
        if (prev === 'lost') {
          this.#notice({ kind: 'success', title: 'Microphone is back', text: m.message || `Using ${m.label || 'your microphone'}.` });
          this.#micWarning = null;
        } else {
          // The saved mic wasn't there, so the engine opened a stand-in: say so in the step.
          this.#micWarning = m.message ? { title: 'Using a different microphone', text: m.message } : null;
        }
        this.#applyCalibration();
        this.#refreshDevices();
      } else if (m.status === 'blocked' || m.status === 'error') {
        // Our own wording names the "Try again" button and matches the pictures.
        const err = MIC_ERROR_FOR_KIND[m.errorKind] || (m.status === 'blocked' ? BLOCKED : null);
        this.#micError = err || { status: 'error', title: 'The microphone didn’t start', text: m.message || 'Press Try again, or pick another microphone.' };
        this.#mic = { ...this.#mic, status: this.#micError.status };
        // The Set up view (where this error shows) is hidden during a take.
        if (this.busy) {
          this.#alert('mic-lost', 'error', 'Your microphone stopped working',
            `${this.#micError.title}. Recording continues, but without your voice until the microphone works again.`);
        }
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
      clearTimeout(this.#deadMicTimer);
      if (h.digitalSilence && this.#settings.micEnabled) {
        this.#deadMicTimer = setTimeout(() => {
          if (!this.#silent || !this.#settings.micEnabled) return;
          this.#alert('no-audio', 'error', 'No sound from your microphone',
            'The microphone is sending pure silence. Check it is not muted (headset switch or Windows sound settings), or pick another microphone.');
        }, DEAD_MIC_ALERT_MS);
      } else {
        this.#clearAlert('no-audio');
      }
      this.#changed();
    });
    e.on('context', ({ state }) => { this.#audioStarted = state === 'running'; this.#changed(); });
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
    if (this.#phase || this.#preparing) return false;
    return this.#pickScreen();
  }

  /**
   * One screen pick at a time. A pick is in progress from the moment the
   * browser's picker opens until the shared screen has been measured and
   * fitted, which goes on for a moment after the picker closes; a press of
   * Start (or Choose screen) meanwhile waits for that pick rather than
   * opening a second one whose screen would replace the first.
   */
  #pickScreen() {
    this.#screenPick ??= this.#openScreenPicker().finally(() => { this.#screenPick = null; });
    return this.#screenPick;
  }

  async #openScreenPicker() {
    const preset = QUALITY_PRESETS[this.#settings.quality] || QUALITY_PRESETS.standard;
    let picked;
    try {
      picked = await pickScreen({ preset, systemAudio: this.#settings.systemAudio });
    } catch (e) {
      const code = e instanceof CaptureError ? e.code : 'failed';
      if (code === 'cancelled') {
        this.#notice({ kind: 'info', title: 'No screen chosen', text: 'Click “Choose screen” and pick a monitor on the “Entire screen” tab.', timeoutMs: 8000 });
      } else if (code === 'blocked') {
        this.#notice({ kind: 'error', title: 'Screen capture is blocked here', text: e.message || 'Open this file directly in Chrome or Edge (not inside another app’s preview), then try again.' });
      } else {
        this.#notice({ kind: 'error', title: 'Couldn’t start screen capture', text: e.message || String(e) });
      }
      return false;
    }
    // Never swap the screen under a take that has started (or is counting down).
    if (this.#phase) {
      picked.stream.getTracks().forEach(t => t.stop());
      return false;
    }
    this.#releaseScreen();
    this.#screen = picked;
    picked.videoTrack.addEventListener('ended', () => this.#onScreenEnded(picked));
    this.#engine?.setSystemAudioTrack(this.#settings.systemAudio ? picked.audioTrack : null);
    this.#changed();
    return true;
  }

  /** "Finish – stop sharing my screen". */
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
  }

  #onScreenEnded(picked) {
    if (this.#screen !== picked) return;
    if (this.#phase === 'recording' || this.#phase === 'paused') {
      if (this.#take) this.#endedBy.set(this.#take.id, 'share-ended');
      this.stop();
      return;
    }
    if (this.#phase === 'countdown') {
      this.cancelCountdown();
      this.#notice({ kind: 'warning', title: 'Recording didn’t start', text: 'Screen sharing stopped during the countdown. Choose a screen again when you’re ready.', timeoutMs: 8000 });
    }
    if (this.#phase === 'starting') this.#abortStart = true;
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
    this.#stopCheckForChange();
    this.#micWarning = null;
    this.#settings = saveSettings({ micDeviceId: deviceId });
    await this.#engine?.setDevice(deviceId);
    this.#applyCalibration();
    this.#changed();
  }

  async setAudioMode(mode) {
    if (mode !== 'clean' && mode !== 'studio') return;
    if (this.#phase || this.#preparing) return;   // locked from Start until the take ends
    this.#stopCheckForChange();
    this.#settings = saveSettings({ audioMode: mode });
    await this.#engine?.setMode(mode);
    this.#applyCalibration();
    this.#changed();
  }

  async setSpeakers(on) {
    this.#stopCheckForChange();
    this.#settings = saveSettings({ speakers: !!on });
    await this.#engine?.setSpeakers(!!on);
    this.#changed();
  }

  /** A verdict measured on two different set-ups would be wrong. */
  #stopCheckForChange() {
    if (!this.#sc.running) return;
    this.cancelSoundCheck();
    this.#notice({ kind: 'info', title: 'Sound check stopped', text: 'You changed the microphone settings. Run Check my sound again.', timeoutMs: 6000 });
  }

  /** Mic level slider (the engine's 'gain' event saves it). */
  setGain(gain) {
    this.#engine?.setGain(gain);
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

  setSystemAudioLevel(v) {
    const level = Math.max(0, Math.min(1.5, Number(v) || 0));
    this.#settings = saveSettings({ systemAudioLevel: level });
    this.#engine?.setSystemAudioLevel(level);
    this.#changed();
  }

  /** Calibrations are stored per microphone (by its label, which survives id changes) and processing mode. */
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
    // Never during a countdown or a take: it would change the level mid-lesson.
    if (!this.#engine || this.#phase || this.#preparing || this.#sc.running) return;
    if (!this.#settings.micEnabled) await this.setMicEnabled(true);
    await this.firstGesture();
    this.#engine.setAutoLevel(false);
    this.#soundCheck?.cancel();
    const sc = new SoundCheck(this.#engine);
    this.#soundCheck = sc;
    if (this.#sc.clipUrl) URL.revokeObjectURL(this.#sc.clipUrl);
    this.#sc = { running: true, phase: 'countdown', remainingMs: 0, fraction: 0, instruction: '', result: null, clipUrl: null };
    const finished = () => {
      if (this.#soundCheck === sc) this.#soundCheck = null;
      // The check switched auto level off while measuring; put the teacher's choice back.
      this.#engine.setAutoLevel(this.#settings.autoLevel);
    };
    sc.on('progress', p => {
      if (p.phase === 'voice' && this.#sc.phase !== 'voice') this.#recordCheckClip();
      this.#sc = { ...this.#sc, ...p, running: true };
      this.#changed();
    });
    sc.on('cancelled', () => {
      finished();
      this.#dropCheckClip();
      this.#sc = { ...this.#sc, running: false, phase: null };
      this.#changed();
    });
    sc.on('done', result => { finished(); this.#onSoundCheckDone(result); });
    sc.on('error', ({ message }) => {
      finished();
      this.#dropCheckClip();
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
      const blob = await recordClip(this.#engine.recordTrack, CHECK_TIMING.voiceMs + 400, { mimeType: this.#formats.audio || undefined, signal: abort.signal });
      if (this.#scClipAbort !== abort || !blob?.size) return;
      if (this.#sc.clipUrl) URL.revokeObjectURL(this.#sc.clipUrl);
      this.#sc = { ...this.#sc, clipUrl: URL.createObjectURL(blob) };
      this.#changed();
    } catch { /* no clip: the card just hides "Hear it back" */ }
  }

  /** Stop the voice-phase clip and throw away what it caught. */
  #dropCheckClip() {
    const abort = this.#scClipAbort;
    this.#scClipAbort = null;   // before abort(): the partial clip it resolves with is not kept
    abort?.abort();
  }

  #onSoundCheckDone(result) {
    // The recommended level assumes room noise is turned down between
    // sentences (as v13 did), so a good check switches that on and says so.
    const usable = !!(result.calibration && Number.isFinite(result.recommendedGain)) && !this.busy;
    const gateOn = usable && !!result.gateEnabled;
    const applied = usable
      ? `Mic level set to ${Math.round(result.recommendedGain * 100)}% for your voice.${gateOn ? ' Room noise between sentences is turned down (Settings › Advanced).' : ''}`
      : '';
    result = { ...result, applied };
    this.#sc = { ...this.#sc, running: false, phase: null, remainingMs: 0, fraction: 1, instruction: '', result };
    if (usable) {
      this.#engine.setGain(result.recommendedGain);
      this.#engine.setCalibration(result.calibration);
      const calibrations = { ...(this.#settings.calibrations || {}) };
      calibrations[this.#calibrationKey()] = {
        ...result.calibration, gain: result.recommendedGain, status: result.status, headline: result.headline,
        label: this.#engine.micInfo?.label || '', at: Date.now(),
      };
      if (gateOn) this.#engine.setGate(true);
      this.#settings = saveSettings({ calibrations, micGain: result.recommendedGain, ...(gateOn ? { gate: true } : {}) });
    }
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

  // ----------------------------------------------------------------- camera

  async setCamera(on) {
    this.#settings = saveSettings({ camera: !!on });
    if (!on) {
      this.#cameraGen++;
      this.#stopCamera();
      this.#compositor?.setCameraVisible(false);
      this.#compositor?.setCameraTrack(null);
      this.#changed();
      return;
    }
    if (!isCompositingSupported()) {
      this.#camera = { ...this.#camera, status: 'error', error: 'This browser can’t add the camera to the video. Update Chrome or Edge to use it.' };
      this.#changed();
      return;
    }
    await this.#startCamera();
  }

  async setCameraDevice(deviceId) {
    this.#settings = saveSettings({ cameraDeviceId: deviceId });
    if (this.#settings.camera) await this.#startCamera();
  }

  #startCamera() {
    const opening = this.#openCamera().finally(() => { if (this.#cameraOpening === opening) this.#cameraOpening = null; });
    this.#cameraOpening = opening;
    return opening;
  }

  async #openCamera() {
    const gen = ++this.#cameraGen;
    // Detach the old camera from a take first, so swapping cameras isn't
    // reported as the camera stopping.
    this.#compositor?.setCameraTrack(null);
    this.#stopCamera();
    this.#camera = { ...this.#camera, status: 'starting', error: '' };
    this.#changed();
    try {
      const stream = await openCamera(this.#settings.cameraDeviceId || undefined);
      // Switched off or changed again while this one was opening: let it go.
      if (gen !== this.#cameraGen || !this.#settings.camera) {
        stream.getTracks().forEach(t => t.stop());
        return;
      }
      const track = stream.getVideoTracks()[0];
      track.addEventListener('ended', () => {
        if (this.#camera.stream !== stream) return;
        this.#camera = { ...this.#camera, status: 'error', stream: null, error: 'The camera stopped. Check it is plugged in, then press Try again.' };
        this.#compositor?.setCameraTrack(null);
        if (this.busy) {
          this.#alert('camera-lost', 'warning', 'Camera disconnected',
            'The recording carries on without the camera bubble. It comes back in your next take once the camera is reconnected.');
        }
        this.#changed();
      });
      this.#camera = { ...this.#camera, status: 'live', stream, label: track.label, activeId: track.getSettings().deviceId || '' };
      this.#clearAlert('camera-lost');
      if (this.#compositor) {
        this.#compositor.setCameraTrack(track);
        this.#compositor.setCameraVisible(true);
      } else if (this.busy) {
        this.#notice({ id: 'no-bubble', kind: 'info', title: 'The camera joins from your next take', text: 'This take started without the camera bubble.' });
      }
      this.#refreshDevices();
    } catch (e) {
      if (gen !== this.#cameraGen) return;
      const code = e instanceof CaptureError ? e.code : (e?.name === 'NotAllowedError' ? 'blocked' : 'failed');
      if (code === 'cancelled') {
        this.#settings = saveSettings({ camera: false });
        this.#camera = { ...this.#camera, status: 'off', stream: null };
      } else {
        // Shown in the camera step (with a Try again button); that step is hidden during a take.
        const text = (e?.message || 'The camera didn’t start.').replace(/switch the camera (off and )?on again/i, 'press Try again');
        this.#camera = { ...this.#camera, status: code === 'blocked' ? 'blocked' : 'error', stream: null, error: text };
        if (this.busy) this.#notice({ id: 'no-bubble', kind: 'warning', title: 'Recording without the camera bubble', text: 'Your camera didn’t start. Check it after this take (step 4).' });
      }
    }
    this.#changed();
  }

  #stopCamera() {
    const s = this.#camera.stream;
    if (s) s.getTracks().forEach(t => t.stop());
    this.#camera = { ...this.#camera, status: 'off', stream: null, activeId: '' };
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

  /** Settings › Reset all settings. Refused mid-take. The UI reloads the page afterwards. Resolves true when done. */
  resetSettings() {
    if (this.busy || this.#phase === 'countdown') return false;
    this.#settings = resetSettings();
    this.#changed();
    return true;
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
        await track.applyConstraints({ width: { max: size.width }, height: { max: size.height }, frameRate: { max: p.fps }, resizeMode: 'crop-and-scale' });
        const st = track.getSettings();
        this.#screen = { ...this.#screen, width: st.width || this.#screen.width, height: st.height || this.#screen.height };
      } catch { /* keep the current size */ }
    }
    this.#changed();
  }

  // -------------------------------------------------------------- recording

  /** Why Start can't go ahead yet, or null. One rule for the button, Alt+R and the floating controls. */
  get startBlocker() {
    if (!this.#engine) return 'Full Capture is still getting ready. Press Start again in a moment (reload the page if this stays).';
    const s = this.#settings;
    if (s.noVoice) return null;
    if (this.#mic.status === 'live' && s.micEnabled) return null;
    if (this.#mic.status === 'starting' && s.micEnabled) return 'Your microphone is still starting. Press Start again in a moment.';
    const blocked = ['blocked', 'notfound', 'busy', 'error', 'lost'].includes(this.#mic.status);
    return blocked
      ? 'Your microphone isn’t working yet. Fix it in step 2, or choose “Record without my voice” in Settings.'
      : 'Turn on your microphone first (step 2), or choose “Record without my voice” in Settings.';
  }

  /** The big button, Alt+R and the floating Start: start, cancel the countdown, or stop. */
  async toggleRecord(opts) {
    const now = performance.now();
    if (now - this.#lastToggle < TOGGLE_GUARD_MS) return;
    this.#lastToggle = now;
    if (this.#phase === 'countdown' || this.#phase === 'starting' || this.#preparing) return this.cancelCountdown();
    if (this.#phase === 'recording' || this.#phase === 'paused') return this.stop();
    if (this.#phase === 'stopping') return;
    return this.record(opts);
  }

  /**
   * Start a take: reconnect the folder and pick a screen if needed, check the
   * microphone, count down, record. Must start from a click or key press (the
   * folder prompt and the screen picker need it).
   */
  async record({ withoutSound = false } = {}) {
    if (this.#phase || this.#preparing) return;
    this.#preparing = true;
    this.#abortStart = false;
    this.#changed();
    try {
      await this.firstGesture();
      if (!withoutSound && this.startBlocker) {
        this.#notice({
          id: 'no-voice', kind: 'warning', title: 'Your microphone isn’t on', text: this.startBlocker,
          actions: [{ label: 'Record anyway', action: 'record', args: [{ withoutSound: true }] }],
        });
        return;
      }
      // Chrome asks once per visit to use the chosen folder again; this click can grant it.
      if (this.#folder?.status === 'needs-permission') {
        await this.reconnectFolder();
        if (this.#folder.status !== 'ready') {
          this.#notice({ kind: 'warning', title: `This take will go to Downloads`, text: `Your “${this.#folder.name}” folder needs permission again. Click “Reconnect” at the top before the next take.`, timeoutMs: 10000 });
        }
      }
      // A pick already under way (Choose screen, or Change) decides the screen: wait for it
      // rather than open a second picker. A pick that ends without a screen says why.
      if (this.#screenPick) await this.#screenPick;
      else if (!this.#screen) await this.#pickScreen();
      if (!this.#screen) return;
      // A camera still opening (permission prompt, slow USB camera) gets a moment to join this take.
      if (this.#cameraOpening && !this.#abortStart) await Promise.race([this.#cameraOpening, new Promise(r => setTimeout(r, CAMERA_WAIT_MS))]);
      if (this.#abortStart) {
        this.#abortStart = false;
        this.#notice({ kind: 'info', title: 'Recording cancelled', text: 'Nothing was recorded.', timeoutMs: 4000 });
        return;
      }
    } finally {
      this.#preparing = false;
      this.#changed();
    }
    if (this.#sc.running) this.cancelSoundCheck();

    if (!this.#settings.countdown) return this.#beginTake();
    this.#phase = 'countdown';
    this.#countdown = COUNTDOWN_FROM;
    this.#changed();
    this.#countdownTimer = setInterval(() => {
      this.#countdown -= 1;
      if (this.#countdown > 0) { this.#changed(); return; }
      clearInterval(this.#countdownTimer);
      this.#countdownTimer = null;
      this.#countdown = null;
      this.#beginTake();
    }, 1000);
  }

  cancelCountdown() {
    // A start still being set up (screen, camera, file) is cancelled as soon as that settles.
    if (this.#phase === 'starting' || this.#preparing) {
      if (!this.#abortStart) { this.#abortStart = true; this.#changed(); }
      return;
    }
    if (this.#phase !== 'countdown') return;
    clearInterval(this.#countdownTimer);
    this.#countdownTimer = null;
    this.#countdown = null;
    this.#phase = null;
    this.#notice({ kind: 'info', title: 'Countdown cancelled', text: 'Nothing was recorded.', timeoutMs: 3000 });
    this.#changed();
  }

  /** The 'starting' phase covers the seconds a take needs to open its file and journal. */
  async #beginTake() {
    this.#phase = 'starting';
    this.#changed();
    const ok = await this.#startTake();
    if (!ok && this.#phase === 'starting') this.#phase = null;
    this.#changed();
    // Stop/Cancel pressed while it was starting: the teacher didn't want this take.
    if (ok && this.#abortStart) {
      this.#abortStart = false;
      await this.cancelTake({ quiet: true });
      this.#notice({ kind: 'info', title: 'Recording cancelled', text: 'Nothing was saved.', timeoutMs: 4000 });
    }
  }

  async #startTake() {
    if (!this.#engine) {
      this.#notice({ kind: 'error', title: 'Full Capture is still getting ready', text: 'Wait a moment, then press Start recording. Reload the page if this stays.' });
      return false;
    }
    const screen = this.#screen;
    if (!screen || screen.videoTrack.readyState !== 'live') {
      this.#notice({ kind: 'error', title: 'The shared screen has gone', text: 'Choose a screen again, then press Start recording.' });
      this.#releaseScreen();
      return false;
    }
    if (this.#sc.running) this.cancelSoundCheck();
    const s = this.#settings;
    const lessonName = s.lessonName;
    const preset = QUALITY_PRESETS[s.quality] || QUALITY_PRESETS.standard;
    const delivered = await deliveredSize(screen);
    const { width, height } = outputSize(delivered.width, delivered.height, preset.maxHeight);
    const fps = preset.fps;

    // Camera bubble: composite only when the camera is live at the start.
    let videoTrack = screen.videoTrack;
    let compositor = null;
    const camTrack = this.#camera.stream?.getVideoTracks()[0];
    if (s.camera && camTrack && camTrack.readyState === 'live' && isCompositingSupported()) {
      try {
        compositor = new Compositor({ screenTrack: screen.videoTrack, cameraTrack: camTrack, width, height, fps, bubble: s.bubble });
        compositor.on('warning', w => {
          // A camera that was unplugged already has its own banner.
          const cam = this.#camera.stream?.getVideoTracks()[0];
          if (!cam || cam.readyState !== 'live') return;
          this.#notice({ kind: 'warning', title: 'Camera bubble', text: w.message });
        });
        videoTrack = compositor.start();
        // Published now, so a camera switched or changed while the take starts reaches it.
        this.#compositor = compositor;
      } catch (e) {
        compositor = null;
        videoTrack = screen.videoTrack;
        this.#notice({ id: 'no-bubble', kind: 'warning', title: 'Recording without the camera bubble', text: e.message || String(e) });
      }
    } else if (s.camera) {
      this.#notice({
        id: 'no-bubble', kind: 'warning', title: 'Recording without the camera bubble',
        text: this.#camera.status === 'starting' ? 'Your camera was still starting. It joins from your next take.' : 'Your camera isn’t working. Check it after this take (step 4).',
      });
    }

    const options = recorderOptions({ format: s.format, width, height, fps, supported: this.#formats });
    if (options.note) this.#notice({ kind: 'info', title: 'Recording as WebM', text: options.note, timeoutMs: 6000 });
    const id = newId();
    const startedAt = Date.now();
    const filename = makeFilename({ lessonName, date: new Date(startedAt), ext: options.ext, take: this.#nextTakeNumber(lessonName) });

    const begin = async sink => {
      const rec = new TakeRecorder({
        id, videoTrack, audioTrack: this.#engine.recordTrack, options, sink, journal: this.#journal,
        meta: { lessonName, filename, startedAt },
      });
      await rec.start();
      return rec;
    };

    let savingTo = this.#folder?.status === 'ready' ? 'folder' : 'memory';
    let recorder;
    try {
      recorder = await begin(savingTo === 'folder' ? new FolderSink(this.#folder) : new MemorySink());
    } catch (e) {
      if (savingTo === 'folder' && e?.code === 'sink') {
        // The folder may have lost permission; don't lose the take over it.
        const why = String(e.message || e).replace(/\.?$/, '.');
        this.#notice({ kind: 'warning', title: 'Couldn’t write to your folder', text: `${why} This take will download when you stop instead.` });
        savingTo = 'memory';
        try { recorder = await begin(new MemorySink()); } catch (e2) { e = e2; recorder = null; }
      }
      if (!recorder) {
        if (e?.code === 'screen-gone') this.#releaseScreen();
        if (this.#compositor === compositor) this.#compositor = null;
        compositor?.stop();
        this.#notice({ kind: 'error', title: 'Recording couldn’t start', text: e.message || String(e) });
        return false;
      }
    }

    this.#compositor = compositor;
    this.#recorder = recorder;
    this.#take = {
      id, filename, lessonName, elapsedMs: 0, bytes: 0, markers: [], savingTo: recorder.savingTo || savingTo,
      folderName: this.#folder?.name || '', startedAt, thumbnail: '', safetyCopy: !!recorder.safetyCopy, screen,
    };
    this.#phase = 'recording';
    this.#review = null;
    this.#engine.setRecording(true);

    recorder.on('state', ({ state }) => {
      if (this.#recorder !== recorder) return;
      if (state === 'paused') this.#phase = 'paused';
      else if (state === 'recording') this.#phase = 'recording';
      this.#changed();
    });
    recorder.on('tick', ({ elapsedMs, bytes }) => {
      if (this.#take?.id !== id) return;
      // The safety copy is working again once data flows (after a 'no-data' warning).
      const safetyCopy = bytes > 0 ? !!recorder.safetyCopy : this.#take.safetyCopy;
      this.#take = { ...this.#take, elapsedMs, bytes, safetyCopy };
      this.#changed();
    });
    recorder.on('warning', w => {
      if (this.#take?.id === id && ['journal-failed', 'no-journal', 'no-data'].includes(w.code)) {
        this.#take = { ...this.#take, safetyCopy: w.code === 'no-data' ? false : !!recorder.safetyCopy };
      }
      if (w.code === 'saved-elsewhere') return;   // reported with the saved take
      this.#notice({ kind: 'warning', title: 'Recording', text: w.message });
      this.#changed();
    });
    recorder.on('error', err => {
      if (err.code === 'folder-failed') {
        // Recording carries on; the take will be saved from the safety copy.
        if (this.#take?.id === id) this.#take = { ...this.#take, savingTo: 'memory' };
        this.#notice({ kind: 'warning', title: 'Couldn’t keep writing to your folder', text: err.message });
        this.#changed();
        return;
      }
      if (err.code === 'share-ended' && this.#take?.id === id) this.#endedBy.set(id, 'share-ended');
      else this.#notice({ kind: 'error', title: err.fatal ? 'Recording stopped unexpectedly' : 'Recording problem', text: err.message });
      if (err.fatal && this.#recorder === recorder && (this.#phase === 'recording' || this.#phase === 'paused')) this.stop();
    });

    this.#startStorageWatch();
    this.#keepAwake();
    // A thumbnail for the takes list, once the first frames are in.
    setTimeout(async () => {
      if (this.#take?.id !== id) return;
      const thumb = await captureThumbnail(videoTrack);
      if (this.#take?.id === id) { this.#take = { ...this.#take, thumbnail: thumb }; this.#changed(); }
    }, 1500);
    return true;
  }

  /** The take number the next take of this lesson gets ("…, take 2"). */
  #nextTakeNumber(lessonName) {
    const today = new Date().toDateString();
    const same = this.#takes.filter(t => (t.lessonName || '') === (lessonName || '') && new Date(t.createdAt).toDateString() === today);
    return same.length + 1;
  }

  togglePause() {
    const r = this.#recorder;
    if (!r) return;
    const now = performance.now();
    if (now - this.#lastPauseToggle < TOGGLE_GUARD_MS) return;
    this.#lastPauseToggle = now;
    if (this.#phase === 'recording') r.pause();
    else if (this.#phase === 'paused') r.resume();
  }

  addMarker(title) {
    const r = this.#recorder;
    if (!r || (this.#phase !== 'recording' && this.#phase !== 'paused')) return null;
    const m = r.addMarker(title || markerTitle(r.markers.length + 1));
    if (!m) return null;   // the take stopped a moment ago
    this.#take = { ...this.#take, markers: [...r.markers] };
    this.#notice({ kind: 'info', title: `${m.title} added`, text: `at ${formatClock(m.atMs)}`, timeoutMs: 2500 });
    this.#changed();
    return m;
  }

  /** Stop and save the take. The phase stays 'stopping' until the take is filed and shown. */
  async stop() {
    if (this.#phase === 'countdown' || this.#phase === 'starting') return this.cancelCountdown();
    if (this.#phase !== 'recording' && this.#phase !== 'paused') return;
    const recorder = this.#recorder;
    const take = this.#take;
    this.#phase = 'stopping';
    this.#changed();

    let result = null;
    try {
      result = await recorder.stop();
    } catch (e) {
      if (e?.code === 'empty' && this.#endedBy.get(take.id) === 'share-ended') {
        this.#notice({ kind: 'warning', title: 'Screen sharing stopped', text: 'It stopped before anything was recorded. Choose a screen, then press Start recording.' });
      } else if (e?.code === 'empty') {
        this.#notice({ kind: 'info', title: 'That take was too short to save', text: 'Nothing had been recorded yet. Press Start recording when you’re ready.', timeoutMs: 6000 });
      } else {
        this.#notice({ kind: 'error', title: 'Saving failed', text: String(e?.message || e) });
      }
    }
    this.#releaseTake();
    // A share that has ended is let go, so Set up never shows a dead screen as chosen.
    if (take?.screen?.videoTrack.readyState === 'ended' && this.#screen === take.screen) this.#releaseScreen();
    if (!result) { this.#phase = null; this.#changed(); return; }

    const row = {
      id: result.id,
      lessonName: take.lessonName,
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
    this.#lastSaved = row.id;
    if (result.endedBy === 'share-ended') this.#endedBy.set(row.id, 'share-ended');
    // Release the share only if it is still the one this take recorded.
    if (this.#endedBy.get(row.id) === 'share-ended' && this.#screen === take.screen) this.#releaseScreen();
    if (result.warning) this.#notice({ kind: 'warning', title: 'Take saved, with a problem', text: result.warning });
    else this.#notice({
      kind: 'success',
      title: 'Take saved',
      text: row.savedTo === 'folder'
        ? `${row.filename} is in your “${row.folderName}” folder.`
        : `${row.filename} is in your Downloads folder.`,
      timeoutMs: 6000,
    });
    this.#phase = null;
    this.#changed();
  }

  /** Stop and throw the take away (the UI confirms first). */
  async cancelTake({ quiet = false } = {}) {
    if (this.#phase === 'countdown' || this.#phase === 'starting') return this.cancelCountdown();
    if (this.#phase !== 'recording' && this.#phase !== 'paused') return;
    const recorder = this.#recorder;
    this.#phase = 'stopping';
    this.#changed();
    try { await recorder.cancel(); } catch (e) { console.warn('cancel failed', e); }
    this.#releaseTake();
    this.#phase = null;
    if (!quiet) this.#notice({ kind: 'info', title: 'Take discarded', text: 'Nothing was saved.', timeoutMs: 4000 });
    this.#changed();
  }

  /** Release what a take held (the phase is the caller's business). */
  #releaseTake() {
    this.#compositor?.stop();
    this.#compositor = null;
    this.#recorder = null;
    this.#take = null;
    this.#engine?.setRecording(false);
    this.#stopStorageWatch();
    this.#releaseWakeLock();
    this.#clearAlert('camera-lost');
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
    if (!t || this.busy || this.#phase) return;
    await this.#ensureUrl(t);
    if (!this.#urls.has(id)) {
      this.#notice({ kind: 'info', title: 'Open it from your Downloads folder', text: `${t.filename} was downloaded in an earlier session, so it can’t be played here.`, timeoutMs: 8000 });
    }
    this.#review = id;
    this.#changed();
  }

  closeReview() { this.#review = null; this.#changed(); }

  /** Make an object URL for a take from wherever its bytes still are (one job per take at a time). */
  #ensureUrl(t) {
    if (this.#urls.has(t.id)) return Promise.resolve();
    if (this.#urlJobs.has(t.id)) return this.#urlJobs.get(t.id);
    const job = (async () => {
      let blob = null;
      if (t.savedTo === 'folder') blob = await this.#folderFile(t);
      else if (this.#kept.has(t.id) && this.#journal) blob = await this.#journal.assemble(t.id).catch(() => null);
      if (blob) this.#setUrl(t.id, blob);
    })().finally(() => this.#urlJobs.delete(t.id));
    this.#urlJobs.set(t.id, job);
    return job;
  }

  #setUrl(id, blob) {
    const old = this.#urls.get(id);
    if (old) URL.revokeObjectURL(old);
    this.#urls.set(id, URL.createObjectURL(blob));
  }

  #dropUrl(id) {
    const url = this.#urls.get(id);
    if (url) URL.revokeObjectURL(url);
    this.#urls.delete(id);
  }

  /** The chosen folder, asking for permission again if needed (call from a click). True when usable for this take. */
  async #folderReadyFor(t) {
    if (!this.#folder || this.#folder.status === 'unsupported' || this.#folder.status === 'none') return false;
    if (this.#folder.status === 'needs-permission') {
      try { await this.#folder.reconnect(); } catch { return false; }
    }
    return this.#folder.status === 'ready' && (!t.folderName || this.#folder.name === t.folderName);
  }

  async #folderFile(t) {
    if (!(await this.#folderReadyFor(t))) return null;
    try { return await this.#folder.getFile(t.filename); } catch { return null; }
  }

  async downloadTake(id) {
    const t = this.#findTake(id);
    if (!t) return;
    await this.#ensureUrl(t);
    const url = this.#urls.get(id);
    if (url) downloadUrl(url, t.filename);
    else this.#notice({ kind: 'info', title: 'File not available here', text: `Look for ${t.filename} in your Downloads folder.`, timeoutMs: 8000 });
  }

  /** Remove a take from the list, and delete its file when it lives in the folder. */
  async deleteTake(id) {
    const t = this.#findTake(id);
    if (!t) return;
    let removed = '';
    if (t.savedTo === 'folder') {
      if (await this.#folderReadyFor(t)) {
        try {
          await this.#folder.remove(t.filename);
          await this.#folder.remove(sidecarName(t.filename, 'chapters.txt')).catch(() => {});
          removed = `${t.filename} was deleted from “${t.folderName || this.#folder.name}”.`;
        } catch { removed = `${t.filename} was removed from the list, but the file couldn’t be deleted. Remove it from the folder yourself.`; }
      } else {
        removed = `${t.filename} was removed from the list. The file is still in your “${t.folderName || 'lessons'}” folder.`;
      }
    } else {
      removed = `${t.filename} was removed from the list. Delete it from your Downloads folder too.`;
    }
    this.#dropUrl(id);
    // A downloaded take's safety copy is the whole lesson: delete it with the take.
    if (this.#kept.delete(id)) await this.#journal?.discard(id).catch(() => {});
    this.#endedBy.delete(id);
    if (this.#review === id) this.#review = null;
    try { await this.#library.remove(id); } catch { /* list refreshes on next change */ }
    this.#notice({ kind: 'info', title: 'Take deleted', text: removed, timeoutMs: 8000 });
    this.#changed();
  }

  /**
   * Rename a take. A take in the chosen folder gets its file renamed too; a
   * downloaded take keeps its file name (that file is out of our reach).
   */
  async renameTake(id, lessonName) {
    const t = this.#findTake(id);
    if (!t) return;
    const name = String(lessonName ?? '').trim();
    if (!name || name === t.lessonName) return;
    if (t.savedTo !== 'folder') {
      await this.#library.update(id, { lessonName: name });
      this.#notice({ kind: 'success', title: 'Renamed in your list', text: `The downloaded file is still called ${t.filename}.`, timeoutMs: 5000 });
      return;
    }
    if (!(await this.#folderReadyFor(t))) {
      this.#notice({ kind: 'warning', title: 'Couldn’t rename the file', text: `Reconnect your “${t.folderName || 'lessons'}” folder (top of the page), then try again.` });
      this.#changed();
      return;
    }
    // Keep the original date/take stamp: "New name (2026-10-08 14.32).mp4".
    const stamp = t.filename.match(/ \([^)]*\)\.\w+$/);
    let filename = stamp ? `${safeName(name)}${stamp[0]}` : makeFilename({ lessonName: name, date: new Date(t.createdAt), ext: t.container });
    try {
      filename = await this.#folder.rename(t.filename, filename);
      if (t.markers?.length) await this.#folder.rename(sidecarName(t.filename, 'chapters.txt'), sidecarName(filename, 'chapters.txt')).catch(() => {});
    } catch (e) {
      this.#notice({ kind: 'error', title: 'Couldn’t rename the file', text: e.message || String(e) });
      return;
    }
    // The old object URL points at the file's old path, which no longer reads.
    this.#dropUrl(id);
    await this.#library.update(id, { lessonName: name, filename });
    await this.#ensureUrl({ ...t, filename }).catch(() => {});
    this.#notice({ kind: 'success', title: 'Renamed', text: filename, timeoutMs: 3000 });
    this.#changed();
  }

  async renameMarker(takeId, markerId, title) {
    const t = this.#findTake(takeId);
    if (!t) return;
    const clean = String(title ?? '').slice(0, 100);
    if (markerId === INTRO_ID) { await this.#library.update(takeId, { introTitle: clean }); return; }
    const markers = t.markers.map(m => (m.id === markerId ? { ...m, title: clean } : m));
    await this.#library.update(takeId, { markers });
  }

  async deleteMarker(takeId, markerId) {
    const t = this.#findTake(takeId);
    if (!t || markerId === INTRO_ID) return;
    await this.#library.update(takeId, { markers: t.markers.filter(m => m.id !== markerId) });
  }

  #chaptersOf(t) {
    let c = this.#chapterCache.get(t);
    if (!c) {
      c = buildChapters(t.markers || [], t.durationMs || 0, { introTitle: t.introTitle });
      this.#chapterCache.set(t, c);
    }
    return c;
  }

  chaptersFor(takeId) {
    const t = this.#findTake(takeId);
    return t ? this.#chaptersOf(t) : { chapters: [], text: '', issues: [], youtubeReady: false };
  }

  async copyChapters(takeId) {
    const t = this.#findTake(takeId);
    if (!t?.markers?.length) return;
    const { text, issues } = this.#chaptersOf(t);
    const ok = await copyText(text);
    this.#notice(ok
      ? { kind: issues.length ? 'warning' : 'success', title: 'Chapters copied', text: issues.length ? issues.join(' ') : 'Paste them into your YouTube description.', timeoutMs: 8000 }
      : { kind: 'error', title: 'Couldn’t copy', text: 'Your browser blocked the clipboard.' });
  }

  async saveChaptersFile(takeId, { quiet = false } = {}) {
    const t = this.#findTake(takeId);
    if (!t?.markers?.length) return;
    const { text } = this.#chaptersOf(t);
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
      elapsedMs: p.meta.elapsedMs || 0, bytes: p.bytes || 0, startedAt: p.meta.startedAt || 0, legacy: false, markers: p.meta.markers || [],
    }));
    this.#legacy = await findLegacyRecording().catch(() => null);
    if (this.#legacy) {
      const m = this.#legacy.meta || {};
      this.#recovery.push({ id: 'legacy', lessonName: m.name || '', filename: '', elapsedMs: m.elapsedMs || 0, bytes: this.#legacy.bytes || 0, startedAt: m.startTime || 0, legacy: true, markers: [] });
    }
  }

  /** Rebuild an unfinished recording from the crash journal and save it. */
  async recover(id) {
    const item = this.#recovery.find(r => r.id === id);
    if (!item || this.#recovering.has(id) || this.busy) return;
    this.#recovering.add(id);
    this.#changed();
    try {
      const { blob, durationMs } = item.legacy ? await this.#legacy.assembleInfo() : await this.#journal.assembleInfo(id);
      const ext = /mp4/.test(blob.type) ? 'mp4' : 'webm';
      const base = item.filename ? item.filename.replace(/\.(mp4|webm)$/i, '') : makeFilename({ lessonName: item.lessonName, date: new Date(item.startedAt || Date.now()), ext }).replace(/\.\w+$/, '');
      const filename = `RECOVERED_${base}.${ext}`;
      let savedTo = 'download', folderName = '', savedName = filename;
      if (this.#folder?.status === 'ready') {
        let created = null;
        try {
          created = await this.#folder.createFile(filename);
          await created.writable.write(blob);
          await created.writable.close();
          savedTo = 'folder'; folderName = this.#folder.name; savedName = created.name;
        } catch {
          // Leave no half-written file behind; fall back to a download.
          savedTo = 'download';
          if (created) {
            await created.writable.abort?.().catch(() => {});
            await this.#folder.remove(created.name).catch(() => {});
          }
        }
      }
      const rowId = item.legacy ? newId() : id;
      if (savedTo === 'download') {
        this.#setUrl(rowId, blob);
        downloadUrl(this.#urls.get(rowId), filename);
      }
      await this.#library.add({
        id: rowId, lessonName: item.lessonName, filename: savedName, container: ext, mimeType: blob.type,
        durationMs: durationMs || item.elapsedMs, size: blob.size, createdAt: item.startedAt || Date.now(), markers: item.markers || [],
        savedTo, folderName, thumbnail: '',
      });
      if (item.legacy) await this.#legacy.discard();
      else if (savedTo === 'download') {
        // A download can't be confirmed: keep the chunks as a safety copy, like a normal take.
        await this.#journal.complete(id, { keep: true });
        this.#kept.add(rowId);
      } else await this.#journal.discard(id);
      this.#recovery = this.#recovery.filter(r => r !== item);
      this.#notice({ kind: 'success', title: 'Recording recovered', text: savedTo === 'folder' ? `${savedName} is in “${folderName}”.` : `${savedName} is in your Downloads folder.` });
    } catch (e) {
      this.#notice({ kind: 'error', title: 'Recovery failed', text: e.message || String(e) });
    } finally {
      this.#recovering.delete(id);
    }
    this.#changed();
  }

  async discardRecovery(id) {
    const item = this.#recovery.find(r => r.id === id);
    if (!item || this.#recovering.has(id)) return;
    this.#recovering.add(id);
    try {
      if (item.legacy) await this.#legacy.discard(); else await this.#journal.discard(id);
    } catch { /* already gone */ }
    this.#recovering.delete(id);
    this.#recovery = this.#recovery.filter(r => r !== item);
    this.#changed();
  }

  // ---------------------------------------------------------------- storage

  async #checkStorage() {
    const est = this.#journal ? await this.#journal.estimate().catch(() => null) : null;
    this.#storage = est;
    const free = est && est.quota ? est.quota - est.usage : Infinity;
    // A dismissed warning comes back only if space has got meaningfully tighter.
    const dismissedAt = this.#dismissed.get('storage-low');
    const tighter = dismissedAt == null || free < Math.min(dismissedAt / 2, 1024 ** 3);
    if (free < LOW_STORAGE_BYTES && tighter) {
      this.#alert('storage-low', 'warning', 'Storage is nearly full',
        `About ${formatBytes(free)} left for the safety copy of your recording. Free up disk space before a long lesson.`);
    } else if (free >= LOW_STORAGE_BYTES) {
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

  dismissAlert(id) {
    if (id === 'storage-low' && this.#storage?.quota) this.#dismissed.set(id, this.#storage.quota - this.#storage.usage);
    this.#clearAlert(id);
  }

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
    const chapters = this.#chaptersOf(t);
    const playable = this.#urls.has(t.id) || t.savedTo === 'folder' || this.#kept.has(t.id);
    // The chapter list shows exactly what YouTube gets (an added "Intro" included).
    const chapterCount = t.markers?.length ? chapters.chapters.length : 0;
    return { ...t, url: this.#urls.get(t.id) || null, playable, chapters, chapterCount };
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
    const take = this.#take && { ...this.#take, markers: [...this.#take.markers], talkingWhilePaused: this.#talkingWhilePaused, camera: !!this.#compositor?.showsCamera };
    if (take) delete take.screen;
    return Object.freeze({
      phase: this.#phaseName(),
      ready: !!this.#engine,
      preparing: this.#preparing,
      cancelling: this.#abortStart && (this.#phase === 'starting' || this.#preparing),
      countdown: this.#countdown,
      screen: this.#screen && {
        label: this.#screen.label, surface: this.#screen.surface, width: this.#screen.width, height: this.#screen.height,
        hasAudio: !!this.#screen.audioTrack, stream: this.#screen.stream,
      },
      mic: { enabled: s.micEnabled, status: s.micEnabled ? this.#mic.status : 'off', deviceId: s.micDeviceId, label: this.#mic.label, devices: this.#mic.devices },
      micError: this.#micError,
      micWarning: this.#micWarning,
      startBlocker: this.startBlocker,
      audio: {
        mode: s.audioMode, speakers: s.speakers, gain: e ? e.gain : s.micGain, gate: s.gate, autoLevel: s.autoLevel,
        systemAudio: s.systemAudio, systemAudioLevel: s.systemAudioLevel,
        calibrated: !!s.calibrations?.[this.#calibrationKey()], calibration: s.calibrations?.[this.#calibrationKey()] || null,
        checkStale: this.#checkStale(e ? e.gain : s.micGain),
        clipping: this.#clipping,
      },
      soundCheck: { ...this.#sc },
      camera: {
        enabled: s.camera, status: s.camera ? this.#camera.status : 'off', deviceId: this.#camera.activeId || s.cameraDeviceId, label: this.#camera.label,
        devices: this.#camera.devices, bubble: { ...s.bubble }, supported: isCompositingSupported(), previewStream: this.#camera.stream, error: this.#camera.error || '',
      },
      lesson: { name: s.lessonName, format: s.format, quality: s.quality, countdown: s.countdown, notes: s.notes, nextTake: this.#nextTakeNumber(s.lessonName) },
      prefs: { beeps: s.beeps, floatingControls: s.floatingControls, hidePreview: s.hidePreview, shortcuts: s.shortcuts, noVoice: s.noVoice, theme: s.theme },
      estimate: this.#estimate(),
      formats: { mp4: this.#formats.mp4, webm: this.#formats.webm },
      take,
      review: review && { ...this.#takeView(review), endedBy: this.#endedBy.get(review.id) || null, justSaved: review.id === this.#lastSaved },
      library: this.#takes.map(t => this.#takeView(t)),
      folder: { supported: FolderStore.isSupported(), status: this.#folder ? this.#folder.status : 'unsupported', name: this.#folder?.name || '' },
      recovery: this.#recovery.map(r => ({ ...r, busy: this.#recovering.has(r.id) })),
      alerts: [...this.#alerts.values()],
    });
  }

  /** AnalyserNode for the optional spectrum view (Settings › Advanced › detailed meters). */
  getAnalyser() {
    try { return this.#engine?.getAnalyser() || null; } catch { return null; }
  }

  /** The AudioContext, for UI sounds such as countdown beeps. */
  get audioContext() { return this.#engine?.context || null; }
}
