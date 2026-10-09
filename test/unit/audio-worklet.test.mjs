// The worklet bundle, run in a node vm with a stand-in AudioWorkletGlobalScope.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import path from 'node:path';
import * as esbuild from 'esbuild';
import { ROOT, TARGET } from '../../scripts/bundler.mjs';

async function workletSource() {
  const r = await esbuild.build({
    entryPoints: [path.join(ROOT, 'src/worklets/voice-processor.js')],
    bundle: true, write: false, format: 'iife', target: TARGET, logLevel: 'silent',
  });
  return r.outputFiles[0].text;
}

/** Evaluate the bundle and return { processors, make(name) } with fake ports. */
async function loadWorklet() {
  const processors = new Map();
  class AudioWorkletProcessor {
    constructor() {
      this.port = { posted: [], onmessage: null, postMessage(m) { this.posted.push(m); } };
    }
  }
  const scope = {
    AudioWorkletProcessor, sampleRate: 48000, currentTime: 0,
    registerProcessor: (name, cls) => processors.set(name, cls),
  };
  vm.createContext(scope);
  vm.runInContext(await workletSource(), scope);
  return { processors, scope, make: name => new (processors.get(name))() };
}

const block = (n = 128, fill = 0) => new Float32Array(n).fill(fill);

test('worklet bundle is ASCII (btoa-safe) and registers voice and mix', async () => {
  const src = await workletSource();
  assert.ok(/^[\x00-\x7f]*$/.test(src), 'non-ASCII character in the worklet bundle');
  assert.doesNotThrow(() => btoa(src));
  const { processors } = await loadWorklet();
  assert.deepEqual([...processors.keys()].sort(), ['mix', 'voice']);
});

test('voice processor: empty input is silence, meters every 1920 frames with the audio time', async () => {
  const { make, scope } = await loadWorklet();
  const p = make('voice');
  const out = [[block()]];
  for (let i = 0; i < 14; i++) assert.equal(p.process([[]], out), true);
  assert.equal(p.port.posted.length, 0);
  scope.currentTime = 12.5;
  p.process([[]], out);
  assert.equal(p.port.posted.length, 1);
  const m = p.port.posted[0];
  assert.equal(m.type, 'meter');
  assert.equal(m.t, 12.5);
  assert.equal(m.rawRmsDb, -100);
  assert.equal(m.digitalSilence, true);
  assert.ok(out[0][0].every(x => x === 0));
});

test('voice processor averages extra input channels to mono and applies params', async () => {
  const { make } = await loadWorklet();
  const p = make('voice');
  p.port.onmessage({ data: { type: 'params', params: { gain: 2, lookaheadMs: 0 } } });
  const out = [[block()]];
  // Quiet enough (-28 dBFS after gain) that the compressor stays out of it.
  for (let i = 0; i < 40; i++) p.process([[block(128, 0.01), block(128, 0.03)]], out);
  // (0.01 + 0.03) / 2 = 0.02, times the (settled) gain of 2.
  assert.ok(Math.abs(out[0][0][127] - 0.04) < 1e-4, `got ${out[0][0][127]}`);
});

test('a processing failure passes the voice through and is reported once, never thrown', async () => {
  const { make } = await loadWorklet();
  const p = make('voice');
  p.dsp.process = () => { throw new Error('boom'); };
  const input = block(128, 0.25);
  const out = [[block()]];
  assert.equal(p.process([[input]], out), true);
  assert.equal(out[0][0][5], 0.25, 'input passed through');
  assert.equal(p.process([[input]], out), true);
  const errors = p.port.posted.filter(m => m.type === 'error');
  assert.equal(errors.length, 1);
  // The broken DSP was replaced, so audio is processed again.
  assert.equal(p.process([[input]], out), true);
});

test('a bad sample anywhere in the block is caught, not just the first one', async () => {
  const { make } = await loadWorklet();
  for (const name of ['voice', 'mix']) {
    const p = make(name);
    p.dsp.process = (input, ...outs) => {
      for (const o of outs.filter(Boolean)) { o.fill(0.1); o[50] = NaN; }
    };
    const out = name === 'voice' ? [[block()]] : [[block(), block()]];
    const inputs = name === 'voice' ? [[block(128, 0.25)]] : [[block(128, 0.25)], []];
    assert.equal(p.process(inputs, out), true);
    for (const ch of out[0]) assert.ok(ch.every(Number.isFinite), `${name}: NaN reached the output`);
    assert.equal(out[0][0][50], 0.25, `${name}: the block was passed through instead`);
    assert.equal(p.port.posted.filter(m => m.type === 'error').length, 1, `${name}: reported`);
  }
});

test('process() never throws, even when something outside the DSP fails', async () => {
  const { make } = await loadWorklet();
  const p = make('voice');
  // An output channel the browser sized differently: copying into it throws a RangeError.
  const out = [[block(128), block(64)]];
  let ok;
  assert.doesNotThrow(() => { ok = p.process([[block(128, 0.1)]], out); });
  assert.equal(ok, true);
  assert.equal(p.port.posted.filter(m => m.type === 'error').length, 1);
});

test('mix processor: stereo out with or without system audio, meters with t', async () => {
  const { make, scope } = await loadWorklet();
  const p = make('mix');
  const out = [[block(), block()]];
  scope.currentTime = 3;
  for (let i = 0; i < 15; i++) {
    assert.equal(p.process([[block(128, 0.1)], []], out), true);
  }
  assert.ok(Math.abs(out[0][0][100] - 0.1) < 1e-6 && Math.abs(out[0][1][100] - 0.1) < 1e-6);
  const m = p.port.posted.find(x => x.type === 'mix-meter');
  assert.ok(m);
  assert.equal(m.t, 3);
  assert.equal(m.sysPeakDb, -100);
  // System audio arrives on input 1 (left channel only here).
  for (let i = 0; i < 15; i++) p.process([[block(128, 0)], [block(128, 0.5)]], out);
  const m2 = p.port.posted.filter(x => x.type === 'mix-meter').at(-1);
  assert.ok(Math.abs(m2.sysPeakDb - 20 * Math.log10(0.5)) < 0.01);
  // Bad params are ignored rather than breaking the mix.
  p.port.onmessage({ data: { type: 'params', params: { systemLevel: 'loud' } } });
  p.port.onmessage({ data: null });
  assert.equal(p.process([[block(128, 0.1)], []], out), true);
});
