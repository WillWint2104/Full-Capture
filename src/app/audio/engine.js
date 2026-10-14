// The audio engine: microphone in, one stable recording track out.
//
// mic -> [studio: 2 x high-pass] -> 'voice' worklet -> micMute -> 'mix' worklet -> record track
// system audio ------------------------------------------------> 'mix' input 1
// 'voice' -> monitorGain -> speakers/headphones ("Listen")
//
// The record track never changes while the engine lives. Device swaps, mode
// changes, unplugged headsets and muting only rewire what feeds the worklets,
// so a recording in progress carries on. All level work happens on the audio
// thread (see dsp.js); meters arrive as port messages, which keep flowing
// when the tab is hidden.
import { Emitter } from '../lib/emitter.js';
import { gateThresholds } from './dsp.js';
import VOICE_WORKLET from 'worklet:voice-processor.js';

const SAMPLE_RATE = 48000;
const METER_SECONDS = 1920 / SAMPLE_RATE;
const MIN_GAIN = 0.25;
const MAX_GAIN = 16;
const MAX_SYSTEM_LEVEL = 1.5;
const HIGHPASS_HZ = 80;
const BUTTERWORTH_Q_DB = -3.01;     // BiquadFilter Q is in dB for high-pass
const MUTE_RAMP_S = 0.015;
const RETRY_FIRST_MS = 800;
const RETRY_EVERY_MS = 5000;        // safety net in case no devicechange ever arrives
const SILENCE_ALERT_S = 1.5;
const CLIP_LATCH_S = 2;
const RESUME_WAIT_MS = 2000;

const MSG = {
  unsupported: 'This browser can’t process microphone sound. Please use the latest Google Chrome or Microsoft Edge.',
  contextFailed: 'Sound couldn’t start. Close other tabs that play or record sound, then reload the page.',
  workletFailed: 'The sound processor couldn’t load. Reload the page; if this keeps happening, update Chrome or Edge.',
  processorFailed: 'Sound processing hit a problem and restarted itself. If your voice sounds wrong, reload the page between takes.',
  // processorerror means the browser has shut the processor down for good:
  // nothing more reaches the recording until the page is reloaded.
  processorStopped: 'Sound processing stopped, so new sound isn’t being recorded. If you’re recording, click Stop & save to keep what you have, then reload the page.',
  noMicApi: 'This browser can’t use a microphone here. Please use the latest Google Chrome or Microsoft Edge.',
  blocked: 'The browser is blocking the microphone. Click the camera/microphone icon at the right of the address bar, choose “Allow”, then switch the microphone on again.',
  busy: 'The microphone is busy or not responding. Close other apps that might be using it (such as Teams or Zoom), then switch the microphone off and on again.',
  missing: 'No microphone was found. Plug in your headset or microphone, then switch the microphone on again.',
  failed: 'The microphone couldn’t start. Switch it off and on again; if that doesn’t help, reload the page.',
  unexpected: 'Something went wrong with the sound. Switch the microphone off and on again; if that doesn’t help, reload the page between takes.',
  monitorOff: 'Listening was switched off while you record with computer sound, so your voice isn’t recorded twice.',
  monitorSpeakers: 'Listening is off while you use speakers, so the sound doesn’t echo back into the microphone.',
};

/** Strip Chrome's "Default - " / "Communications - " prefixes so labels compare by device. */
const plainLabel = label => String(label || '').replace(/^(Default|Communications)\s+-\s+/i, '');
const isDefaultId = id => !id || id === 'default';
const sameId = (a, b) => a === b || (isDefaultId(a) && isDefaultId(b));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * getUserMedia audio constraints. Clean: browser noise suppression only.
 * Studio: no browser processing (our high-pass does the cleanup). Speakers:
 * echo cancellation on, so the lesson audio isn't picked up again.
 */
function micConstraints({ deviceId = 'default', mode = 'clean', speakers = false } = {}) {
  const c = {
    echoCancellation: !!speakers,
    noiseSuppression: mode !== 'studio',
    autoGainControl: false,
    channelCount: { ideal: 1 },
    sampleRate: { ideal: SAMPLE_RATE },
  };
  if (!isDefaultId(deviceId)) c.deviceId = { exact: deviceId };
  return c;
}

/** 'blocked' | 'missing' | 'busy' | 'failed' from a getUserMedia error. */
function micErrorKind(e) {
  switch (e && e.name) {
    case 'NotAllowedError': case 'SecurityError': case 'PermissionDeniedError': return 'blocked';
    case 'NotFoundError': case 'OverconstrainedError': case 'DevicesNotFoundError': return 'missing';
    case 'NotReadableError': case 'TrackStartError': case 'AbortError': return 'busy';
    default: return 'failed';
  }
}

function hasMicApi() {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
}

function stopStream(stream) {
  for (const t of stream?.getTracks() || []) { try { t.stop(); } catch { /* already stopped */ } }
}

function safeDisconnect(node) {
  try { node?.disconnect(); } catch { /* not connected */ }
}

function createContext() {
  try { return new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' }); } catch { /* rate refused */ }
  return new AudioContext({ latencyHint: 'interactive' });
}

/**
 * Microphone + system audio processing with a recording track that stays the
 * same object for the engine's whole life. Events: 'meter', 'mic', 'gain',
 * 'health', 'context', 'monitor', 'error' (see docs/ARCHITECTURE.md).
 */
export class AudioEngine extends Emitter {
  #opts = {
    deviceId: 'default', mode: 'clean', speakers: false, micEnabled: true, gain: 1,
    gate: true, autoLevel: false, calibration: null, systemAudioLevel: 0.7,
  };
  #calKey = null;          // deviceId|mode the calibration was measured with
  #ctx = null;
  #nodes = null;
  #recordTrack = null;
  #mic = null;             // { stream, track, source, requestedId, label, onEnded }
  #micStatus = 'off';
  #lost = false;
  #lastLabel = '';
  #retryTimer = null;
  #micChain = Promise.resolve();
  #sys = null;             // { track, source, onEnded }
  #pendingSysTrack = null; // set before start()
  #monitor = false;
  #recording = false;
  #lastMix = { rmsDb: -100, peakDb: -100, sysPeakDb: -100, limiterGrDb: 0, ducking: false };
  #health = { digitalSilence: false, clipping: false };
  #silentSince = null;
  #clipUntil = -Infinity;
  #onDeviceChange = null;
  #onStateChange = null;
  #started = false;
  #stopped = false;

  /**
   * Build the audio graph and open the microphone. The context may start
   * suspended until a user gesture: call resume() from the first click/key.
   * Rejects (and emits 'error') only when this browser can't process audio
   * at all; a microphone problem is reported through 'mic' instead, and the
   * engine keeps working (system audio, later retries).
   */
  async start(options = {}) {
    // After stop() the engine is spent: starting again would open a context nothing ever closes.
    if (this.#started || this.#stopped) return;
    this.#started = true;
    this.#applyOptions(options);
    if (typeof AudioContext !== 'function' || typeof AudioWorkletNode !== 'function') {
      return this.#fatal(MSG.unsupported);
    }
    let ctx;
    try { ctx = createContext(); } catch (e) {
      console.error('[audio] AudioContext failed', e);
      return this.#fatal(MSG.contextFailed);
    }
    this.#ctx = ctx;
    this.#onStateChange = () => this.emit('context', { state: ctx.state });
    ctx.addEventListener('statechange', this.#onStateChange);
    try {
      if (!ctx.audioWorklet) throw new Error('audioWorklet unavailable');
      await ctx.audioWorklet.addModule('data:application/javascript;base64,' + btoa(VOICE_WORKLET));
    } catch (e) {
      console.error('[audio] worklet load failed', e);
      await this.stop();
      return this.#fatal(MSG.workletFailed);
    }
    if (this.#stopped) return;
    try {
      this.#buildGraph();
    } catch (e) {
      // e.g. the processors didn't register: the browser's own wording is no use to a teacher.
      console.error('[audio] building the sound graph failed', e);
      await this.stop();
      return this.#fatal(MSG.workletFailed);
    }
    this.#sendVoiceParams();
    this.#sendMixParams();
    if (this.#pendingSysTrack) this.setSystemAudioTrack(this.#pendingSysTrack);
    this.#watchDevices();
    this.emit('context', { state: ctx.state });
    await this.#queueMic(() => this.#syncMic());
  }

  #fatal(message) {
    this.emit('error', { message });
    throw new Error(message);
  }

  #applyOptions(o) {
    const s = this.#opts;
    if (typeof o.deviceId === 'string') s.deviceId = o.deviceId || 'default';
    if (o.mode === 'clean' || o.mode === 'studio') s.mode = o.mode;
    for (const k of ['speakers', 'micEnabled', 'gate', 'autoLevel']) if (typeof o[k] === 'boolean') s[k] = o[k];
    if (Number.isFinite(o.gain)) s.gain = clamp(o.gain, MIN_GAIN, MAX_GAIN);
    if (Number.isFinite(o.systemAudioLevel)) s.systemAudioLevel = clamp(o.systemAudioLevel, 0, MAX_SYSTEM_LEVEL);
    if ('calibration' in o) this.#setCalibrationFor(o.calibration);
  }

  #buildGraph() {
    const ctx = this.#ctx;
    const voice = new AudioWorkletNode(ctx, 'voice', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      // The browser downmixes a stereo mic to mono for us.
      channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers',
    });
    const mix = new AudioWorkletNode(ctx, 'mix', {
      numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [2],
      channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
    });
    const highpass = [0, 1].map(() => new BiquadFilterNode(ctx, {
      type: 'highpass', frequency: HIGHPASS_HZ, Q: BUTTERWORTH_Q_DB,
    }));
    const micMute = new GainNode(ctx, { gain: this.#opts.micEnabled ? 1 : 0 });
    const monitor = new GainNode(ctx, { gain: 0 });
    const analyser = new AnalyserNode(ctx, { fftSize: 2048, smoothingTimeConstant: 0.6 });
    const dest = new MediaStreamAudioDestinationNode(ctx, { channelCount: 2 });

    highpass[0].connect(highpass[1]);
    highpass[1].connect(voice);
    voice.connect(micMute);
    micMute.connect(mix, 0, 0);
    mix.connect(dest);
    voice.connect(monitor);
    monitor.connect(ctx.destination);
    voice.connect(analyser);

    voice.port.onmessage = e => this.#guard(() => this.#onVoiceMessage(e.data));
    mix.port.onmessage = e => this.#guard(() => this.#onMixMessage(e.data));
    voice.onprocessorerror = mix.onprocessorerror = () => this.emit('error', { message: MSG.processorStopped });

    this.#nodes = { voice, mix, highpass, micMute, monitor, analyser, dest };
    this.#recordTrack = dest.stream.getAudioTracks()[0];
  }

  /** Run a handler; report instead of throwing out of an event callback. */
  #guard(fn) {
    try { fn(); } catch (e) { this.#unexpected(e); }
  }

  #unexpected(e) {
    console.error('[audio]', e);
    this.emit('error', { message: MSG.unexpected });
  }

  /** From a user gesture. Resolves true once the context is running. */
  async resume() {
    const ctx = this.#ctx;
    if (!ctx || ctx.state === 'closed') return false;
    if (ctx.state !== 'running') {
      // resume() can stay pending without a gesture; don't hang the caller.
      let timer;
      const wait = new Promise(r => { timer = setTimeout(r, RESUME_WAIT_MS); });
      try { await Promise.race([ctx.resume(), wait]); } catch { /* reported by state below */ }
      clearTimeout(timer);
    }
    return ctx.state === 'running';
  }

  get running() { return this.#ctx?.state === 'running'; }
  get context() { return this.#ctx; }
  /** The track to record. The same object for the engine's whole life. */
  get recordTrack() { return this.#recordTrack; }
  get gain() { return this.#opts.gain; }
  get monitor() { return this.#monitor; }

  /** { deviceId, label, settings } of the microphone in use, or null. */
  get micInfo() {
    const mic = this.#mic;
    if (!mic) return null;
    let settings = {};
    try { settings = mic.track.getSettings?.() || {}; } catch { /* not supported */ }
    return { deviceId: mic.requestedId, label: mic.label, settings };
  }

  // ---- Microphone ----

  /** Switch microphone ('default' follows the system default). recordTrack is untouched. */
  async setDevice(deviceId) {
    this.#opts.deviceId = deviceId || 'default';
    this.#sendVoiceParams();
    if (this.#nodes) await this.#queueMic(() => this.#syncMic());
  }

  /** 'clean' (browser noise suppression) or 'studio' (raw mic + high-pass). */
  async setMode(mode) {
    if (mode !== 'clean' && mode !== 'studio') return;
    this.#opts.mode = mode;
    this.#sendVoiceParams();
    if (this.#nodes) await this.#queueMic(() => this.#syncMic());
  }

  /** No headset: echo cancellation on, Listen off. */
  async setSpeakers(on) {
    this.#opts.speakers = !!on;
    this.#enforceMonitorRules();
    if (this.#nodes) await this.#queueMic(() => this.#syncMic());
  }

  /** Off releases the device (the browser's mic indicator goes out) and mutes. */
  async setMicEnabled(on) {
    this.#opts.micEnabled = !!on;
    if (!on) this.#rampMute(0);
    if (this.#nodes) await this.#queueMic(() => this.#syncMic());
  }

  /** Mic work runs one step at a time so overlapping requests can't race. */
  #queueMic(fn) {
    const run = this.#micChain.then(fn).catch(e => this.#unexpected(e));
    this.#micChain = run;
    return run;
  }

  /** Make the open microphone match the wanted device, mode and on/off. */
  async #syncMic() {
    if (this.#stopped || !this.#nodes) return;
    this.#cancelRetry();
    const want = this.#opts;
    if (!want.micEnabled) {
      this.#release(this.#mic);
      this.#mic = null;
      this.#lost = false;
      this.#rampMute(0);
      this.#setMicStatus('off', { deviceId: want.deviceId, label: '' });
      return;
    }
    if (!hasMicApi()) {
      this.#setMicStatus('error', { deviceId: want.deviceId, label: '', message: MSG.noMicApi });
      return;
    }
    const old = this.#mic;
    const sameDevice = old && sameId(old.requestedId, want.deviceId);
    const sameProcessing = old && old.mode === want.mode && old.speakers === want.speakers;
    if (sameDevice && sameProcessing && old.track.readyState === 'live') {
      // Nothing to change (e.g. "turn the mic on" while it is on): reopening
      // would cut a gap into a recording in progress. A quick off-then-on
      // lands here too, after setMicEnabled(false) already muted it.
      old.wanted = want.deviceId;
      this.#rampMute(1);
      return;
    }
    // New processing, or the same device again: let go first, because Chrome
    // may otherwise hand back the existing capture with the old settings
    // (a stand-in may even be the device we fall back to). A different device
    // with the same processing opens first, so the swap is seamless.
    if (old && (sameDevice || !sameProcessing)) {
      this.#release(old);
      this.#mic = null;
    }
    this.#setMicStatus('starting', { deviceId: want.deviceId, label: '' });
    let opened;
    try {
      opened = await this.#openWithFallback(want.deviceId);
    } catch (e) {
      if (this.#stopped) return;
      this.#onOpenFailed(e, want.deviceId);
      return;
    }
    if (this.#stopped || !this.#opts.micEnabled) { stopStream(opened.stream); return; }
    this.#attach(opened);
  }

  /** Try the wanted device; if it is missing, say so and use the default. */
  async #openWithFallback(deviceId, { anyError = false } = {}) {
    try {
      return { ...(await this.#open(deviceId)), requestedId: deviceId };
    } catch (e) {
      const kind = micErrorKind(e);
      if (isDefaultId(deviceId) || kind === 'blocked' || (!anyError && kind !== 'missing')) throw e;
      return { ...(await this.#open('default')), requestedId: 'default' };
    }
  }

  /** Open one device with the current processing; the result remembers which processing that was. */
  async #open(deviceId) {
    const { mode, speakers } = this.#opts;
    const audio = micConstraints({ deviceId, mode, speakers });
    const stream = await navigator.mediaDevices.getUserMedia({ audio });
    const track = stream.getAudioTracks()[0];
    if (!track) {
      stopStream(stream);
      throw Object.assign(new Error('no audio track'), { name: 'NotFoundError' });
    }
    return { stream, track, mode, speakers };
  }

  #onOpenFailed(e, deviceId) {
    const kind = micErrorKind(e);
    if (kind === 'failed') console.error('[audio] microphone failed', e);
    // A failed switch keeps the microphone that was already working, and the
    // choice goes back to it so the list shows what is really recording.
    if (this.#mic) {
      this.#opts.deviceId = this.#mic.requestedId;
      this.#sendVoiceParams();
      const name = this.#mic.label ? `“${this.#mic.label}”` : 'the previous microphone';
      this.#setMicStatus('live', {
        message: `That microphone couldn’t be used (it may be unplugged or busy in another app), so ${name} is still in use. Close other apps that use it, then choose it again.`,
      });
      return;
    }
    this.#rampMute(0);
    this.#setMicStatus(kind === 'blocked' ? 'blocked' : 'error', { deviceId, label: '', message: MSG[kind], errorKind: kind });
  }

  /** Wire a freshly opened microphone in and let go of the previous one. */
  #attach({ stream, track, requestedId, mode, speakers }) {
    const { voice, highpass } = this.#nodes;
    const source = new MediaStreamAudioSourceNode(this.#ctx, { mediaStream: stream });
    source.connect(mode === 'studio' ? highpass[0] : voice);
    const mic = {
      stream, track, source, requestedId, mode, speakers, label: track.label || '', onEnded: null,
      wanted: this.#opts.deviceId,   // differs from requestedId while on a fallback device
    };
    mic.onEnded = () => this.#guard(() => this.#onMicLost(mic));
    track.addEventListener('ended', mic.onEnded);

    const previous = this.#mic;
    this.#mic = mic;
    this.#release(previous);
    this.#lost = false;
    this.#cancelRetry();   // sound is back: nothing left to retry
    this.#rampMute(1);
    const message = this.#switchMessage(mic, previous);
    this.#lastLabel = mic.label;
    this.#setMicStatus('live', message ? { message } : {});
  }

  /** Say so whenever the microphone in use is not simply the one the teacher picked. */
  #switchMessage(mic, previous) {
    const name = mic.label ? `“${mic.label}”` : 'the default microphone';
    if (mic.requestedId !== mic.wanted) {
      return `Your chosen microphone isn’t available, so ${name} is being used instead. Plug it back in and it will switch back by itself.`;
    }
    if (previous && previous.requestedId !== previous.wanted && previous.wanted === mic.requestedId) {
      return `Your chosen microphone ${name} is back in use.`;
    }
    // Reopened after a loss or after being switched off: the system default may now be another device.
    const before = plainLabel(this.#lastLabel);
    const now = plainLabel(mic.label);
    if (!previous && before && now && before !== now) {
      return `Now using ${name} instead of “${before}”.`;
    }
    return undefined;
  }

  #release(mic) {
    if (!mic) return;
    mic.track.removeEventListener('ended', mic.onEnded);
    safeDisconnect(mic.source);
    stopStream(mic.stream);
  }

  #rampMute(value) {
    const g = this.#nodes?.micMute?.gain;
    if (!g) return;
    try {
      const t = this.#ctx.currentTime;
      g.cancelScheduledValues(t);
      g.setTargetAtTime(value, t, MUTE_RAMP_S / 3);
    } catch { g.value = value; }
  }

  #setMicStatus(status, { deviceId, label, message, errorKind } = {}) {
    this.#micStatus = status;
    if (status !== 'live') this.#silentSince = null;
    if (status !== 'live' && this.#health.digitalSilence) this.#setHealth({ digitalSilence: false });
    this.#sendVoiceParams();
    const detail = {
      status,
      deviceId: deviceId ?? this.#mic?.requestedId ?? this.#opts.deviceId,
      label: label ?? this.#mic?.label ?? '',
    };
    if (message) detail.message = message;
    if (errorKind) detail.errorKind = errorKind;   // 'blocked' | 'missing' | 'busy' | 'failed'
    this.emit('mic', detail);
  }

  // ---- Microphone loss and recovery ----

  #onMicLost(mic) {
    if (mic !== this.#mic || this.#stopped) return;
    this.#release(mic);
    this.#mic = null;
    this.#lost = true;
    this.#rampMute(0);
    this.#setMicStatus('lost', {
      deviceId: mic.requestedId,
      label: mic.label,
      message: `${mic.label ? `The microphone “${mic.label}”` : 'Your microphone'} stopped sending sound. It may have been unplugged. Reconnecting… Check the plug or cable; recording carries on and your voice comes back as soon as it reconnects.`,
    });
    this.#scheduleRetry(RETRY_FIRST_MS);
  }

  /** Look again later: reconnect a lost mic, or return from a stand-in to the chosen one. */
  #scheduleRetry(ms) {
    this.#cancelRetry();
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      this.#queueMic(() => this.#checkDevices());
    }, ms);
  }

  #cancelRetry() {
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
  }

  /** Same device first, then the default device; keep trying while lost. */
  async #recover() {
    if (!this.#lost || this.#stopped || !this.#opts.micEnabled) return;
    let opened;
    try {
      opened = await this.#openWithFallback(this.#opts.deviceId, { anyError: true });
    } catch (e) {
      if (this.#stopped) return;
      if (micErrorKind(e) === 'blocked') {
        this.#lost = false;
        this.#setMicStatus('blocked', { message: MSG.blocked, errorKind: 'blocked' });
        return;
      }
      this.#scheduleRetry(RETRY_EVERY_MS);
      return;
    }
    if (this.#stopped || !this.#lost || !this.#opts.micEnabled) { stopStream(opened.stream); return; }
    this.#attach(opened);
  }

  #watchDevices() {
    const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : null;
    if (!md?.addEventListener) return;
    this.#onDeviceChange = () => { this.#queueMic(() => this.#checkDevices()); };
    md.addEventListener('devicechange', this.#onDeviceChange);
  }

  /** On devicechange (and retries): notice a removed microphone, retry when lost, return to the chosen one. */
  async #checkDevices() {
    if (this.#stopped || !this.#opts.micEnabled) return;
    if (this.#lost) return this.#recover();
    const mic = this.#mic;
    if (!mic) return;
    let inputs = [];
    try {
      inputs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput');
    } catch { return; }
    if (mic !== this.#mic) return;
    let actualId = '';
    try { actualId = mic.track.getSettings?.().deviceId || ''; } catch { /* not supported */ }
    const gone = mic.track.readyState === 'ended'
      || (actualId && inputs.length > 0 && !inputs.some(d => d.deviceId === actualId));
    if (gone) { this.#onMicLost(mic); return; }
    const wanted = this.#opts.deviceId;
    if (mic.requestedId !== wanted && inputs.some(d => d.deviceId === wanted)) await this.#switchBack();
  }

  /**
   * Return from a stand-in to the chosen microphone once it is listed again.
   * Only the chosen device is tried. If it isn't ready yet (Windows often
   * refuses a headset for a moment after it is plugged in), the stand-in
   * keeps recording, the teacher's choice is kept, and it tries again
   * shortly. This is not the teacher's doing, so it never reports a failure.
   */
  async #switchBack() {
    const wanted = this.#opts.deviceId;
    let opened;
    try {
      opened = { ...(await this.#open(wanted)), requestedId: wanted };
    } catch (e) {
      // A stand-in lost meanwhile has already scheduled its own, sooner retry.
      if (!this.#stopped && !this.#lost && micErrorKind(e) !== 'blocked') this.#scheduleRetry(RETRY_EVERY_MS);
      return;
    }
    // If the stand-in was unplugged meanwhile, the chosen mic is just what the recovery needs.
    if (this.#stopped || !this.#opts.micEnabled || this.#opts.deviceId !== wanted) { stopStream(opened.stream); return; }
    this.#attach(opened);
  }

  // ---- Processing controls ----

  /** Input trim, 0.25..16 (up to +24 dB), smoothed on the audio thread. */
  setGain(linear) {
    if (!Number.isFinite(linear)) return;
    this.#opts.gain = clamp(linear, MIN_GAIN, MAX_GAIN);
    this.#sendVoiceParams();
    this.emit('gain', { gain: this.#opts.gain });
  }

  /** The user's room-noise switch. The expander only engages with a usable calibration. */
  setGate(on) {
    this.#opts.gate = !!on;
    this.#sendVoiceParams();
  }

  /**
   * Sound-check calibration for the current device and mode, or null. It
   * stops applying (expander off) if the device or mode changes, and applies
   * again when they change back.
   */
  setCalibration(cal) {
    this.#setCalibrationFor(cal);
    this.#sendVoiceParams();
  }

  #setCalibrationFor(cal) {
    this.#opts.calibration = cal || null;
    this.#calKey = cal ? this.#inUseKey() : null;
  }

  /**
   * `deviceId|mode` of the microphone in use. A stand-in counts as itself, so
   * the chosen mic's calibration is off while it stands in, and one measured
   * on the stand-in never carries over to the chosen mic when it returns.
   */
  #inUseKey() {
    return `${this.#mic ? this.#mic.requestedId : this.#opts.deviceId}|${this.#opts.mode}`;
  }

  /** The calibration if it was measured on the microphone and mode now in use. */
  #calibrationInUse() {
    const { calibration } = this.#opts;
    return calibration && this.#calKey === this.#inUseKey() ? calibration : null;
  }

  /** Slowly ride the trim toward a steady speaking level (+/- 6 dB). */
  setAutoLevel(on) {
    this.#opts.autoLevel = !!on;
    this.#sendVoiceParams();
  }

  #sendVoiceParams() {
    const voice = this.#nodes?.voice;
    if (!voice) return;
    const o = this.#opts;
    const th = gateThresholds(this.#calibrationInUse());
    voice.port.postMessage({
      type: 'params',
      params: {
        gain: o.gain, autoLevel: o.autoLevel,
        gateEnabled: o.gate && th.enabled, openDb: th.openDb, closeDb: th.closeDb,
      },
    });
  }

  #sendMixParams() {
    this.#nodes?.mix.port.postMessage({ type: 'params', params: { systemLevel: this.#opts.systemAudioLevel } });
  }

  // ---- Computer sound ----

  /** Mix in the shared screen's audio track (or null to stop). The track stays owned by the caller. */
  setSystemAudioTrack(track) {
    this.#detachSystem();
    this.#pendingSysTrack = null;
    if (!track) return;
    if (!this.#nodes) { this.#pendingSysTrack = track; return; }
    if (track.kind !== 'audio' || track.readyState !== 'live') return;
    try {
      const source = new MediaStreamAudioSourceNode(this.#ctx, { mediaStream: new MediaStream([track]) });
      source.connect(this.#nodes.mix, 0, 1);
      const sys = { track, source, onEnded: null };
      sys.onEnded = () => this.#guard(() => { if (this.#sys === sys) this.#detachSystem(); });
      track.addEventListener('ended', sys.onEnded);
      this.#sys = sys;
      this.#enforceMonitorRules();
    } catch (e) {
      this.#unexpected(e);
    }
  }

  #detachSystem() {
    const sys = this.#sys;
    if (!sys) return;
    sys.track.removeEventListener('ended', sys.onEnded);
    safeDisconnect(sys.source);
    this.#sys = null;
  }

  /** Computer sound relative to the voice, 0..1.5. */
  setSystemAudioLevel(v) {
    if (!Number.isFinite(v)) return;
    this.#opts.systemAudioLevel = clamp(v, 0, MAX_SYSTEM_LEVEL);
    this.#sendMixParams();
  }

  // ---- Listening and recording rules ----

  /**
   * "Listen" through headphones. Refused (returns false) with speakers (it
   * would feed back) or while recording with computer sound (it would be
   * recorded twice).
   */
  setMonitor(on) {
    if (on && (this.#opts.speakers || (this.#recording && this.#sys))) return false;
    this.#setMonitorGain(!!on);
    return true;
  }

  /** Tell the engine a take is running so it can enforce recording-time rules. */
  setRecording(on) {
    this.#recording = !!on;
    this.#enforceMonitorRules();
  }

  #enforceMonitorRules() {
    if (!this.#monitor) return;
    if (this.#opts.speakers || (this.#recording && this.#sys)) {
      this.#setMonitorGain(false);
      this.emit('monitor', { on: false, message: this.#opts.speakers ? MSG.monitorSpeakers : MSG.monitorOff });
    }
  }

  #setMonitorGain(on) {
    this.#monitor = on;
    const g = this.#nodes?.monitor.gain;
    if (!g) return;
    try { g.setTargetAtTime(on ? 1 : 0, this.#ctx.currentTime, 0.01); } catch { g.value = on ? 1 : 0; }
  }

  /** AnalyserNode on the processed voice, for the optional spectrum view. */
  getAnalyser() { return this.#nodes?.analyser || null; }

  // ---- Meters and health ----

  #onVoiceMessage(m) {
    if (!m) return;
    if (m.type === 'error') {
      console.error('[audio] voice processor', m.message);
      this.emit('error', { message: MSG.processorFailed });
      return;
    }
    if (m.type !== 'meter') return;
    this.#updateHealth(m);
    this.emit('meter', {
      raw: { rmsDb: m.rawRmsDb, peakDb: m.rawPeakDb, clips: m.rawClips },
      voice: { rmsDb: m.outRmsDb, peakDb: m.outPeakDb },
      mix: this.#lastMix,
      gateOpen: m.gateOpen, gateGainDb: m.gateGainDb, compGrDb: m.compGrDb, levelerDb: m.levelerDb,
      speech: m.speech, digitalSilence: m.digitalSilence, t: m.t,
    });
  }

  #onMixMessage(m) {
    if (!m) return;
    if (m.type === 'error') {
      console.error('[audio] mix processor', m.message);
      this.emit('error', { message: MSG.processorFailed });
      return;
    }
    if (m.type !== 'mix-meter') return;
    this.#lastMix = {
      rmsDb: m.outRmsDb, peakDb: m.outPeakDb, sysPeakDb: m.sysPeakDb,
      limiterGrDb: m.limiterGrDb, ducking: m.ducking,
    };
  }

  /** Dead-device silence (exact zeros) and clipping, timed on the audio clock. */
  #updateHealth(m) {
    let digitalSilence = false;
    if (this.#micStatus === 'live' && m.digitalSilence) {
      if (this.#silentSince === null) this.#silentSince = m.t - METER_SECONDS;
      digitalSilence = m.t - this.#silentSince >= SILENCE_ALERT_S;
    } else {
      this.#silentSince = null;
    }
    if (m.rawClips > 0) this.#clipUntil = m.t + CLIP_LATCH_S;
    const clipping = m.t < this.#clipUntil;
    if (digitalSilence !== this.#health.digitalSilence || clipping !== this.#health.clipping) {
      this.#setHealth({ digitalSilence, clipping });
    }
  }

  #setHealth(patch) {
    this.#health = { ...this.#health, ...patch };
    this.emit('health', { ...this.#health });
  }

  /** Release everything. The engine can't be started again; make a new one. */
  async stop() {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#cancelRetry();
    if (this.#onDeviceChange) navigator.mediaDevices.removeEventListener('devicechange', this.#onDeviceChange);
    this.#onDeviceChange = null;
    this.#release(this.#mic);
    this.#mic = null;
    this.#detachSystem();
    this.#pendingSysTrack = null;
    const nodes = this.#nodes;
    if (nodes) {
      nodes.voice.port.onmessage = null;
      nodes.mix.port.onmessage = null;
      for (const node of [nodes.voice, nodes.mix, ...nodes.highpass, nodes.micMute, nodes.monitor, nodes.analyser]) {
        safeDisconnect(node);
      }
    }
    this.#nodes = null;
    try { this.#recordTrack?.stop(); } catch { /* already stopped */ }
    const ctx = this.#ctx;
    if (ctx) {
      if (this.#onStateChange) ctx.removeEventListener('statechange', this.#onStateChange);
      if (ctx.state !== 'closed') { try { await ctx.close(); } catch { /* already closing */ } }
      this.emit('context', { state: 'closed' });
    }
    if (this.#micStatus !== 'off') this.#setMicStatus('off', { label: '' });
  }
}
