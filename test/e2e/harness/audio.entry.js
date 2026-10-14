// Browser harness for the audio subsystem: exposes the engine, the sound
// check and helpers on window.audioTest.
import { AudioEngine } from '../../../src/app/audio/engine.js';
import { SoundCheck, recordClip } from '../../../src/app/audio/soundcheck.js';

// Remember every microphone stream that gets opened, so a test can act on
// the engine's live mic track (simulate an unplug, mute it at the device).
// Devices can be "unplugged": opening them fails and they leave the list.
// Devices can be "busy": listed, but opening them fails as Windows does for
// a moment after a headset is plugged in, or while another app holds it.
const opened = [];
const unplugged = new Set();
const busy = new Set();
const md = navigator.mediaDevices;
const realGetUserMedia = md.getUserMedia.bind(md);
const realEnumerate = md.enumerateDevices.bind(md);
md.getUserMedia = async constraints => {
  const id = constraints?.audio?.deviceId?.exact;
  if (id && unplugged.has(id)) throw new DOMException('Requested device not found', 'NotFoundError');
  if (id && busy.has(id)) throw new DOMException('Could not start audio source', 'NotReadableError');
  const stream = await realGetUserMedia(constraints);
  opened.push({ constraints, stream });
  return stream;
};
md.enumerateDevices = async () => (await realEnumerate()).filter(d => !unplugged.has(d.deviceId));

// Keep hold of the engine's worklet nodes (voice first, then mix) so a test
// can fire 'processorerror' at one; failNodes makes construction throw.
const workletNodes = [];
const RealWorkletNode = window.AudioWorkletNode;
let failNodes = false;
window.AudioWorkletNode = class extends RealWorkletNode {
  constructor(...args) {
    if (failNodes) throw new DOMException('The node name is not defined in AudioWorkletGlobalScope.', 'InvalidStateError');
    super(...args);
    workletNodes.push(this);
  }
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Start an engine and record everything it emits. */
async function startEngine(options = {}) {
  const engine = new AudioEngine();
  const log = { meter: [], mic: [], gain: [], health: [], context: [], error: [], monitor: [] };
  for (const type of Object.keys(log)) engine.on(type, d => log[type].push(d));
  await engine.start(options);
  window.engine = engine;
  window.log = log;
  return { engine, log };
}

/** Wait until fn() is truthy (polling), or throw after `ms`. */
async function until(fn, ms = 5000, what = 'condition') {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    const v = fn();
    if (v) return v;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Meter events from now on, for `ms`. */
async function metersFor(ms) {
  const from = window.log.meter.length;
  await sleep(ms);
  return window.log.meter.slice(from);
}

/** Decode an audio Blob and return { duration, peak, rmsDb } (all channels). */
async function analyse(blob) {
  const ctx = new OfflineAudioContext(2, 48000, 48000);
  const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
  let peak = 0, sum = 0, n = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    for (const x of buf.getChannelData(c)) { peak = Math.max(peak, Math.abs(x)); sum += x * x; n++; }
  }
  return { duration: buf.duration, peak, rmsDb: 10 * Math.log10(sum / n + 1e-20), channels: buf.numberOfChannels };
}

/** Peak of the last `seconds` of a decoded recording. */
async function tailPeak(blob, seconds) {
  const ctx = new OfflineAudioContext(2, 48000, 48000);
  const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
  const data = buf.getChannelData(0);
  let peak = 0;
  for (let i = Math.max(0, data.length - Math.round(seconds * buf.sampleRate)); i < data.length; i++) {
    peak = Math.max(peak, Math.abs(data[i]));
  }
  return peak;
}

/** A computer-sound stand-in: a sine from its own AudioContext as a MediaStreamTrack. */
function toneTrack(freq = 440, amp = 0.5) {
  const ctx = new AudioContext({ sampleRate: 48000 });
  const osc = new OscillatorNode(ctx, { frequency: freq });
  const gain = new GainNode(ctx, { gain: amp });
  const dest = new MediaStreamAudioDestinationNode(ctx);
  osc.connect(gain).connect(dest);
  osc.start();
  const track = dest.stream.getAudioTracks()[0];
  return { track, stop: () => { osc.stop(); track.stop(); ctx.close(); } };
}

/** Record a track with MediaRecorder until stop() is called. */
function startRecorder(track) {
  const chunks = [];
  const rec = new MediaRecorder(new MediaStream([track]), { mimeType: 'audio/webm;codecs=opus' });
  rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  rec.start(250);
  return {
    chunks,
    stop: () => new Promise(resolve => {
      rec.onstop = () => resolve(new Blob(chunks, { type: rec.mimeType }));
      rec.stop();
    }),
  };
}

window.audioTest = {
  AudioEngine, SoundCheck, recordClip,
  startEngine, until, metersFor, analyse, tailPeak, toneTrack, startRecorder, sleep,
  /** The most recently opened microphone track (the engine's live one). */
  lastMicTrack: () => opened.at(-1)?.stream.getAudioTracks()[0] || null,
  unplug: id => { unplugged.add(id); },
  replug: id => { unplugged.delete(id); md.dispatchEvent(new Event('devicechange')); },
  setBusy: (id, on) => { if (on) busy.add(id); else busy.delete(id); },
  /** How many microphone streams have been opened so far. */
  openedCount: () => opened.length,
  workletNodes,
  failWorkletNodes: on => { failNodes = on; },
  otherMicId: async () => (await realEnumerate()).find(d => d.kind === 'audioinput' && d.deviceId !== 'default').deviceId,
};
