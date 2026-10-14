// The Windows acceptance kit's file checks (test/windows/analyse.mjs) on a
// file made with ffmpeg whose answers are known: a white flash every 2 s with
// its click 80 ms late, a magenta box on top (standing in for the floating controls)
// from 6 to 10 s, and an index after the media like the app's saved MP4s.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hasFfmpeg } from '../tools/media.mjs';
import { analyseTake } from '../windows/analyse.mjs';

const needFfmpeg = { skip: !hasFfmpeg && !process.env.CI && 'ffmpeg/ffprobe not installed' };

test('the acceptance kit measures sync, finds the controls in frames, and checks seeks and layout', needFfmpeg, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fc-kit-'));
  try {
    const file = path.join(dir, 'take.mp4');
    execFileSync('ffmpeg', ['-v', 'error',
      '-f', 'lavfi', '-i', "color=c=black:s=640x360:r=30:d=20,drawbox=x=0:y=0:w=640:h=360:color=white:t=fill:enable='lt(mod(t,2),0.12)',drawbox=x=20:y=100:w=300:h=200:color=0xff00ff:t=fill:enable='between(t,6,10)'",
      '-f', 'lavfi', '-i', "aevalsrc='if(gte(t,0.08)*lt(mod(t-0.08,2),0.04), 0.5*(random(0)*2-1), 0.001*(random(1)*2-1))':s=48000:d=20",
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '60', '-c:a', 'aac', file]);
    const a = await analyseTake(file, {
      outDir: dir, name: 'take',
      expect: { pauseAt: 10, controls: [{ name: 'off', from: -1, to: 5.7, shown: false }, { name: 'on', from: 6.3, to: 9.7, shown: true }, { name: 'off2', from: 10.3, to: 1e9, shown: false }] },
    });
    assert.deepEqual([a.probe.video.codec, a.probe.audio.codec], ['h264', 'aac']);
    assert.equal(a.layout.moovAtEnd, true);
    assert.equal(a.layout.fragmented, false);
    assert.ok(Math.abs(a.layout.headerS - 20) < 0.1);
    assert.equal(a.decodeErrors, '');
    // The click is 80 ms after its flash everywhere: at the start, after the "pause", at the end.
    assert.equal(a.sync.measured, true);
    for (const part of [a.sync, a.sync.start, a.sync.afterPause, a.sync.end]) assert.ok(Math.abs(part.medianMs - 80) <= 10, JSON.stringify(part));
    // The box is found where it is and nowhere else.
    for (const c of a.controls) assert.equal(c.wrong, 0, JSON.stringify(c));
    assert.ok(a.controls.every(c => c.frames > 50));
    // Seeks land on a frame there, decode cleanly and keep the sync.
    for (const s of a.seeks) {
      assert.ok(Math.abs(s.firstVideo - s.target) < 0.05 && Math.abs(s.firstAudio - s.target) < 0.05, JSON.stringify(s));
      assert.equal(s.decodeErrors, '');
      assert.equal(s.syncKept, true, JSON.stringify(s));
    }
    assert.deepEqual(a.gaps.soundGaps, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
