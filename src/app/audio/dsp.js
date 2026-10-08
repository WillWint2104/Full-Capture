// Voice and mix processing, in float, one sample at a time.
//
// This file runs inside the AudioWorklet (src/worklets/voice-processor.js
// imports it) and in node tests, so it must stay pure: no window, document
// or Web Audio objects. Keep it ASCII-only: the worklet bundle that contains
// it is base64-encoded with btoa(), which rejects other characters.

const DB_TO_NEPER = Math.LN10 / 20;
const FLOOR_DB = -100;

/** Decibels to linear amplitude. */
export const dbToAmp = db => Math.exp(db * DB_TO_NEPER);

/** Linear amplitude to decibels, never below `floorDb` (silence reads as the floor). */
export const ampToDb = (amp, floorDb = FLOOR_DB) =>
  (amp > 0 ? Math.max(floorDb, 20 * Math.log10(amp)) : floorDb);

/** Mean square to decibels (avoids a square root per call). */
const msToDb = ms => (ms > 0 ? Math.max(FLOOR_DB, 10 * Math.log10(ms)) : FLOOR_DB);

/**
 * One-pole smoothing coefficient for a time constant in ms. Use as
 * `y = target + c * (y - target)`; c = 0 means "jump straight to target".
 */
const coef = (ms, sampleRate) => (ms > 0 ? Math.exp(-1000 / (ms * sampleRate)) : 0);

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * The value below which p percent of `values` fall (p in 0..100), with linear
 * interpolation between neighbours. Non-finite entries are ignored; an empty
 * list gives NaN.
 */
export function percentile(values, p) {
  const s = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return NaN;
  const rank = (clamp(p, 0, 100) / 100) * (s.length - 1);
  const lo = Math.floor(rank), hi = Math.ceil(rank);
  return s[lo] + (s[hi] - s[lo]) * (rank - lo);
}

/** How far the expander turns the room down between phrases, in dB. */
export const EXPANDER_RANGE_DB = -18;

// Used before a sound check has measured the room: low enough that any voice
// counts as speech for metering and the leveler. The expander stays off.
const UNCALIBRATED = Object.freeze({ enabled: false, openDb: -50, closeDb: -56 });

// Below this gap between quiet speech and loud room noise, any threshold
// would either chop words or let the room through, so the expander stays off.
const MIN_GATE_GAP_DB = 8;

/**
 * Expander thresholds from a sound-check calibration
 * `{ noiseHiDb, voiceLoDb }` (95th percentile of background block RMS, 20th
 * percentile of speech block RMS; raw input dBFS).
 * open = max(noiseHi + 6, voiceLo - 6), close = open - 6.
 * Uncalibrated, or a room within 8 dB of the voice, gives enabled = false:
 * the expander fails open rather than risk cutting speech.
 * @returns {{enabled:boolean, openDb:number, closeDb:number}}
 */
export function gateThresholds(calibration) {
  const noiseHi = calibration?.noiseHiDb, voiceLo = calibration?.voiceLoDb;
  if (!Number.isFinite(noiseHi) || !Number.isFinite(voiceLo)) return { ...UNCALIBRATED };
  const openDb = Math.max(noiseHi + 6, voiceLo - 6);
  return { enabled: voiceLo - noiseHi >= MIN_GATE_GAP_DB, openDb, closeDb: openDb - 6 };
}

const MAX_LOOKAHEAD_MS = 20;
const DETECTOR_MS = 5;          // expander level detector (mean-square time constant)
const COMP_DETECTOR_MS = 5;     // compressor RMS window
const TRIM_SMOOTH_MS = 15;      // ~50 ms to settle (3 time constants)
const LEVELER_MS = 4000;
const SPEECH_LEVEL_MS = 500;    // how quickly the leveler's estimate of speech level follows
const CLIP_AMP = 0.98;

const VOICE_DEFAULTS = Object.freeze({
  gain: 1,
  gateEnabled: false, openDb: UNCALIBRATED.openDb, closeDb: UNCALIBRATED.closeDb,
  rangeDb: EXPANDER_RANGE_DB, holdMs: 250, attackMs: 2, releaseMs: 150, lookaheadMs: 5,
  compressor: Object.freeze({ thresholdDb: -20, ratio: 3, attackMs: 10, releaseMs: 150 }),
  autoLevel: false, autoLevelTargetDb: -20, autoLevelRangeDb: 6,
});

/** Copy finite numbers and booleans from `patch` over `base`, ignoring anything else. */
function mergeParams(base, patch) {
  const out = { ...base };
  for (const key of Object.keys(base)) {
    const v = patch?.[key];
    if (typeof base[key] === 'number' && Number.isFinite(v)) out[key] = v;
    else if (typeof base[key] === 'boolean' && typeof v === 'boolean') out[key] = v;
  }
  return out;
}

/**
 * Mono voice chain: raw meter and level detector on the input, smoothed trim,
 * expander with lookahead, RMS compressor (no makeup gain), optional slow
 * speech-gated leveler, and a meter on the output.
 */
export class VoiceDsp {
  constructor(sampleRate) {
    this.sr = sampleRate;
    this.p = { ...VOICE_DEFAULTS };
    this.delay = new Float32Array(Math.ceil((MAX_LOOKAHEAD_MS / 1000) * sampleRate) + 1);
    this.writeAt = 0;
    this.trim = 1;          // smoothed linear trim actually applied
    this.detMs = 0;         // detector mean square (raw input)
    this.open = true;       // start open so a take never begins muted
    this.holdLeft = 0;
    this.gateDb = 0;        // smoothed expander gain
    this.gateAmp = 1;
    this.compMs = 0;
    this.compGrDb = 0;
    this.compAmp = 1;
    this.levelerDb = 0;
    this.speechDb = null;   // leveler's running estimate of raw speech level
    this.resetMeter();
    this.setParams({});
  }

  /** Change any subset of the parameters (see VOICE_DEFAULTS). Unknown or non-finite values are ignored. */
  setParams(patch = {}) {
    const p = mergeParams(this.p, patch);
    p.compressor = mergeParams(this.p.compressor, patch.compressor);
    p.gain = clamp(p.gain, 0, 64);
    p.lookaheadMs = clamp(p.lookaheadMs, 0, MAX_LOOKAHEAD_MS);
    p.rangeDb = Math.min(0, p.rangeDb);
    p.compressor.ratio = Math.max(1, p.compressor.ratio);
    if (!p.autoLevel) { this.levelerDb = 0; this.speechDb = null; }
    this.p = p;
    this.derive();
  }

  derive() {
    const { p, sr } = this;
    this.lookahead = Math.round((p.lookaheadMs / 1000) * sr);
    this.openMs = dbToAmp(p.openDb) ** 2;
    this.closeMs = dbToAmp(Math.min(p.closeDb, p.openDb)) ** 2;
    this.holdN = Math.round((p.holdMs / 1000) * sr);
    this.detC = coef(DETECTOR_MS, sr);
    this.atkC = coef(p.attackMs, sr);
    this.relC = coef(p.releaseMs, sr);
    this.trimC = coef(TRIM_SMOOTH_MS, sr);
    this.compDetC = coef(COMP_DETECTOR_MS, sr);
    this.compAtkC = coef(p.compressor.attackMs, sr);
    this.compRelC = coef(p.compressor.releaseMs, sr);
    this.compThrMs = dbToAmp(p.compressor.thresholdDb) ** 2;
    this.compSlope = 1 - 1 / p.compressor.ratio;
    this.trimTarget = p.gain * dbToAmp(this.levelerDb);
  }

  resetMeter() {
    this.m = {
      n: 0, rawSq: 0, rawPeak: 0, clips: 0, nonZero: false,
      outSq: 0, outPeak: 0, minGr: 0, speech: false,
    };
  }

  /**
   * Process one block. `input` and `output` are equal-length Float32Arrays
   * (they may be the same array).
   */
  process(input, output) {
    const n = input.length;
    const { p, delay } = this;
    const m = this.m;
    const len = delay.length;
    const gateTargetClosed = p.gateEnabled ? p.rangeDb : 0;
    const compThrDb = p.compressor.thresholdDb;
    let speechSamples = 0, blockSq = 0;

    for (let i = 0; i < n; i++) {
      const x = input[i];
      const sq = x * x;
      const ax = Math.abs(x);

      // Raw meter: what the microphone sends, before any of our gain.
      blockSq += sq;
      if (ax > m.rawPeak) m.rawPeak = ax;
      if (ax >= CLIP_AMP) m.clips++;
      if (x !== 0) m.nonZero = true;

      // Expander detector on the undelayed input: it sees an onset
      // `lookahead` samples before the audio reaches the gain stage.
      this.detMs = sq + this.detC * (this.detMs - sq);
      if (this.detMs >= this.openMs) {
        this.open = true;
        this.holdLeft = this.holdN;
        speechSamples++;
      } else if (this.open) {
        // Hold restarts while above CLOSE, so soft word endings and pauses
        // between syllables never trigger a release.
        if (this.detMs >= this.closeMs) this.holdLeft = this.holdN;
        else if (this.holdLeft > 0) this.holdLeft--;
        else this.open = false;
      }

      const gateTarget = this.open ? 0 : gateTargetClosed;
      if (this.gateDb !== gateTarget) {
        const c = gateTarget > this.gateDb ? this.atkC : this.relC;
        this.gateDb = gateTarget + c * (this.gateDb - gateTarget);
        if (Math.abs(this.gateDb - gateTarget) < 1e-4) this.gateDb = gateTarget;
        this.gateAmp = dbToAmp(this.gateDb);
      }

      // Lookahead delay line.
      let delayed = x;
      if (this.lookahead > 0) {
        let readAt = this.writeAt - this.lookahead;
        if (readAt < 0) readAt += len;
        delayed = delay[readAt];
        delay[this.writeAt] = x;
        if (++this.writeAt === len) this.writeAt = 0;
      }

      this.trim = this.trimTarget + this.trimC * (this.trim - this.trimTarget);
      let y = delayed * this.trim * this.gateAmp;

      // RMS compressor, hard knee, no makeup gain: it only ever turns down.
      const ysq = y * y;
      this.compMs = ysq + this.compDetC * (this.compMs - ysq);
      const grTarget = this.compMs > this.compThrMs ? (compThrDb - msToDb(this.compMs)) * this.compSlope : 0;
      if (this.compGrDb !== grTarget) {
        const c = grTarget < this.compGrDb ? this.compAtkC : this.compRelC;
        this.compGrDb = grTarget + c * (this.compGrDb - grTarget);
        if (Math.abs(this.compGrDb - grTarget) < 1e-4) this.compGrDb = grTarget;
        this.compAmp = dbToAmp(this.compGrDb);
      }
      y *= this.compAmp;
      output[i] = y;

      const ay = Math.abs(y);
      m.outSq += y * y;
      if (ay > m.outPeak) m.outPeak = ay;
      if (this.compGrDb < m.minGr) m.minGr = this.compGrDb;
    }

    m.n += n;
    m.rawSq += blockSq;
    if (speechSamples > 0) m.speech = true;
    if (p.autoLevel && n > 0) this.updateLeveler(blockSq / n, speechSamples / n, n);
  }

  /**
   * Slow leveler: rides the trim toward the target speech level, within
   * +/- autoLevelRangeDb of the user's gain. It only learns from blocks that
   * are mostly speech, so pauses and room noise never pump it up.
   */
  updateLeveler(blockMs, speechShare, n) {
    if (speechShare < 0.5 || blockMs <= 0) return;
    const { p } = this;
    const blockDb = msToDb(blockMs);
    const blockSec = n / this.sr;
    this.speechDb = this.speechDb === null
      ? blockDb
      : blockDb + Math.exp(-blockSec * 1000 / SPEECH_LEVEL_MS) * (this.speechDb - blockDb);
    const want = clamp(p.autoLevelTargetDb - (this.speechDb + ampToDb(p.gain, -200)),
      -p.autoLevelRangeDb, p.autoLevelRangeDb);
    this.levelerDb = want + Math.exp(-blockSec * 1000 / LEVELER_MS) * (this.levelerDb - want);
    this.trimTarget = p.gain * dbToAmp(this.levelerDb);
  }

  /**
   * Levels since the previous call (then resets). dBFS, floor -100. Gains in
   * dB are <= 0 except levelerDb.
   */
  takeMeter() {
    const m = this.m;
    const n = m.n || 1;
    const out = {
      rawRmsDb: msToDb(m.rawSq / n),
      rawPeakDb: ampToDb(m.rawPeak),
      rawClips: m.clips,
      outRmsDb: msToDb(m.outSq / n),
      outPeakDb: ampToDb(m.outPeak),
      gateOpen: !this.p.gateEnabled || this.open,
      gateGainDb: this.gateDb,
      compGrDb: m.minGr,
      levelerDb: this.levelerDb,
      speech: m.speech,
      digitalSilence: m.n > 0 && !m.nonZero,
    };
    this.resetMeter();
    return out;
  }
}

const MIX_DEFAULTS = Object.freeze({
  systemLevel: 0.7, duckDb: -10, duckAttackMs: 50, duckReleaseMs: 400, ceilingDb: -1, lookaheadMs: 5,
});
const DUCK_KEY_DB = -45;        // voice above this (10 ms RMS) means the teacher is talking
const DUCK_KEY_MS = 10;
const DUCK_HOLD_MS = 250;       // bridges gaps between words so the music does not pump
const SYS_SMOOTH_MS = 15;
const LIMITER_RELEASE_MS = 80;

/**
 * Stereo mix of voice and computer sound: system trim, ducking keyed on the
 * voice, sum, and a lookahead peak limiter that guarantees the ceiling.
 */
export class MixDsp {
  constructor(sampleRate) {
    this.sr = sampleRate;
    this.p = { ...MIX_DEFAULTS };
    this.sysGain = this.p.systemLevel;
    this.duckDbNow = 0;
    this.duckAmp = 1;
    this.keyN = Math.max(1, Math.round((DUCK_KEY_MS / 1000) * sampleRate));
    this.keyMs = dbToAmp(DUCK_KEY_DB) ** 2;
    this.keySq = 0;
    this.keyCount = 0;
    this.duckHoldN = Math.round((DUCK_HOLD_MS / 1000) * sampleRate);
    this.duckHoldLeft = 0;
    this.sysC = coef(SYS_SMOOTH_MS, sampleRate);
    this.relC = coef(LIMITER_RELEASE_MS, sampleRate);
    this.resetMeter();
    this.setParams({});
  }

  /** Change any subset of { systemLevel, duckDb, duckAttackMs, duckReleaseMs, ceilingDb, lookaheadMs }. */
  setParams(patch = {}) {
    const p = mergeParams(this.p, patch);
    p.systemLevel = clamp(p.systemLevel, 0, 4);
    p.duckDb = Math.min(0, p.duckDb);
    p.ceilingDb = Math.min(0, p.ceilingDb);
    p.lookaheadMs = clamp(p.lookaheadMs, 0, MAX_LOOKAHEAD_MS);
    const resize = p.lookaheadMs !== this.p.lookaheadMs || !this.window;
    this.p = p;
    this.ceiling = dbToAmp(p.ceilingDb);
    this.duckAtkC = coef(p.duckAttackMs, this.sr);
    this.duckRelC = coef(p.duckReleaseMs, this.sr);
    if (resize) this.resetLimiter();
  }

  /**
   * The limiter needs the gain at sample n to be no more than the gain
   * sample n - D requires (D = lookahead). A sliding minimum over D + 1
   * samples, then a release that only rises slowly, then a moving average
   * over D + 1 samples gives exactly that, with smooth attacks.
   */
  resetLimiter() {
    const d = Math.round((this.p.lookaheadMs / 1000) * this.sr);
    const w = d + 1;
    this.d = d;
    this.window = w;
    // Exactly D samples of delay: the gain for sample n covers samples n-D..n.
    this.delayL = new Float32Array(Math.max(1, d));
    this.delayR = new Float32Array(Math.max(1, d));
    this.delayAt = 0;
    this.dqVal = new Float64Array(w + 1);
    this.dqIdx = new Float64Array(w + 1);
    this.dqHead = 0;
    this.dqSize = 0;
    this.avg = new Float64Array(w).fill(1);
    this.avgSum = w;
    this.avgAt = 0;
    this.rel = 1;
    this.count = 0;
  }

  resetMeter() {
    this.m = { n: 0, outSq: 0, outPeak: 0, sysPeak: 0, minGain: 1, ducking: false };
  }

  /** Sliding-window minimum of the gain each sample needs (monotonic deque). */
  windowMin(need) {
    const cap = this.dqVal.length;
    const idx = this.count;
    while (this.dqSize > 0) {
      const back = (this.dqHead + this.dqSize - 1) % cap;
      if (this.dqVal[back] < need) break;
      this.dqSize--;
    }
    const at = (this.dqHead + this.dqSize) % cap;
    this.dqVal[at] = need;
    this.dqIdx[at] = idx;
    this.dqSize++;
    while (this.dqIdx[this.dqHead] <= idx - this.window) {
      this.dqHead = (this.dqHead + 1) % cap;
      this.dqSize--;
    }
    return this.dqVal[this.dqHead];
  }

  /**
   * Mix one block. voiceIn is mono; sysL/sysR are the computer sound (either
   * may be null; a lone channel is used for both sides). Outputs are stereo.
   */
  process(voiceIn, sysL, sysR, outL, outR) {
    const n = outL.length;
    const m = this.m;
    const { p } = this;
    const left = sysL || sysR;
    const right = sysR || sysL;
    const duckTarget = p.duckDb;
    const w = this.window;

    for (let i = 0; i < n; i++) {
      const v = voiceIn ? voiceIn[i] : 0;

      // Voice activity on 10 ms windows keys the ducking.
      this.keySq += v * v;
      if (++this.keyCount === this.keyN) {
        if (this.keySq / this.keyN > this.keyMs) this.duckHoldLeft = this.duckHoldN;
        this.keySq = 0;
        this.keyCount = 0;
      }
      const ducked = this.duckHoldLeft > 0;
      if (ducked) this.duckHoldLeft--;
      const target = ducked ? duckTarget : 0;
      if (this.duckDbNow !== target) {
        const c = target < this.duckDbNow ? this.duckAtkC : this.duckRelC;
        this.duckDbNow = target + c * (this.duckDbNow - target);
        if (Math.abs(this.duckDbNow - target) < 1e-4) this.duckDbNow = target;
        this.duckAmp = dbToAmp(this.duckDbNow);
      }

      this.sysGain = p.systemLevel + this.sysC * (this.sysGain - p.systemLevel);
      let l = v, r = v;
      if (left) {
        const sl = left[i], sr = right[i];
        const sp = Math.max(Math.abs(sl), Math.abs(sr));
        if (sp > m.sysPeak) m.sysPeak = sp;
        const g = this.sysGain * this.duckAmp;
        l += sl * g;
        r += sr * g;
      }

      // Limiter gain for this sample, applied to the sample from D ago.
      const peak = Math.max(Math.abs(l), Math.abs(r));
      const need = peak > this.ceiling ? this.ceiling / peak : 1;
      const h = this.windowMin(need);
      this.rel = h < this.rel ? h : h + this.relC * (this.rel - h);
      this.avgSum += this.rel - this.avg[this.avgAt];
      this.avg[this.avgAt] = this.rel;
      if (++this.avgAt === w) this.avgAt = 0;
      const gain = Math.min(1, this.avgSum / w);
      this.count++;

      let dl = l, dr = r;
      if (this.d > 0) {
        dl = this.delayL[this.delayAt];
        dr = this.delayR[this.delayAt];
        this.delayL[this.delayAt] = l;
        this.delayR[this.delayAt] = r;
        if (++this.delayAt === this.d) this.delayAt = 0;
      }
      // The clamp only catches rounding error; the gain already guarantees the ceiling.
      const yl = clamp(dl * gain, -this.ceiling, this.ceiling);
      const yr = clamp(dr * gain, -this.ceiling, this.ceiling);
      outL[i] = yl;
      if (outR) outR[i] = yr;

      m.outSq += (yl * yl + yr * yr) / 2;
      const yp = Math.max(Math.abs(yl), Math.abs(yr));
      if (yp > m.outPeak) m.outPeak = yp;
      if (gain < m.minGain) m.minGain = gain;
      if (this.duckDbNow < -1) m.ducking = true;
    }
    m.n += n;

    // Re-add the moving-average sum now and then so rounding cannot drift
    // over a long lesson.
    if (this.count % this.sr < n) this.avgSum = this.avg.reduce((a, b) => a + b, 0);
  }

  /** Levels since the previous call (then resets). dBFS, floor -100; limiterGrDb <= 0. */
  takeMeter() {
    const m = this.m;
    const out = {
      outRmsDb: msToDb(m.outSq / (m.n || 1)),
      outPeakDb: ampToDb(m.outPeak),
      sysPeakDb: ampToDb(m.sysPeak),
      limiterGrDb: ampToDb(m.minGain),
      ducking: m.ducking,
    };
    this.resetMeter();
    return out;
  }
}
