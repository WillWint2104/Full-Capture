import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeSoundCheck, SoundCheck, CHECK_TIMING, TEST_LINE, buildDesktopFixPrompt,
} from '../../src/app/audio/soundcheck.js';
import { gateThresholds } from '../../src/app/audio/dsp.js';
import { Emitter } from '../../src/app/lib/emitter.js';

const near = (actual, expected, tol, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg ?? ''} expected ${expected} ±${tol}, got ${actual}`);

/** n windows around `db` (a small deterministic spread), peaks `crest` dB above. */
function windows(n, db, { spread = 2, crest = 12, clips = 0 } = {}) {
  return Array.from({ length: n }, (_, i) => {
    const rmsDb = db + spread * Math.sin(i * 1.7);
    return { rmsDb, peakDb: rmsDb + crest, clips };
  });
}
/** Voice phase: `share` of the windows are speech at `db`, the rest are room at `roomDb`. */
function voicePhase(db, roomDb, { share = 0.7, n = 125, crest = 12, clips = 0 } = {}) {
  const speech = Math.round(n * share);
  return [...windows(speech, db, { crest, clips }), ...windows(n - speech, roomDb)];
}

test('ideal: quiet room, clear voice -> gain to -20 dBFS and room-noise blocking on', () => {
  const r = analyzeSoundCheck({ background: windows(75, -65), voice: voicePhase(-28, -65), currentGain: 1 });
  assert.equal(r.status, 'ideal');
  assert.equal(r.headline, 'Sounds great – you’re ready', 'the UX brief’s green verdict');
  near(r.noiseDb, -65, 0.5);
  near(r.voiceDb, -28, 0.5);
  near(r.snrDb, 37, 1);
  assert.equal(r.limitedBy, 'target');
  near(20 * Math.log10(r.recommendedGain), 8, 0.6, 'gain brings the median voice to -20');
  assert.deepEqual(r.calibration, { noiseHiDb: r.noiseHiDb, voiceLoDb: r.voiceLoDb });
  assert.equal(gateThresholds(r.calibration).enabled, true);
  assert.equal(r.gateEnabled, true);
  assert.equal(r.background.level, 'good');
  assert.equal(r.voice.level, 'good');
  assert.match(r.applied, new RegExp(`${Math.round(r.recommendedGain * 100)}% and turned on room-noise blocking`));
});

test('usable: a big software boost is a warning, not a failure', () => {
  const r = analyzeSoundCheck({ background: windows(75, -72), voice: voicePhase(-36, -72) });
  assert.equal(r.status, 'usable');
  assert.ok(r.recommendedGain >= 4, `gain ${r.recommendedGain}`);
  assert.equal(r.voice.level, 'warn');
  assert.match(r.voice.title, /big boost/);
  assert.equal(r.background.level, 'good');
  assert.equal(r.headline, 'Usable – one tip below');
});

test('notready: the room is nearly as loud as the voice', () => {
  const r = analyzeSoundCheck({ background: windows(75, -38, { spread: 1 }), voice: voicePhase(-30, -38) });
  assert.equal(r.status, 'notready');
  assert.equal(r.background.level, 'bad');
  assert.match(r.background.title, /too noisy/);
  assert.match(r.background.advice, /Room-noise blocking stays off/);
  assert.equal(r.gateEnabled, false, 'room too close to the voice for the expander');
  assert.equal(r.limitedBy, 'noise');
  assert.equal(r.recommendedGain, 1, 'the noise cap never turns the voice down below 100%');
  assert.match(r.voice.advice, /room noise loud too/);
  assert.match(r.applied, /Room-noise blocking stays off/);
});

test('novoice: nothing in step 2 rose clearly above the room', () => {
  const r = analyzeSoundCheck({ background: windows(75, -60), voice: voicePhase(-57, -60, { share: 0.9 }), currentGain: 1.8 });
  assert.equal(r.status, 'novoice');
  assert.equal(r.calibration, null);
  assert.equal(r.recommendedGain, 1.8, 'keeps the current gain');
  assert.equal(r.applied, 'Nothing was changed.');
  assert.match(r.background.advice, /Stay quiet during step 1/);
  assert.equal(r.headline, 'We couldn’t hear you');
  // Too little speech (under 20% of the windows) also counts as no voice.
  const brief = analyzeSoundCheck({ background: windows(75, -60), voice: voicePhase(-30, -60, { share: 0.1 }) });
  assert.equal(brief.status, 'novoice');
});

test('novoice from a dead or muted microphone says so', () => {
  const dead = { rmsDb: -100, peakDb: -100, clips: 0 };
  const r = analyzeSoundCheck({ background: Array(75).fill(dead), voice: Array(125).fill(dead) });
  assert.equal(r.status, 'novoice');
  assert.equal(r.headline, 'No sound from your microphone');
  assert.match(r.background.advice, /muted/);
  assert.equal(analyzeSoundCheck({}).status, 'novoice', 'no data at all');
});

test('clipping: any raw clip in step 2 means the Windows level is too high', () => {
  const voice = voicePhase(-12, -60);
  voice[10] = { ...voice[10], clips: 3 };
  const r = analyzeSoundCheck({ background: windows(75, -60), voice, currentGain: 1.2 });
  assert.equal(r.status, 'clipping');
  assert.equal(r.clipped, true);
  assert.equal(r.headline, 'Your mic is overloading');
  assert.equal(r.voice.level, 'bad');
  assert.match(r.voice.advice, /Microphone Boost/);
  assert.match(r.voice.advice, /lower the level/);
  assert.equal(r.recommendedGain, 1.2);
  assert.equal(r.calibration, null);
});

test('faint voice: even the maximum boost falls short', () => {
  const r = analyzeSoundCheck({ background: windows(75, -80, { spread: 1 }), voice: voicePhase(-52, -80) });
  assert.equal(r.voiceFaint, true);
  assert.equal(r.limitedBy, 'max');
  assert.equal(r.recommendedGain, 16);
  assert.equal(r.voice.level, 'bad');
  assert.match(r.voice.advice, /highest boost/);
  assert.equal(r.status, 'notready');
});

test('gain caps: peaks, room noise and the 25%..1600% range', () => {
  // Very peaky speech: keep loud syllables under -3 dBFS.
  const peaky = analyzeSoundCheck({ background: windows(75, -70), voice: voicePhase(-30, -70, { crest: 26 }) });
  assert.equal(peaky.limitedBy, 'peak');
  near(20 * Math.log10(peaky.recommendedGain), -3 - peaky.voicePeakDb, 0.1);
  // Held back by peaks, the voice ends up quiet: the advice must not claim the boost is at its highest.
  assert.equal(peaky.voiceFaint, true);
  assert.ok(peaky.recommendedGain < 16);
  assert.doesNotMatch(peaky.voice.advice, /highest boost/);
  assert.match(peaky.voice.advice, /distorting/);

  // Room noise: with blocking on, the room between phrases (noiseHi + gain - 18 dB) stays under -60 dBFS.
  const roomy = analyzeSoundCheck({ background: windows(75, -51, { spread: 1 }), voice: voicePhase(-40, -51) });
  assert.equal(roomy.gateEnabled, true);
  assert.equal(roomy.limitedBy, 'noise');
  near(roomy.noiseHiDb + 20 * Math.log10(roomy.recommendedGain) - 18, -60, 0.1);

  // A loud voice is turned down, but never below 25%.
  const loud = analyzeSoundCheck({ background: windows(75, -70), voice: voicePhase(-4, -70, { crest: 2 }) });
  assert.equal(loud.recommendedGain, 0.25);
});

/** Stand-in for AudioEngine: emits meter events with a chosen audio-clock time. */
class FakeEngine extends Emitter {
  running = true;
  gain = 1.5;
  micInfo = { deviceId: 'default', label: 'Headset', settings: {} };
  meter(t, rmsDb) { this.emit('meter', { raw: { rmsDb, peakDb: rmsDb + 12, clips: 0 }, t }); }
}

test('SoundCheck times its steps on the meter clock, not the wall clock', () => {
  const engine = new FakeEngine();
  const check = new SoundCheck(engine);
  const progress = [];
  let result = null;
  check.on('progress', p => progress.push(p));
  check.on('done', r => { result = r; });
  assert.equal(check.start(), true);
  assert.equal(check.running, true);
  const t0 = 1234.5678;
  const step = 1920 / 48000;
  const { countdownMs, backgroundMs, voiceMs } = CHECK_TIMING;
  // Countdown windows are loud (and must be ignored); background quiet; voice clear.
  const levelAt = ms => (ms <= countdownMs ? -10 : ms <= countdownMs + backgroundMs ? -62 : -30);
  const total = (countdownMs + backgroundMs + voiceMs) / 1000 / step;
  for (let k = 0; k < total; k++) engine.meter(t0 + k * step, levelAt(k * step * 1000));
  assert.equal(result, null, 'not done one window early');
  engine.meter(t0 + total * step, -30);
  assert.ok(result, 'done after exactly 9 s of audio time');
  assert.equal(check.running, false);
  near(result.noiseHiDb, -62, 0.01, 'no countdown or voice windows leaked into the room measurement');
  near(result.voiceDb, -30, 0.01);
  assert.equal(result.status, 'ideal');

  const phases = [...new Set(progress.map(p => p.phase))];
  assert.deepEqual(phases, ['countdown', 'background', 'voice']);
  const at2s = progress.find(p => p.phase === 'background' && Math.abs(p.remainingMs - 2000) < 1);
  assert.ok(at2s, 'background progress at 2 s');
  near(at2s.fraction, 1 / 3, 1e-6);
  assert.ok(progress.find(p => p.phase === 'voice').instruction.includes(TEST_LINE));

  // Further meters are ignored once done.
  engine.meter(t0 + 20, -30);
  assert.equal(check.running, false);
});

test('SoundCheck cancel, refusals and failures', () => {
  const engine = new FakeEngine();
  const check = new SoundCheck(engine);
  const events = [];
  for (const type of ['cancelled', 'error', 'done']) check.on(type, d => events.push([type, d]));

  check.start();
  assert.equal(check.start(), false, 'already running');
  engine.meter(10, -40);
  check.cancel();
  assert.deepEqual(events.map(e => e[0]), ['cancelled']);
  for (let k = 0; k < 300; k++) engine.meter(10 + k * 0.04, -30);
  assert.equal(events.length, 1, 'no longer listening');

  engine.running = false;
  assert.equal(check.start(), false);
  assert.match(events.at(-1)[1].message, /Click anywhere/);

  engine.running = true;
  check.start();
  engine.emit('mic', { status: 'lost' });
  assert.equal(check.running, false);
  assert.match(events.at(-1)[1].message, /microphone stopped/);

  // No microphone open (blocked, not found, switched off): measuring silence
  // would end in advice about a mute switch, so it refuses straight away.
  engine.micInfo = null;
  const before = events.length;
  assert.equal(check.start(), false);
  assert.equal(check.running, false);
  assert.equal(events.length, before + 1);
  assert.match(events.at(-1)[1].message, /microphone isn’t on/);
});

test('SoundCheck stops with a message if the meters stall', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const engine = new FakeEngine();
    const check = new SoundCheck(engine);
    let error = null;
    check.on('error', e => { error = e; });
    check.start();
    engine.meter(0, -50);
    mock.timers.tick(1500);
    engine.meter(0.04, -50);
    mock.timers.tick(1500);
    assert.equal(error, null, 'meters kept it alive');
    mock.timers.tick(600);
    assert.ok(error);
    assert.match(error.message, /No sound is reaching the app/);
    assert.equal(check.running, false);
  } finally {
    mock.timers.reset();
  }
});

test('buildDesktopFixPrompt: v1 task, filled with the measurements', () => {
  const none = buildDesktopFixPrompt(null);
  assert.match(none, /haven’t run the in-app sound check/);
  assert.match(none, /^You are running on my Windows PC/);
  assert.match(none, /AudioDeviceCmdlets/);
  assert.match(none, /FxProperties/);

  const faint = analyzeSoundCheck({ background: windows(75, -80, { spread: 1 }), voice: voicePhase(-52, -80) });
  const p = buildDesktopFixPrompt(faint);
  assert.match(p, new RegExp(`Background noise floor: about ${Math.round(faint.noiseDb)} dBFS`));
  assert.match(p, new RegExp(`My speaking level: about ${Math.round(faint.voiceDb)} dBFS`));
  assert.match(p, /input volume to 1600%/);
  assert.match(p, /NOT READY/);
  assert.match(p, /faint at the source/);
  // Steps are numbered 1..n with no gaps.
  const numbers = [...p.matchAll(/^(\d+)\. /gm)].map(m => Number(m[1]));
  assert.deepEqual(numbers, numbers.map((_, i) => i + 1));
  assert.ok(numbers.length >= 4);

  const clipVoice = voicePhase(-12, -60);
  clipVoice[0] = { ...clipVoice[0], clips: 1 };
  const clipping = buildDesktopFixPrompt(analyzeSoundCheck({ background: windows(75, -60), voice: clipVoice }));
  assert.match(clipping, /clipping/);
  assert.match(clipping, /70–80%/);
  // Nothing was changed for a clipping or no-voice result, so the prompt mustn't say it was.
  assert.doesNotMatch(clipping, /set my input volume/);
  assert.match(clipping, /left its input volume at 100%/);
  assert.match(p, /set my input volume to 1600%/);

  const ideal = buildDesktopFixPrompt(analyzeSoundCheck({ background: windows(75, -65), voice: voicePhase(-28, -65) }));
  assert.match(ideal, /IDEAL/);
  assert.match(ideal, /Levels look reasonable/);
});
