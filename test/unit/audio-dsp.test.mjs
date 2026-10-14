import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dbToAmp, ampToDb, percentile, gateThresholds, VoiceDsp, MixDsp, EXPANDER_RANGE_DB,
} from '../../src/app/audio/dsp.js';

const SR = 48000;
const BLOCK = 128;
const WINDOW = 1920;
const LOOKAHEAD = 240;   // 5 ms at 48 kHz

/** Sine whose RMS is `db` dBFS (or whose peak is `amp` when given). */
function sine({ db, amp, freq = 997, seconds = 1, samples, phase = 0 }) {
  const n = samples ?? Math.round(seconds * SR);
  const a = amp ?? dbToAmp(db) * Math.SQRT2;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = a * Math.sin(phase + (2 * Math.PI * freq * i) / SR);
  return out;
}
const silence = seconds => new Float32Array(Math.round(seconds * SR));
function concat(...parts) {
  const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
const rmsDb = (x, from = 0, to = x.length) => {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return ampToDb(Math.sqrt(s / (to - from)));
};
const near = (actual, expected, tol, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg ?? ''} expected ${expected} ±${tol}, got ${actual}`);

/** Run a VoiceDsp over a signal in 128-sample blocks, collecting a meter every 1920 samples. */
function runVoice(dsp, input) {
  const out = new Float32Array(input.length);
  const meters = [];
  let frames = 0;
  for (let i = 0; i < input.length; i += BLOCK) {
    const end = Math.min(input.length, i + BLOCK);
    dsp.process(input.subarray(i, end), out.subarray(i, end));
    frames += end - i;
    if (frames >= WINDOW) { frames -= WINDOW; meters.push(dsp.takeMeter()); }
  }
  return { out, meters, last: meters[meters.length - 1] };
}

function runMix(dsp, voice, sysL = null, sysR = null) {
  const n = (voice || sysL).length;
  const outL = new Float32Array(n), outR = new Float32Array(n);
  const meters = [];
  let frames = 0;
  for (let i = 0; i < n; i += BLOCK) {
    const end = Math.min(n, i + BLOCK);
    dsp.process(voice?.subarray(i, end) ?? null, sysL?.subarray(i, end) ?? null,
      sysR?.subarray(i, end) ?? null, outL.subarray(i, end), outR.subarray(i, end));
    frames += end - i;
    if (frames >= WINDOW) { frames -= WINDOW; meters.push(dsp.takeMeter()); }
  }
  return { outL, outR, meters, last: meters[meters.length - 1] };
}

const gated = (extra = {}) => {
  const dsp = new VoiceDsp(SR);
  dsp.setParams({ gateEnabled: true, openDb: -40, closeDb: -46, ...extra });
  return dsp;
};

test('decibel helpers', () => {
  near(dbToAmp(-6.0206), 0.5, 1e-4);
  near(dbToAmp(0), 1, 1e-12);
  near(ampToDb(0.5), -6.0206, 1e-3);
  assert.equal(ampToDb(0), -100);
  assert.equal(ampToDb(1e-9, -80), -80);
});

test('percentile interpolates linearly and ignores non-numbers', () => {
  assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
  assert.equal(percentile([1, 2, 3, 4, 5], 25), 2);
  near(percentile([1, 2, 3, 4, 5], 95), 4.8, 1e-12);
  assert.equal(percentile([1, 2, 3, 4, 5], 0), 1);
  assert.equal(percentile([1, 2, 3, 4, 5], 100), 5);
  assert.equal(percentile([NaN, 7, undefined], 50), 7);
  assert.ok(Number.isNaN(percentile([], 50)));
});

test('gateThresholds: open/close from the calibration, fail open when unsure', () => {
  assert.deepEqual(gateThresholds({ noiseHiDb: -60, voiceLoDb: -30 }), { enabled: true, openDb: -36, closeDb: -42 });
  // Noise-limited: open sits 6 dB over the loud room moments.
  assert.deepEqual(gateThresholds({ noiseHiDb: -50, voiceLoDb: -40 }), { enabled: true, openDb: -44, closeDb: -50 });
  assert.equal(gateThresholds({ noiseHiDb: -48, voiceLoDb: -40 }).enabled, true, 'a gap of exactly 8 dB is enough');
  assert.equal(gateThresholds({ noiseHiDb: -45, voiceLoDb: -40 }).enabled, false, 'room too close to the voice');
  assert.equal(gateThresholds(null).enabled, false, 'uncalibrated');
  assert.equal(gateThresholds({ noiseHiDb: NaN, voiceLoDb: -30 }).enabled, false);
  const fallback = gateThresholds(null);
  assert.ok(Number.isFinite(fallback.openDb) && fallback.closeDb < fallback.openDb);
});

test('meters read a sine accurately in dBFS', () => {
  const dsp = new VoiceDsp(SR);
  const { meters } = runVoice(dsp, sine({ amp: 0.5, samples: WINDOW * 4 }));
  const m = meters[3];
  near(m.rawRmsDb, -9.031, 0.02, 'raw rms');
  near(m.rawPeakDb, -6.021, 0.02, 'raw peak');
  // Below the compressor threshold the output equals the input.
  const quiet = new VoiceDsp(SR);
  const q = runVoice(quiet, sine({ db: -30, samples: WINDOW * 4 })).meters[3];
  near(q.rawRmsDb, -30, 0.02);
  near(q.outRmsDb, -30, 0.02, 'processed rms');
  near(q.outPeakDb, -30 + 3.0103, 0.02, 'processed peak');
});

test('clip detection counts samples at or above 0.98', () => {
  const hot = runVoice(new VoiceDsp(SR), sine({ amp: 1, samples: WINDOW })).last;
  assert.ok(hot.rawClips > 0);
  const fine = runVoice(new VoiceDsp(SR), sine({ amp: 0.97, samples: WINDOW })).last;
  assert.equal(fine.rawClips, 0);
});

test('digital silence means every raw sample is exactly zero', () => {
  assert.equal(runVoice(new VoiceDsp(SR), silence(0.04)).last.digitalSilence, true);
  const hiss = new Float32Array(WINDOW).fill(1e-7);
  assert.equal(runVoice(new VoiceDsp(SR), hiss).last.digitalSilence, false);
  const oneSample = new Float32Array(WINDOW);
  oneSample[1000] = 1e-6;
  assert.equal(runVoice(new VoiceDsp(SR), oneSample).last.digitalSilence, false);
  assert.equal(new VoiceDsp(SR).takeMeter().digitalSilence, false, 'no samples is not silence');
});

test('expander opens for speech-level input', () => {
  const dsp = gated();
  runVoice(dsp, sine({ db: -60, seconds: 1.5 }));
  assert.equal(dsp.takeMeter().gateOpen, false);
  const { out, last } = runVoice(dsp, sine({ db: -25, seconds: 0.5 }));
  assert.equal(last.gateOpen, true);
  assert.equal(last.speech, true);
  near(last.gateGainDb, 0, 0.01);
  near(rmsDb(out, SR * 0.1), -25, 0.1, 'speech passes untouched');
});

test('expander holds, then closes to the range after hold + release', () => {
  const dsp = gated();
  runVoice(dsp, sine({ db: -25, seconds: 0.5 }));
  dsp.takeMeter();
  const quiet = sine({ db: -60, seconds: 1.5 });
  const { out, meters } = runVoice(dsp, quiet);
  // 200 ms after the voice stops: still inside the 250 ms hold.
  near(meters[4].gateGainDb, 0, 0.01, 'held open');
  assert.equal(meters[4].speech, false);
  const end = meters[meters.length - 1];
  assert.equal(end.gateOpen, false);
  near(end.gateGainDb, EXPANDER_RANGE_DB, 0.1, 'settled at the range');
  near(rmsDb(out, SR * 1.3), -60 + EXPANDER_RANGE_DB, 0.2, 'room turned down by 18 dB');
});

test('expander hysteresis: between close and open it keeps its state', () => {
  const between = () => sine({ db: -43, seconds: 2 });
  // Closed stays closed.
  const closed = gated();
  runVoice(closed, sine({ db: -60, seconds: 1.5 }));
  const c = runVoice(closed, between()).last;
  assert.equal(c.gateOpen, false);
  near(c.gateGainDb, EXPANDER_RANGE_DB, 0.1);
  // Open stays open: the hold restarts while above CLOSE.
  const open = gated();
  runVoice(open, sine({ db: -25, seconds: 0.3 }));
  const o = runVoice(open, between()).last;
  assert.equal(o.gateOpen, true);
  near(o.gateGainDb, 0, 0.01);
});

test('expander lookahead keeps the first syllable', () => {
  const onsetGainDb = lookaheadMs => {
    const dsp = gated({ lookaheadMs });
    const lead = silence(1);
    const burst = sine({ db: -20, seconds: 0.2 });
    const { out } = runVoice(dsp, concat(lead, burst));
    const d = Math.round((lookaheadMs / 1000) * SR);
    const ms1 = 48;
    return rmsDb(out, lead.length + d, lead.length + d + ms1) - rmsDb(burst, 0, ms1);
  };
  const withLookahead = onsetGainDb(5);
  const without = onsetGainDb(0);
  assert.ok(withLookahead > -3, `onset kept with lookahead (${withLookahead.toFixed(1)} dB)`);
  assert.ok(without < -6, `onset chopped without lookahead (${without.toFixed(1)} dB)`);
});

test('compressor: 3:1 above -20 dBFS RMS and no makeup gain', () => {
  const at = db => {
    const dsp = new VoiceDsp(SR);
    return runVoice(dsp, sine({ db, seconds: 1 })).last;
  };
  const loud = at(-8);
  near(loud.compGrDb, -8, 0.3, '12 dB over threshold -> 8 dB reduction');
  near(loud.outRmsDb, -16, 0.3);
  const medium = at(-14);
  near(medium.compGrDb, -4, 0.3);
  near(medium.outRmsDb, -18, 0.3);
  const quiet = at(-30);
  assert.equal(quiet.compGrDb, 0);
  near(quiet.outRmsDb, -30, 0.02, 'below threshold: no gain added');

  // Sample-exact pass-through below threshold (only the 5 ms delay).
  const x = sine({ db: -30, seconds: 0.2 });
  const { out } = runVoice(new VoiceDsp(SR), x);
  for (let i = LOOKAHEAD; i < x.length; i += 97) assert.equal(out[i], x[i - LOOKAHEAD]);
});

test('trim gain is applied smoothly and settles', () => {
  const dsp = new VoiceDsp(SR);
  dsp.setParams({ gain: 2 });
  const { out } = runVoice(dsp, sine({ db: -40, seconds: 0.5 }));
  near(rmsDb(out, SR * 0.2), -40 + 6.02, 0.05);
  // The first samples after the change are not yet at full gain (no jump).
  const fresh = new VoiceDsp(SR);
  runVoice(fresh, sine({ db: -40, seconds: 0.1 }));
  fresh.setParams({ gain: 4 });
  const after = runVoice(fresh, sine({ db: -40, seconds: 0.2 })).out;
  assert.ok(rmsDb(after, 0, 96) < -40 + 6, 'ramps rather than jumps');
});

test('leveler converges on the target and freezes in silence', () => {
  const dsp = new VoiceDsp(SR);
  dsp.setParams({ autoLevel: true });
  const talk = runVoice(dsp, sine({ db: -24, seconds: 25 })).last;
  near(talk.levelerDb, 4, 0.15, 'raised by 4 dB toward -20');
  near(talk.outRmsDb, -20, 0.3);
  const quiet = runVoice(dsp, silence(10)).last;
  near(quiet.levelerDb, talk.levelerDb, 1e-9, 'unchanged in silence');
  // Never more than the range.
  const far = new VoiceDsp(SR);
  far.setParams({ autoLevel: true });
  near(runVoice(far, sine({ db: -40, seconds: 25 })).last.levelerDb, 6, 0.1);
  // Switching off returns to the user's gain.
  far.setParams({ autoLevel: false });
  assert.equal(far.takeMeter().levelerDb, 0);
});

test('bad parameters are ignored instead of breaking the audio', () => {
  const dsp = new VoiceDsp(SR);
  dsp.setParams({ gain: NaN, openDb: 'loud', compressor: { ratio: Infinity }, rangeDb: 12 });
  const { out } = runVoice(dsp, sine({ db: -30, seconds: 0.2 }));
  assert.ok(out.every(Number.isFinite));
  near(rmsDb(out, 2000), -30, 0.05);
});

test('mix: voice alone passes through with the limiter delay', () => {
  const dsp = new MixDsp(SR);
  const voice = sine({ db: -20, seconds: 0.3, freq: 440 });
  const { outL, outR, last } = runMix(dsp, voice);
  for (let i = LOOKAHEAD; i < voice.length; i += 101) {
    near(outL[i], voice[i - LOOKAHEAD], 1e-7);
    near(outR[i], voice[i - LOOKAHEAD], 1e-7);
  }
  assert.equal(last.limiterGrDb, 0);
  assert.equal(last.sysPeakDb, -100);
});

test('mix sums voice and stereo system audio at the system level', () => {
  const dsp = new MixDsp(SR);
  const voice = sine({ db: -55, seconds: 0.5, freq: 300 });    // under the ducking key
  const sysL = sine({ amp: 0.2, seconds: 0.5, freq: 1000 });
  const sysR = sine({ amp: 0.1, seconds: 0.5, freq: 1500 });
  const { outL, outR, last } = runMix(dsp, voice, sysL, sysR);
  for (let i = 2000; i < voice.length; i += 103) {
    near(outL[i], voice[i - LOOKAHEAD] + 0.7 * sysL[i - LOOKAHEAD], 1e-6);
    near(outR[i], voice[i - LOOKAHEAD] + 0.7 * sysR[i - LOOKAHEAD], 1e-6);
  }
  near(last.sysPeakDb, ampToDb(0.2), 0.02, 'system meter reads the input before trim');
  assert.equal(last.ducking, false);
  // A mono system track feeds both sides.
  const mono = runMix(new MixDsp(SR), voice, sysL, null);
  near(mono.outR[3000], mono.outL[3000], 1e-9);
});

test('mix ducks system audio by 10 dB while the teacher talks, then recovers', () => {
  const dsp = new MixDsp(SR);
  dsp.setParams({ systemLevel: 1 });
  const talk = sine({ db: -20, seconds: 1, freq: 300 });
  const pause = silence(3);
  const voice = concat(talk, pause);
  const sys = sine({ amp: 0.2, samples: voice.length, freq: 1000 });
  const { outL, meters } = runMix(dsp, voice, sys, null);
  const residual = new Float32Array(voice.length);
  for (let i = LOOKAHEAD; i < voice.length; i++) residual[i] = outL[i] - voice[i - LOOKAHEAD];
  const sysDb = rmsDb(sys);
  near(rmsDb(residual, SR * 0.6, SR * 1) - sysDb, -10, 0.3, 'ducked depth');
  assert.equal(meters[20].ducking, true);
  near(rmsDb(residual, SR * 3.5, SR * 4) - sysDb, 0, 0.1, 'back to full level');
  assert.equal(meters[meters.length - 1].ducking, false);
});

test('limiter holds the -1 dBFS ceiling on hot input, including the very first peak', () => {
  const dsp = new MixDsp(SR);
  const ceiling = dbToAmp(-1);
  const voice = concat(silence(0.1), sine({ amp: 2, seconds: 0.5, freq: 440 }), silence(0.1),
    sine({ amp: 4, seconds: 0.2, freq: 3000 }));
  const sysL = sine({ amp: 0.9, samples: voice.length, freq: 100 });
  const { outL, outR, meters } = runMix(dsp, voice, sysL, sysL);
  let peak = 0;
  for (let i = 0; i < outL.length; i++) peak = Math.max(peak, Math.abs(outL[i]), Math.abs(outR[i]));
  assert.ok(peak <= ceiling + 1e-9, `peak ${peak} over ceiling ${ceiling}`);
  assert.ok(peak > ceiling - 0.05, 'and it uses the headroom');
  assert.ok(Math.min(...meters.map(m => m.limiterGrDb)) < -6, 'reports gain reduction');
});
