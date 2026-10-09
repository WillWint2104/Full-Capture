// AudioEngine in real Chromium from file://, with the fake microphone (a
// beep about every half second, ~-15 dBFS RMS, exact zeros in between).
import { test, expect } from '@playwright/test';
import { openHarness, trackErrors } from './helpers.mjs';

const HARNESS = 'test/e2e/harness/audio.entry.js';

let errors;
test.beforeEach(async ({ page }) => {
  errors = trackErrors(page);
  await openHarness(page, HARNESS);
});
test.afterEach(async ({ page }) => {
  await page.evaluate(() => window.engine?.stop());
  expect(errors).toEqual([]);
});

test('worklet loads from a data: URL on file:// and meters flow at 25/s with real levels', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const { startEngine, metersFor } = window.audioTest;
    const { engine, log } = await startEngine();
    const meters = await metersFor(1600);
    return {
      protocol: location.protocol,
      running: engine.running,
      state: engine.context.state,
      mic: log.mic.map(m => m.status),
      count: meters.length,
      rawMax: Math.max(...meters.map(m => m.raw.rmsDb)),
      rawPeak: Math.max(...meters.map(m => m.raw.peakDb)),
      voiceMax: Math.max(...meters.map(m => m.voice.rmsDb)),
      mixMax: Math.max(...meters.map(m => m.mix.rmsDb)),
      increasing: meters.every((m, i) => i === 0 || m.t > meters[i - 1].t),
      spacing: (meters.at(-1).t - meters[0].t) / (meters.length - 1),
      errors: log.error,
    };
  });
  expect(r.protocol).toBe('file:');
  expect(r.running).toBe(true);
  expect(r.mic).toEqual(['starting', 'live']);
  expect(r.count).toBeGreaterThanOrEqual(30);
  expect(r.rawMax).toBeGreaterThan(-30);
  expect(r.rawPeak).toBeGreaterThan(-15);
  expect(r.voiceMax).toBeGreaterThan(-30);
  expect(r.mixMax).toBeGreaterThan(-30);
  expect(r.increasing).toBe(true);
  expect(r.spacing).toBeCloseTo(0.04, 3);
  expect(r.errors).toEqual([]);
});

test('recordTrack records a non-empty audio file with the voice in it', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const { startEngine, recordClip, analyse } = window.audioTest;
    const { engine } = await startEngine();
    const blob = await recordClip(engine.recordTrack, 1500);
    return { size: blob.size, type: blob.type, ...(await analyse(blob)), micInfo: engine.micInfo };
  });
  expect(r.size).toBeGreaterThan(1000);
  expect(r.type).toContain('audio/');
  expect(r.duration).toBeGreaterThan(1.2);
  expect(r.peak).toBeGreaterThan(0.1);
  expect(r.channels).toBe(2);
  expect(r.micInfo.label).toBeTruthy();
  expect(r.micInfo.settings).toMatchObject({ noiseSuppression: true, echoCancellation: false, autoGainControl: false });
});

test('setDevice, setMode and setMicEnabled keep the same recordTrack live while recording', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const { startEngine, startRecorder, until, metersFor, analyse, tailPeak, sleep } = window.audioTest;
    const { engine, log } = await startEngine();
    const track = engine.recordTrack;
    const rec = startRecorder(track);
    const t0 = performance.now();
    const loud = () => until(() => log.meter.slice(-15).some(m => m.raw.rmsDb > -30), 3000, 'mic level');
    const steps = {};

    await sleep(600);
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput');
    const other = devices.find(d => d.deviceId !== 'default');
    await engine.setDevice(other.deviceId);
    steps.device = { same: engine.recordTrack === track, info: engine.micInfo, wanted: other.deviceId };
    await loud();

    await engine.setMode('studio');
    steps.mode = { same: engine.recordTrack === track, settings: engine.micInfo.settings };
    await loud();

    await engine.setMicEnabled(false);
    const offMeters = await metersFor(400);
    steps.off = {
      same: engine.recordTrack === track, info: engine.micInfo, status: log.mic.at(-1).status,
      silent: offMeters.slice(3).every(m => m.raw.rmsDb === -100),
    };

    await engine.setMicEnabled(true);
    await loud();
    steps.on = { same: engine.recordTrack === track, status: log.mic.at(-1).status };
    await sleep(700);

    const elapsed = (performance.now() - t0) / 1000;
    const blob = await rec.stop();
    return {
      steps, elapsed, live: track.readyState, chunks: rec.chunks.length,
      file: await analyse(blob), tail: await tailPeak(blob, 0.6), errors: log.error,
      statuses: log.mic.map(m => m.status),
    };
  });
  expect(r.steps.device.same).toBe(true);
  expect(r.steps.device.info.deviceId).toBe(r.steps.device.wanted);
  expect(r.steps.device.info.label).toMatch(/Fake Audio Input/);
  expect(r.steps.mode.same).toBe(true);
  expect(r.steps.mode.settings.noiseSuppression).toBe(false);
  expect(r.steps.off).toMatchObject({ same: true, info: null, status: 'off', silent: true });
  expect(r.steps.on).toEqual({ same: true, status: 'live' });
  expect(r.live).toBe('live');
  expect(r.statuses).not.toContain('error');
  expect(r.errors).toEqual([]);
  // One continuous file as long as the whole session, with the voice back at the end.
  expect(r.file.duration).toBeGreaterThan(r.elapsed - 0.6);
  expect(r.chunks).toBeGreaterThanOrEqual(Math.floor(r.elapsed * 4) - 2);
  expect(r.tail).toBeGreaterThan(0.05);
});

test('computer sound from another track is mixed into the recording', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const { startEngine, toneTrack, until, metersFor, recordClip, analyse } = window.audioTest;
    // Mic off so the recording is only the computer sound.
    const { engine, log } = await startEngine({ micEnabled: false });
    const tone = toneTrack(440, 0.5);
    engine.setSystemAudioTrack(tone.track);
    await until(() => log.meter.at(-1)?.mix.sysPeakDb > -10, 3000, 'system audio');
    const meters = await metersFor(500);
    const clip = await analyse(await recordClip(engine.recordTrack, 1200));
    engine.setSystemAudioLevel(1.5);
    const louder = await metersFor(500);
    engine.setSystemAudioTrack(null);
    await metersFor(200);
    const after = await metersFor(300);
    tone.stop();
    return {
      sysPeak: meters.at(-1).mix.sysPeakDb,
      mixRms: meters.at(-1).mix.rmsDb,
      louderRms: louder.at(-1).mix.rmsDb,
      limiter: Math.min(...louder.map(m => m.mix.limiterGrDb)),
      clip,
      afterRms: after.at(-1).mix.rmsDb,
    };
  });
  // 0.5 peak = -6 dBFS in; x0.7 = -3.1 dB -> RMS about -12.1 dBFS.
  expect(r.sysPeak).toBeCloseTo(-6.02, 0);
  expect(r.mixRms).toBeGreaterThan(-13);
  expect(r.mixRms).toBeLessThan(-11);
  expect(r.clip.peak).toBeGreaterThan(0.25);
  expect(r.louderRms).toBeGreaterThan(r.mixRms + 3);
  expect(r.afterRms).toBe(-100);
});

test('a lost microphone reports lost, then live again, and the record track carries on', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const { startEngine, until, lastMicTrack } = window.audioTest;
    const { engine, log } = await startEngine();
    const record = engine.recordTrack;
    const old = lastMicTrack();
    const t0 = performance.now();
    old.dispatchEvent(new Event('ended'));
    const lostAt = log.mic.at(-1);
    await until(() => log.mic.at(-1).status === 'live', 4000, 'mic live again');
    const backAfter = performance.now() - t0;
    await until(() => log.meter.slice(-15).some(m => m.raw.rmsDb > -30), 3000, 'level back');
    return {
      lost: lostAt, statuses: log.mic.map(m => m.status), backAfter,
      oldState: old.readyState, sameRecordTrack: engine.recordTrack === record, recordState: record.readyState,
      newTrackIsDifferent: lastMicTrack() !== old,
    };
  });
  expect(r.lost.status).toBe('lost');
  expect(r.lost.message).toMatch(/stopped sending sound/);
  expect(r.statuses).toEqual(['starting', 'live', 'lost', 'live']);
  expect(r.backAfter).toBeGreaterThan(700);
  expect(r.oldState).toBe('ended');
  expect(r.newTrackIsDifferent).toBe(true);
  expect(r.sameRecordTrack).toBe(true);
  expect(r.recordState).toBe('live');
});

test('a missing chosen microphone falls back to the default and says so', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const { startEngine } = window.audioTest;
    const { engine, log } = await startEngine({ deviceId: 'not-a-real-device' });
    return { last: log.mic.at(-1), info: engine.micInfo };
  });
  expect(r.last.status).toBe('live');
  expect(r.last.deviceId).toBe('default');
  expect(r.last.message).toMatch(/isn’t available/);
  expect(r.info.deviceId).toBe('default');
});

test('an unplugged chosen microphone falls back with a message, then switches back when it returns', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const { startEngine, until, lastMicTrack, unplug, replug, otherMicId } = window.audioTest;
    const chosen = await otherMicId();
    const { engine, log } = await startEngine({ deviceId: chosen });
    const record = engine.recordTrack;
    const first = log.mic.at(-1);
    unplug(chosen);
    lastMicTrack().dispatchEvent(new Event('ended'));
    const fallback = await until(() => log.mic.find(m => m.status === 'live' && m.deviceId === 'default'), 4000, 'fallback');
    const onFallback = engine.micInfo;
    replug(chosen);
    const back = await until(() => {
      const m = log.mic.at(-1);
      return m.status === 'live' && m.deviceId === chosen && m !== first && m;
    }, 4000, 'switch back');
    return {
      chosen, first, fallback, onFallback, back, info: engine.micInfo,
      statuses: log.mic.map(m => m.status), same: engine.recordTrack === record && record.readyState === 'live',
    };
  });
  expect(r.first).toMatchObject({ status: 'live', deviceId: r.chosen });
  expect(r.first.message).toBeUndefined();
  expect(r.fallback.message).toMatch(/isn’t available/);
  expect(r.onFallback.deviceId).toBe('default');
  expect(r.back.message).toMatch(/is back/);
  expect(r.info.deviceId).toBe(r.chosen);
  expect(r.statuses.slice(0, 4)).toEqual(['starting', 'live', 'lost', 'live']);
  expect(r.same).toBe(true);
});

test('a stand-in that is refused for a moment keeps recording, keeps the choice and switches back by itself', async ({ page }) => {
  test.setTimeout(30_000);
  const r = await page.evaluate(async () => {
    const { startEngine, until, lastMicTrack, unplug, replug, otherMicId, setBusy, sleep } = window.audioTest;
    const chosen = await otherMicId();
    const { engine, log } = await startEngine({ deviceId: chosen });
    unplug(chosen);
    lastMicTrack().dispatchEvent(new Event('ended'));
    await until(() => log.mic.find(m => m.status === 'live' && m.deviceId === 'default'), 4000, 'fallback');
    const standIn = lastMicTrack();
    // Plugged back in, but Windows refuses it for a moment (NotReadableError).
    setBusy(chosen, true);
    const count = log.mic.length;
    replug(chosen);
    await sleep(800);
    const whileBusy = { events: log.mic.slice(count), info: engine.micInfo, standIn: standIn.readyState };
    // Ready now. No devicechange follows, so only the engine's own retry can bring it back.
    setBusy(chosen, false);
    const back = await until(() => {
      const m = log.mic.at(-1);
      return m.status === 'live' && m.deviceId === chosen && m;
    }, 8000, 'switch back');
    return { chosen, whileBusy, back, info: engine.micInfo, errors: log.error };
  });
  // Not the teacher's doing: no "couldn't be used" message, and the stand-in carries on.
  expect(r.whileBusy.events).toEqual([]);
  expect(r.whileBusy.info.deviceId).toBe('default');
  expect(r.whileBusy.standIn).toBe('live');
  expect(r.back.message).toMatch(/is back/);
  expect(r.info.deviceId).toBe(r.chosen);
  expect(r.errors).toEqual([]);
});

test('a calibration measured on a stand-in mic applies to the stand-in, never to the chosen mic when it returns', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const { startEngine, until, lastMicTrack, unplug, replug, otherMicId, metersFor, sleep } = window.audioTest;
    const chosen = await otherMicId();
    const { engine, log } = await startEngine({ deviceId: chosen });
    unplug(chosen);
    lastMicTrack().dispatchEvent(new Event('ended'));
    await until(() => log.mic.find(m => m.status === 'live' && m.deviceId === 'default'), 4000, 'fallback');
    // A sound check run now measured the stand-in.
    engine.setCalibration({ noiseHiDb: -70, voiceLoDb: -20 });
    await sleep(300);
    const onStandIn = await metersFor(1500);
    replug(chosen);
    await until(() => {
      const m = log.mic.at(-1);
      return m.status === 'live' && m.deviceId === chosen;
    }, 4000, 'switch back');
    await sleep(300);
    const onChosen = await metersFor(1500);
    const closed = ms => ms.some(m => !m.gateOpen && m.gateGainDb < -12);
    return { onStandIn: closed(onStandIn), onChosen: closed(onChosen) };
  });
  expect(r.onStandIn).toBe(true);
  expect(r.onChosen).toBe(false);
});

test('asking for what is already in use leaves the open microphone alone (no gap in a recording)', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const { startEngine, openedCount, lastMicTrack, metersFor } = window.audioTest;
    const { engine, log } = await startEngine();
    const track = lastMicTrack();
    const opens = openedCount();
    const seen = log.mic.length;
    await engine.setMicEnabled(true);
    await engine.setMode('clean');
    await engine.setSpeakers(false);
    await engine.setDevice('default');
    // A quick off-then-on never gets as far as releasing the mic; it must not stay muted.
    await Promise.all([engine.setMicEnabled(false), engine.setMicEnabled(true)]);
    const meters = await metersFor(1500);
    return {
      reopened: openedCount() - opens, statuses: log.mic.slice(seen).map(m => m.status),
      same: lastMicTrack() === track, live: track.readyState,
      mixMax: Math.max(...meters.map(m => m.mix.rmsDb)),
    };
  });
  expect(r.reopened).toBe(0);
  expect(r.statuses).toEqual([]);
  expect(r.same).toBe(true);
  expect(r.live).toBe('live');
  expect(r.mixMax).toBeGreaterThan(-30);
});

test('a stopped engine stays stopped; a processor that dies or never builds is reported in plain words', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const { AudioEngine, startEngine, workletNodes, failWorkletNodes, openedCount } = window.audioTest;
    const out = {};
    const spent = new AudioEngine();
    await spent.stop();
    await spent.start();
    out.spentContext = spent.context;
    out.spentOpens = openedCount();

    const { engine, log } = await startEngine();
    // Chromium delivers a real processor failure to the onprocessorerror
    // handler only (a dispatched event doesn't reach it), so call it as the browser would.
    workletNodes[0].onprocessorerror(new Event('processorerror'));
    out.died = log.error.at(-1)?.message;
    await engine.stop();

    failWorkletNodes(true);
    const broken = new AudioEngine();
    const errors = [];
    broken.on('error', e => errors.push(e.message));
    try { await broken.start(); out.rejected = null; } catch (e) { out.rejected = e.message; }
    failWorkletNodes(false);
    out.brokenErrors = errors;
    out.brokenContext = broken.context?.state;
    return out;
  });
  expect(r.spentContext).toBeNull();
  expect(r.spentOpens).toBe(0);
  expect(r.died).toMatch(/Stop & save/);
  expect(r.died).not.toMatch(/restarted itself/);
  expect(r.rejected).toMatch(/Reload the page/);
  expect(r.brokenErrors).toEqual([r.rejected]);
  expect(r.brokenContext).toBe('closed');
  // The failure is logged for developers; that console line is expected here.
  const expected = errors.filter(e => e.includes('[audio] building the sound graph failed'));
  expect(expected).toHaveLength(1);
  errors.splice(0, errors.length, ...errors.filter(e => !expected.includes(e)));
});

test('gain reaches the audio thread; calibration engages the expander only on its own device', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const { startEngine, metersFor, sleep } = window.audioTest;
    const { engine, log } = await startEngine();
    engine.setGain(0.25);
    await sleep(200);
    // Compare total energy: the processed voice lags the raw input by the
    // 5 ms lookahead, so single windows at a beep's edges don't line up.
    const span = await metersFor(1200);
    const energy = key => span.reduce((sum, m) => sum + 10 ** (m[key].rmsDb / 10), 0);
    const beeps = span.filter(m => m.raw.rmsDb > -30).length;
    const trimDb = 10 * Math.log10(energy('voice') / energy('raw'));

    // Uncalibrated: the expander never closes.
    const before = await metersFor(1200);
    engine.setCalibration({ noiseHiDb: -70, voiceLoDb: -20 });
    await sleep(300);
    const calibrated = await metersFor(1500);

    const other = (await navigator.mediaDevices.enumerateDevices())
      .find(d => d.kind === 'audioinput' && d.deviceId !== 'default');
    await engine.setDevice(other.deviceId);
    await sleep(300);
    const otherDevice = await metersFor(1500);
    await engine.setDevice('default');
    await sleep(300);
    const back = await metersFor(1500);
    const closed = ms => ms.some(m => !m.gateOpen && m.gateGainDb < -12);
    return {
      gainEvents: log.gain, gain: engine.gain, beeps, trimDb,
      before: closed(before), calibrated: closed(calibrated), otherDevice: closed(otherDevice), back: closed(back),
    };
  });
  expect(r.gainEvents).toEqual([{ gain: 0.25 }]);
  expect(r.gain).toBe(0.25);
  expect(r.beeps).toBeGreaterThan(0);
  expect(Math.abs(r.trimDb + 12.04)).toBeLessThan(0.5);
  expect(r.before).toBe(false);
  expect(r.calibrated).toBe(true);
  expect(r.otherDevice).toBe(false);
  expect(r.back).toBe(true);
});

test('health: a muted device (exact zeros) is flagged after 1.5 s and clears when sound returns', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const { startEngine, until, lastMicTrack } = window.audioTest;
    const { engine, log } = await startEngine();
    const mic = lastMicTrack();
    const t0 = performance.now();
    mic.enabled = false;   // a disabled track delivers exact digital silence
    const flagged = await until(() => log.health.find(h => h.digitalSilence), 5000, 'digital silence');
    const after = performance.now() - t0;
    mic.enabled = true;
    await until(() => log.health.at(-1).digitalSilence === false, 3000, 'silence cleared');
    return { flagged, after, health: log.health };
  });
  expect(r.flagged).toEqual({ digitalSilence: true, clipping: false });
  expect(r.after).toBeGreaterThan(1400);
  expect(r.health.at(-1).digitalSilence).toBe(false);
});

test('Listen is refused with speakers and while recording with computer sound', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const { startEngine, toneTrack } = window.audioTest;
    const { engine, log } = await startEngine();
    const out = {};
    out.on = engine.setMonitor(true);
    const tone = toneTrack();
    engine.setSystemAudioTrack(tone.track);
    out.stillOn = engine.monitor;
    engine.setRecording(true);
    out.afterRecording = engine.monitor;
    out.monitorEvent = log.monitor.at(-1);
    out.refused = engine.setMonitor(true);
    engine.setRecording(false);
    out.allowedAgain = engine.setMonitor(true);
    await engine.setSpeakers(true);
    out.speakersMonitor = engine.monitor;
    out.refusedSpeakers = engine.setMonitor(true);
    out.echoCancellation = engine.micInfo.settings.echoCancellation;
    tone.stop();
    return out;
  });
  expect(r).toMatchObject({
    on: true, stillOn: true, afterRecording: false, refused: false, allowedAgain: true,
    speakersMonitor: false, refusedSpeakers: false, echoCancellation: true,
  });
  expect(r.monitorEvent.on).toBe(false);
  expect(r.monitorEvent.message).toMatch(/recorded twice/);
});

test('recordClip stops early on abort and keeps what it caught', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const { startEngine, recordClip, analyse } = window.audioTest;
    const { engine } = await startEngine();
    const ac = new AbortController();
    const t0 = performance.now();
    setTimeout(() => ac.abort(), 700);
    const blob = await recordClip(engine.recordTrack, 8000, { signal: ac.signal });
    const took = performance.now() - t0;
    const info = await analyse(blob);
    let refused = '';
    try { await recordClip(engine.recordTrack, 1000, { signal: AbortSignal.abort() }); } catch (e) { refused = e.name; }
    return { took, duration: info.duration, refused, trackLive: engine.recordTrack.readyState };
  });
  expect(r.took).toBeLessThan(2000);
  expect(r.duration).toBeGreaterThan(0.4);
  expect(r.refused).toBe('AbortError');
  expect(r.trackLive).toBe('live');
});

test('stop() releases the microphone, the record track and the context', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const { startEngine, lastMicTrack } = window.audioTest;
    const { engine, log } = await startEngine();
    const mic = lastMicTrack();
    const record = engine.recordTrack;
    await engine.stop();
    return { mic: mic.readyState, record: record.readyState, ctx: engine.context.state, last: log.mic.at(-1).status };
  });
  expect(r).toEqual({ mic: 'ended', record: 'ended', ctx: 'closed', last: 'off' });
});

test('SoundCheck runs on the live engine and produces a result', async ({ page }) => {
  test.setTimeout(30_000);
  const r = await page.evaluate(async () => {
    const { startEngine, SoundCheck } = window.audioTest;
    const { engine } = await startEngine();
    const check = new SoundCheck(engine);
    const phases = new Set();
    check.on('progress', p => phases.add(p.phase));
    const done = new Promise((resolve, reject) => {
      check.on('done', resolve);
      check.on('error', e => reject(new Error(e.message)));
    });
    check.start();
    const result = await done;
    return { phases: [...phases], status: result.status, keys: Object.keys(result) };
  });
  expect(r.phases).toEqual(['countdown', 'background', 'voice']);
  // The fake mic beeps through both phases, so it may read as no voice; any verdict is fine here.
  expect(['ideal', 'usable', 'notready', 'novoice', 'clipping']).toContain(r.status);
  expect(r.keys).toEqual(expect.arrayContaining(['calibration', 'recommendedGain', 'headline', 'background', 'voice', 'applied']));
});
