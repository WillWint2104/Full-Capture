// AudioWorklet processors 'voice' and 'mix'. Bundled to a string and loaded
// from a data: URL (blob: URLs are refused on file:// pages).
//
// Runs on the audio thread, so it keeps working when the tab is hidden.
// process() must never throw: an exception would silence the recording for
// good. If the processing ever fails (or produces a sample that isn't a real
// number), the input passes through unprocessed for that block, the DSP is
// rebuilt and the main thread is told once.
//
// ASCII only: this bundle is base64-encoded with btoa().
import { VoiceDsp, MixDsp } from '../app/audio/dsp.js';

// 1920 frames = 40 ms at 48 kHz: 25 meter updates per second.
const METER_FRAMES = 1920;

const buffers = new Map();
/** A reusable zeroed (or scratch) buffer of the given length. */
function scratch(key, length) {
  let b = buffers.get(key);
  if (!b || b.length !== length) { b = new Float32Array(length); buffers.set(key, b); }
  return b;
}

/** Mono view of an input: channel 0, or the average of all channels; silence if nothing is connected. */
function monoOf(channels, length, key) {
  if (!channels || channels.length === 0) return scratch(key + ':zero', length).fill(0);
  if (channels.length === 1) return channels[0];
  const out = scratch(key + ':mono', length);
  out.fill(0);
  const k = 1 / channels.length;
  for (const ch of channels) for (let i = 0; i < length; i++) out[i] += ch[i] * k;
  return out;
}

/** True when every sample is a real number (state gone bad shows up as NaN or Infinity anywhere in a block). */
function allFinite(samples) {
  for (let i = 0; i < samples.length; i++) if (!Number.isFinite(samples[i])) return false;
  return true;
}

/** Shared plumbing: params from the port, meter cadence, failure handling. */
class DspProcessor extends AudioWorkletProcessor {
  constructor(makeDsp) {
    super();
    this.makeDsp = makeDsp;
    this.dsp = makeDsp();
    this.params = {};
    this.frames = 0;
    this.reported = false;
    this.port.onmessage = e => this.onMessage(e.data);
  }

  onMessage(msg) {
    try {
      if (msg && msg.type === 'params' && msg.params) {
        this.params = Object.assign(this.params, msg.params);
        this.dsp.setParams(msg.params);
      }
    } catch (e) {
      this.report(e);
    }
  }

  /** Throw away state that went bad (NaN) and start again with the same params. */
  rebuild() {
    this.dsp = this.makeDsp();
    this.dsp.setParams(this.params);
  }

  report(e) {
    if (this.reported) return;
    this.reported = true;
    try { this.port.postMessage({ type: 'error', message: String((e && e.message) || e) }); } catch (_) { /* port closed */ }
  }

  /**
   * The browser calls this. Whatever goes wrong in render(), the processor
   * must keep running: an exception here would shut it down for good and
   * silence the recording.
   */
  process(inputs, outputs) {
    try {
      this.render(inputs, outputs);
    } catch (e) {
      this.report(e);
    }
    return true;
  }

  tick(length, makeMessage) {
    this.frames += length;
    if (this.frames < METER_FRAMES) return;
    this.frames -= METER_FRAMES;
    try { this.port.postMessage(makeMessage()); } catch (e) { this.report(e); }
  }
}

class VoiceProcessor extends DspProcessor {
  constructor() { super(() => new VoiceDsp(sampleRate)); }

  render(inputs, outputs) {
    const outs = outputs[0];
    if (!outs || outs.length === 0) return;
    const out = outs[0];
    const input = monoOf(inputs[0], out.length, 'voice');
    try {
      this.dsp.process(input, out);
      if (!allFinite(out)) throw new Error('voice processing produced an invalid sample');
    } catch (e) {
      this.report(e);
      out.set(input);
      this.rebuild();
    }
    for (let c = 1; c < outs.length; c++) outs[c].set(out);
    this.tick(out.length, () => Object.assign({ type: 'meter' }, this.dsp.takeMeter(), { t: currentTime }));
  }
}

class MixProcessor extends DspProcessor {
  constructor() { super(() => new MixDsp(sampleRate)); }

  render(inputs, outputs) {
    const outs = outputs[0];
    if (!outs || outs.length === 0) return;
    const outL = outs[0];
    const outR = outs[1] || null;
    const n = outL.length;
    const voice = monoOf(inputs[0], n, 'mixvoice');
    const sys = inputs[1] || [];
    const sysL = sys[0] || null;
    const sysR = sys[1] || null;
    try {
      this.dsp.process(voice, sysL, sysR, outL, outR);
      if (!allFinite(outL) || (outR && !allFinite(outR))) throw new Error('mix processing produced an invalid sample');
    } catch (e) {
      this.report(e);
      outL.set(voice);
      if (outR) outR.set(voice);
      this.rebuild();
    }
    this.tick(n, () => Object.assign({ type: 'mix-meter' }, this.dsp.takeMeter(), { t: currentTime }));
  }
}

registerProcessor('voice', VoiceProcessor);
registerProcessor('mix', MixProcessor);
