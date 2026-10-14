// Guided sound check (ported from v1): get ready -> stay quiet -> read a line
// aloud. It listens to the engine's 'meter' events (raw float levels from the
// audio thread) and times its steps on the audio clock carried in each
// event, so it is exact even if the tab is hidden or timers are throttled.
import { Emitter } from '../lib/emitter.js';
import { percentile, gateThresholds, dbToAmp, ampToDb, EXPANDER_RANGE_DB } from './dsp.js';
import { detectFormats } from '../media/formats.js';

export const CHECK_TIMING = Object.freeze({ countdownMs: 1000, backgroundMs: 3000, voiceMs: 5000 });
export const TEST_LINE = '“Testing, one two three — today we’re learning about…”';

const TARGET_DB = -20;            // comfortable speech RMS after our gain
const PEAK_CEILING_DB = -3;       // loud syllables stay under this
const NOISE_CEILING_DB = -60;     // room noise between phrases, after gain and room-noise blocking
const MIN_GAIN = 0.25;
const MAX_GAIN = 16;
const VOICE_ABOVE_ROOM_DB = 6;    // a voice-phase window counts as speech this far above the room
const MIN_VOICE_SHARE = 0.2;
const FAINT_MARGIN_DB = 4;        // ending more than this under the target is "faint"
const BIG_BOOST = 4;              // +12 dB of software gain is a lot
const ROOM_QUIET_DB = -50;        // loud room moments (95th pct) below this: the room is quiet
const SNR_GOOD_DB = 20;
const SNR_OK_DB = 12;
const DEAD_DB = -99;              // windows at the -100 floor are exact digital silence
const STALL_MS = 2000;            // no meter for this long: the audio has stopped

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const pct = gain => Math.round(gain * 100);

const INSTRUCTIONS = {
  countdown: 'Get ready — stay quiet for a moment.',
  background: 'Stay quiet — measuring the sound of your room.',
  voice: `Now read this aloud in your normal teaching voice: ${TEST_LINE}`,
};

// Verdict-card headings, in the words of the UX brief.
const HEADLINES = {
  ideal: 'Sounds great – you’re ready',
  usable: 'Usable – one tip below',
  usableTwo: 'Usable – two tips below',
  notready: 'Not ready yet – fix the item below',
  novoice: 'We couldn’t hear you',
  clipping: 'Your mic is overloading',
};

/**
 * Background verdict, ported from v1: driven by voice-to-room ratio and aware
 * of the cause. faintAtSource = the voice is weak at the microphone itself
 * (not just held back to keep room noise down).
 */
function backgroundVerdict({ snrDb, faintAtSource, roomQuiet, gateEnabled }) {
  let v;
  if (snrDb >= SNR_GOOD_DB) {
    v = { level: 'good', title: 'Background: quiet', advice: 'Your voice sits well above the room — clean for a lesson video.' };
  } else if (snrDb >= SNR_OK_DB) {
    v = faintAtSource || roomQuiet
      ? { level: 'warn', title: 'Background: a bit noisy', advice: 'The room itself is quiet — your voice is just too close to its level. Move closer to the microphone (about a hand-span away) so your voice rises clear of the room.' }
      : { level: 'warn', title: 'Background: a bit noisy', advice: 'Some background sound will be heard. Moving closer to the microphone lifts your voice over the room better than more volume does. If the room seems silent to you, the noise is probably microphone hiss: in Windows Sound settings, open your microphone’s Properties → Levels and turn off “Microphone Boost”.' };
  } else {
    v = faintAtSource || roomQuiet
      ? { level: 'warn', title: 'Your voice is faint compared with the room', advice: 'The room is quiet — the problem is that your voice is weak or far from the microphone. Move closer (about a hand-span away) or raise the microphone level in Windows Sound settings, then run the check again.' }
      : { level: 'bad', title: 'Background: too noisy', advice: 'The room is nearly as loud as your voice, so the noise will be clearly heard. Move the microphone closer to your mouth, switch off fans or air conditioning, close the door and windows, or record in a smaller, softer room.' };
  }
  if (!gateEnabled) {
    v.advice += ' Room-noise blocking stays off until your voice is clearly louder than the room.';
  }
  return v;
}

/** Voice verdict after the recommended gain, ported from v1. */
function voiceVerdict({ voiceFaint, limitedBy, recommendedGain }) {
  const n = pct(recommendedGain);
  if (voiceFaint) {
    const advice = {
      noise: 'Turning your voice up any further would make the room noise loud too. Move closer to the microphone (about a hand-span away) or make the room quieter, then run the check again.',
      // The gain stopped short so sudden loud sounds don't distort; more boost isn't the fix.
      peak: 'A few sounds were much louder than the rest of your speech (often “p” and “b” sounds blowing into the microphone, or a knock), so the volume can’t go higher without distorting. Move the microphone a little to the side of your mouth, keep your normal voice, then run the check again.',
    }[limitedBy] || 'Even at the highest boost your voice is quiet. Move closer to the microphone (about a hand-span away), speak up a little, and check in Windows Sound settings that the right microphone is chosen and its level is near 80–100%.';
    return { level: 'bad', title: `Your voice: too quiet — set to ${n}%`, advice };
  }
  if (recommendedGain >= BIG_BOOST) {
    return {
      level: 'warn', title: `Your voice: set to ${n}% (a big boost)`,
      advice: 'That reaches a good level, but a big boost also lifts background noise. Moving closer to the microphone, or raising its level in Windows Sound settings, lets the app use less boost for a cleaner sound.',
    };
  }
  return {
    level: 'good', title: `Your voice: a clear level (${n}%)`,
    advice: `Input volume set to ${n}% — your voice will sit at a strong, steady level throughout the recording.`,
  };
}

function noVoiceResult(base, deadMic) {
  if (deadMic) {
    return {
      ...base, status: 'novoice', headline: 'No sound from your microphone',
      background: { level: 'bad', title: 'Your microphone sent no sound at all', advice: 'It may be muted or switched off. Check the mute switch on your headset or its cable, and in Windows Sound settings make sure the microphone isn’t muted.' },
      voice: { level: 'warn', title: 'Pick the right microphone', advice: 'Choose the microphone you speak into from the list, then run the check again.' },
    };
  }
  return {
    ...base, status: 'novoice', headline: HEADLINES.novoice,
    background: { level: 'warn', title: 'I couldn’t hear your voice clearly', advice: 'During step 2 your voice wasn’t much louder than the room. Stay quiet during step 1, then read the line aloud at your normal teaching volume, about a hand-span from the microphone.' },
    voice: { level: 'warn', title: 'Let’s try once more', advice: 'Make sure the right microphone is chosen in the list (and in Windows Sound settings → Input), then run the check again and keep talking through step 2.' },
  };
}

/**
 * Pure. Turns the raw meter windows of each phase into levels, a calibration
 * for the expander, a recommended input gain and plain-English verdicts.
 *   background / voice: [{ rmsDb, peakDb, clips }] (raw input, before gain)
 *   currentGain: the trim in use (kept when nothing can be recommended)
 * Levels are dBFS. noiseDb is the typical room level (median), noiseHiDb its
 * loud moments (95th pct). voiceDb is the median of speech windows, voiceLoDb
 * their 20th pct, voicePeakDb the 95th pct of their peaks (one desk knock
 * shouldn't set the gain). The gain is the least of: reach -20 dBFS RMS,
 * keep loud peaks under -3 dBFS, and keep room noise between phrases (after
 * room-noise blocking, when it can engage) under -60 dBFS; the noise limit
 * never takes the gain below 100%, because turning everything down doesn't
 * make the voice clearer. Clamped to 25%..1600%.
 */
export function analyzeSoundCheck({ background = [], voice = [], currentGain = 1 } = {}) {
  const bgRms = background.map(w => w.rmsDb).filter(Number.isFinite);
  const voiceRms = voice.map(w => w.rmsDb).filter(Number.isFinite);
  const noiseDb = bgRms.length ? percentile(bgRms, 50) : -100;
  const noiseHiDb = bgRms.length ? percentile(bgRms, 95) : -100;
  const speech = voice.filter(w => Number.isFinite(w.rmsDb) && w.rmsDb >= noiseDb + VOICE_ABOVE_ROOM_DB);
  const heard = speech.length ? speech : voice;
  const voiceDb = heard.length ? percentile(heard.map(w => w.rmsDb), 50) : -100;
  const voiceLoDb = heard.length ? percentile(heard.map(w => w.rmsDb), 20) : -100;
  const voicePeakDb = heard.length ? percentile(heard.map(w => w.peakDb), 95) : -100;
  const snrDb = voiceDb - noiseDb;
  const clipped = voice.some(w => w.clips > 0);
  const roomQuiet = noiseHiDb <= ROOM_QUIET_DB;
  const keep = clamp(Number.isFinite(currentGain) ? currentGain : 1, MIN_GAIN, MAX_GAIN);

  const base = {
    noiseDb, noiseHiDb, voiceLoDb, voiceDb, voicePeakDb, snrDb, clipped, roomQuiet,
    voiceFaint: false, limitedBy: null, gateEnabled: false,
    calibration: null, recommendedGain: keep, applied: 'Nothing was changed.',
  };

  if (clipped) {
    const bg = backgroundVerdict({ snrDb, faintAtSource: false, roomQuiet, gateEnabled: true });
    return {
      ...base, status: 'clipping', headline: HEADLINES.clipping, background: bg,
      voice: {
        level: 'bad', title: 'Your voice: distorting (too loud at the microphone)',
        advice: 'The microphone is overloaded before the sound reaches this app, so it can’t be fixed here. In Windows Sound settings, open your microphone’s Properties → Levels, lower the level to about 70% and turn off “Microphone Boost”, then run the check again.',
      },
    };
  }

  const deadMic = [...bgRms, ...voiceRms].every(db => db <= DEAD_DB);
  if (!voice.length || speech.length < MIN_VOICE_SHARE * voice.length || deadMic) {
    return noVoiceResult(base, deadMic && (bgRms.length + voiceRms.length) > 0);
  }

  const calibration = { noiseHiDb, voiceLoDb };
  const gateEnabled = gateThresholds(calibration).enabled;
  const roomAfterBlockingDb = noiseHiDb + (gateEnabled ? EXPANDER_RANGE_DB : 0);
  const caps = {
    target: TARGET_DB - voiceDb,
    peak: PEAK_CEILING_DB - voicePeakDb,
    noise: Math.max(0, NOISE_CEILING_DB - roomAfterBlockingDb),
    max: ampToDb(MAX_GAIN),
  };
  let limitedBy = 'target';
  for (const k of ['peak', 'noise', 'max']) if (caps[k] < caps[limitedBy]) limitedBy = k;
  const recommendedGain = Math.round(clamp(dbToAmp(caps[limitedBy]), MIN_GAIN, MAX_GAIN) * 100) / 100;
  const voiceFaint = voiceDb + ampToDb(recommendedGain) < TARGET_DB - FAINT_MARGIN_DB;

  const faintAtSource = voiceFaint && limitedBy !== 'noise';
  const bgRow = backgroundVerdict({ snrDb, faintAtSource, roomQuiet, gateEnabled });
  const voiceRow = voiceVerdict({ voiceFaint, limitedBy, recommendedGain });
  const status = bgRow.level === 'good' && voiceRow.level === 'good' ? 'ideal'
    : bgRow.level === 'bad' || voiceRow.level === 'bad' ? 'notready' : 'usable';
  const tips = [bgRow, voiceRow].filter(row => row.level !== 'good').length;
  const headline = status === 'usable' && tips === 2 ? HEADLINES.usableTwo : HEADLINES[status];
  const applied = gateEnabled
    ? `Set your input volume to ${pct(recommendedGain)}% and turned on room-noise blocking.`
    : `Set your input volume to ${pct(recommendedGain)}%. Room-noise blocking stays off because your voice is too close to the room’s level.`;

  return {
    ...base, voiceFaint, limitedBy, gateEnabled, calibration, recommendedGain,
    status, headline, background: bgRow, voice: voiceRow, applied,
  };
}

/**
 * Runs the guided check against an AudioEngine. Events:
 *   'progress' { phase: 'countdown'|'background'|'voice', remainingMs, fraction (of this phase, 0..1), instruction }
 *   'done'     analyzeSoundCheck() result; the caller applies gain + calibration
 *   'cancelled' {}
 *   'error'    { message } when the sound stops reaching the app mid-check
 */
export class SoundCheck extends Emitter {
  #engine;
  #off = [];
  #t0 = null;
  #background = [];
  #voice = [];
  #stallTimer = null;
  #running = false;

  constructor(engine) {
    super();
    this.#engine = engine;
  }

  get running() { return this.#running; }

  /** Start the check. Returns false (and emits 'error') if the sound or the microphone isn't ready. */
  start() {
    if (this.#running) return false;
    if (!this.#engine.running) {
      this.emit('error', { message: 'Click anywhere on the page to start the microphone, then run the sound check again.' });
      return false;
    }
    // Without an open microphone the check would measure silence and then
    // blame the headset's mute switch.
    if (!this.#engine.micInfo) {
      this.emit('error', { message: 'The microphone isn’t on yet. Turn it on (choose “Allow” if the browser asks), then run the sound check again.' });
      return false;
    }
    this.#running = true;
    this.#t0 = null;
    this.#background = [];
    this.#voice = [];
    this.#off = [
      this.#engine.on('meter', m => this.#onMeter(m)),
      this.#engine.on('mic', m => this.#onMic(m)),
    ];
    this.#armStallTimer();
    this.#progress('countdown', 0);
    return true;
  }

  cancel() {
    if (!this.#running) return;
    this.#finish();
    this.emit('cancelled', {});
  }

  #onMeter(m) {
    try {
      if (!this.#running || !Number.isFinite(m?.t)) return;
      this.#armStallTimer();
      if (this.#t0 === null) this.#t0 = m.t;
      // Rounded to the microsecond so phase edges don't wobble with float error.
      const ms = Math.round((m.t - this.#t0) * 1e6) / 1e3;
      const { countdownMs: c, backgroundMs: b, voiceMs: v } = CHECK_TIMING;
      const win = { rmsDb: m.raw.rmsDb, peakDb: m.raw.peakDb, clips: m.raw.clips };
      if (ms > c && ms <= c + b) this.#background.push(win);
      else if (ms > c + b) this.#voice.push(win);

      if (ms >= c + b + v) {
        const result = analyzeSoundCheck({
          background: this.#background, voice: this.#voice, currentGain: this.#engine.gain,
        });
        this.#finish();
        this.emit('done', result);
        return;
      }
      const phase = ms < c ? 'countdown' : ms < c + b ? 'background' : 'voice';
      this.#progress(phase, ms);
    } catch (e) {
      console.error('[soundcheck]', e);
      this.#fail('The sound check hit a problem. Please run it again.');
    }
  }

  #progress(phase, ms) {
    const { countdownMs: c, backgroundMs: b, voiceMs: v } = CHECK_TIMING;
    const start = { countdown: 0, background: c, voice: c + b }[phase];
    const length = { countdown: c, background: b, voice: v }[phase];
    const into = clamp(ms - start, 0, length);
    this.emit('progress', {
      phase, remainingMs: length - into, fraction: into / length, instruction: INSTRUCTIONS[phase],
    });
  }

  #onMic(m) {
    if (!this.#running || m?.status === 'live' || m?.status === 'starting') return;
    this.#fail(m?.status === 'off'
      ? 'The microphone was switched off, so the sound check stopped. Turn it back on, then run the check again.'
      : 'The microphone stopped during the sound check. Reconnect it, then run the check again.');
  }

  /** Meters stop if the audio context is suspended; don't leave the check hanging. */
  #armStallTimer() {
    clearTimeout(this.#stallTimer);
    this.#stallTimer = setTimeout(() => {
      this.#fail('No sound is reaching the app, so the sound check stopped. Click anywhere on the page, make sure the microphone is on, then try again.');
    }, STALL_MS);
  }

  #fail(message) {
    if (!this.#running) return;
    this.#finish();
    this.emit('error', { message });
  }

  #finish() {
    this.#running = false;
    clearTimeout(this.#stallTimer);
    this.#stallTimer = null;
    for (const off of this.#off) off();
    this.#off = [];
  }
}

const fmtDb = db => `${Math.round(db)} dBFS`;

/**
 * v1's "copy desktop-fix prompt": a task for Claude Code (or a similar
 * assistant with terminal access) to tune the Windows microphone settings,
 * filled in with this sound check's measurements when there is one.
 */
export function buildDesktopFixPrompt(result) {
  const asks = [];
  let diag;
  if (result && Number.isFinite(result.voiceDb)) {
    const rating = { ideal: 'IDEAL', usable: 'USABLE but not ideal', notready: 'NOT READY', novoice: 'NO VOICE DETECTED', clipping: 'CLIPPING (distorting)' }[result.status] || 'unknown';
    diag = 'Diagnostics from my recorder’s sound check:\n'
      + `- Background noise floor: about ${fmtDb(result.noiseDb)} (louder moments about ${fmtDb(result.noiseHiDb)})\n`
      + `- My speaking level: about ${fmtDb(result.voiceDb)}\n`
      + `- Voice-to-noise ratio: about ${Math.round(result.snrDb)} dB\n`
      + (result.calibration
        ? `- The app set my input volume to ${pct(result.recommendedGain)}% in software to reach a good level.\n`
        : `- The app left its input volume at ${pct(result.recommendedGain)}% (the check couldn’t recommend a level).\n`)
      + (result.clipped ? '- The microphone signal was clipping (distorting) during the test.\n' : '')
      + `- Overall it rated my setup: ${rating}.\n`;
    if (result.clipped) {
      asks.push('My microphone is clipping. Lower the default microphone’s input level to about 70–80% and turn off “Microphone Boost” if it is on.');
    }
    if (result.status === 'novoice') {
      asks.push('The app could not hear my voice. Check that the default recording device is the microphone I speak into, that it isn’t muted, that its level isn’t near 0%, and that Windows privacy settings let desktop apps and browsers (Chrome/Edge) use the microphone.');
    } else if (!result.clipped) {
      if (result.voiceFaint || result.recommendedGain >= BIG_BOOST) {
        asks.push('My voice is faint at the source (it needed a big software boost). Raise the default microphone’s input level toward 90–100%, and confirm my intended mic (for example a headset) is the default input device.');
      }
      if (!result.roomQuiet && result.snrDb < SNR_GOOD_DB) {
        asks.push('There is audible background noise. Check whether “Microphone Boost” is enabled and, if it is amplifying hiss, reduce or disable it.');
      }
      if (result.roomQuiet && result.snrDb < SNR_GOOD_DB) {
        asks.push('The room is quiet but my voice sits close to the noise — check that a wrong or low-quality mic isn’t the default, and that levels aren’t set too low.');
      }
    }
    if (!asks.length) {
      asks.push('Levels look reasonable — just check the correct mic is the default, its level is around 85–95%, and “Microphone Boost” isn’t adding avoidable noise.');
    }
  } else {
    diag = '(I haven’t run the in-app sound check yet — please just inspect and optimise my mic settings for clear voice recording.)\n';
    asks.push('Confirm the correct microphone is the default input, set its level to around 85–95%, and review “Microphone Boost” so it isn’t adding noise.');
  }
  const n = asks.length;
  return 'You are running on my Windows PC with terminal access. Goal: optimise my microphone settings for recording clear educational voice-over. '
    + 'Work safely and reversibly — make one change at a time, show me before/after, tell me how to undo each change, and only change microphone (recording) settings, never my speakers.\n\n'
    + diag + '\n'
    + 'Please:\n'
    + '1. List my audio input devices and tell me which is the default.\n'
    + asks.map((a, i) => `${i + 2}. ${a}`).join('\n') + '\n'
    + `${n + 2}. Make sure no application has the mic in exclusive mode that would override these levels.\n`
    + `${n + 3}. Re-report the final settings when done, and remind me to run the recorder’s sound check again.\n\n`
    + 'Use PowerShell. The community module AudioDeviceCmdlets is handy for listing/setting default devices and volume — ask before installing it. '
    + 'Microphone Boost lives in the device’s registry FxProperties, so handle that carefully and back up any key you change.';
}

/**
 * Record a short in-memory clip from `track` (normally engine.recordTrack,
 * so it is exactly what a take would capture). Never stops the track.
 * Resolves with the Blob after `ms`, or earlier when `signal` aborts (the
 * clip so far). Rejects with a teacher-readable Error if nothing could be
 * recorded.
 */
export function recordClip(track, ms, { mimeType, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof MediaRecorder !== 'function' || typeof MediaStream !== 'function') {
      reject(new Error('This browser can’t make a test recording. Please use the latest Chrome or Edge.'));
      return;
    }
    if (!track || track.readyState !== 'live') {
      reject(new Error('The sound isn’t ready yet. Switch the microphone on, then try again.'));
      return;
    }
    if (signal?.aborted) {
      reject(new DOMException('The test recording was cancelled.', 'AbortError'));
      return;
    }
    const type = mimeType ?? detectFormats().audio;
    let rec;
    try {
      rec = new MediaRecorder(new MediaStream([track]), type ? { mimeType: type, audioBitsPerSecond: 128_000 } : undefined);
    } catch (e) {
      reject(new Error('The test recording couldn’t start. Reload the page and try again.'));
      return;
    }
    const chunks = [];
    let timer = null;
    const stop = () => { try { if (rec.state !== 'inactive') rec.stop(); } catch { /* already stopped */ } };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
    };
    rec.ondataavailable = e => { if (e.data?.size) chunks.push(e.data); };
    rec.onerror = () => {
      cleanup();
      reject(new Error('The test recording failed. Check the microphone, then try again.'));
    };
    rec.onstop = () => {
      cleanup();
      const blob = new Blob(chunks, { type: chunks[0]?.type || rec.mimeType || 'audio/webm' });
      if (blob.size) resolve(blob);
      else reject(new Error('The test caught no sound. Check the microphone is on, then try again.'));
    };
    signal?.addEventListener('abort', stop);
    try {
      rec.start();
    } catch (e) {
      cleanup();
      reject(new Error('The test recording couldn’t start. Reload the page and try again.'));
      return;
    }
    timer = setTimeout(stop, Math.max(0, ms));
  });
}
