import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeName, makeFilename, withSuffix, splitExt, sidecarName, dateStamp } from '../../src/app/lib/names.js';
import { formatClock, formatTimestamp, formatDuration, formatBytes } from '../../src/app/lib/time.js';
import { buildChapters } from '../../src/app/lib/chapters.js';
import { Emitter } from '../../src/app/lib/emitter.js';

test('safeName keeps letters (including accents) and drops what Windows refuses', () => {
  assert.equal(safeName('Fractions - Week 3'), 'Fractions_-_Week_3');
  assert.equal(safeName('Équations: “part 2”?'), 'Équations_part_2');
  assert.equal(safeName('a/b\\c|d*e'), 'a_b_c_d_e');
  assert.equal(safeName('   '), 'lesson');
  assert.equal(safeName(null), 'lesson');
  assert.equal(safeName('CON'), '_CON');
  assert.equal(safeName('notes...'), 'notes');
  assert.equal(safeName('x'.repeat(200)).length, 80);
});

test('makeFilename stamps the local date and numbers later takes', () => {
  const d = new Date(2026, 9, 8, 14, 5);
  assert.equal(dateStamp(d), '2026-10-08_1405');
  assert.equal(makeFilename({ lessonName: 'Fractions', date: d, ext: 'mp4' }), 'Fractions_2026-10-08_1405.mp4');
  assert.equal(makeFilename({ lessonName: '', date: d, ext: 'webm', take: 3 }), 'lesson_2026-10-08_1405_take3.webm');
});

test('suffix and sidecar names', () => {
  assert.equal(withSuffix('a.b.mp4', 2), 'a.b (2).mp4');
  assert.deepEqual(splitExt('noext'), ['noext', '']);
  assert.equal(sidecarName('lesson.mp4', 'chapters.txt'), 'lesson.chapters.txt');
});

test('time formatting', () => {
  assert.equal(formatClock(0), '00:00');
  assert.equal(formatClock(65_400), '01:05');
  assert.equal(formatClock(3_725_000), '1:02:05');
  assert.equal(formatTimestamp(0), '0:00');
  assert.equal(formatTimestamp(605_000), '10:05');
  assert.equal(formatTimestamp(65_000, true), '0:01:05');
  assert.equal(formatDuration(45_000), '45 s');
  assert.equal(formatDuration(725_000), '12 min 5 s');
  assert.equal(formatDuration(3_720_000), '1 h 2 min');
  assert.equal(formatBytes(1536), '2 KB');
  assert.equal(formatBytes(5 * 1024 ** 2), '5.0 MB');
  assert.equal(formatBytes(2.5 * 1024 ** 3), '2.50 GB');
});

test('chapters: intro is added, list is sorted, YouTube rules are checked', () => {
  const r = buildChapters([{ atMs: 120_000, title: 'Worked example' }, { atMs: 30_000, title: 'Key idea' }], 300_000);
  assert.equal(r.text, '0:00 Intro\n0:30 Key idea\n2:00 Worked example');
  assert.equal(r.youtubeReady, true);
});

test('chapters: an early marker becomes the opening chapter; double taps merge', () => {
  const r = buildChapters([{ atMs: 4000, title: 'Welcome' }, { atMs: 60_000 }, { atMs: 60_400 }, { atMs: 200_000 }], 400_000);
  assert.deepEqual(r.chapters.map(c => c.startMs), [0, 60_000, 200_000]);
  assert.equal(r.chapters[0].title, 'Welcome');
  assert.equal(r.chapters[1].title, 'Chapter 2');
});

test('chapters: problems are explained', () => {
  const few = buildChapters([{ atMs: 30_000 }], 100_000);
  assert.equal(few.youtubeReady, false);
  assert.match(few.issues[0], /at least 3/);
  const short = buildChapters([{ atMs: 20_000, title: 'A' }, { atMs: 25_000, title: 'B' }], 100_000);
  assert.ok(short.issues.some(i => /“A”/.test(i)));
  const long = buildChapters([{ atMs: 1_800_000 }, { atMs: 3_000_000 }], 4_000_000);
  assert.match(long.text, /^0:00:00 Intro/);
  assert.equal(buildChapters([{ atMs: 999_999 }], 1000).chapters.length, 1);
});

test('emitter: on/off/once and a failing listener does not stop others', () => {
  const e = new Emitter(); const seen = [];
  const orig = console.error; console.error = () => {};
  try {
    e.on('x', () => { throw new Error('boom'); });
    const off = e.on('x', d => seen.push(['a', d]));
    e.once('x', d => seen.push(['once', d]));
    e.emit('x', 1); off(); e.emit('x', 2);
  } finally { console.error = orig; }
  assert.deepEqual(seen, [['a', 1], ['once', 1]]);
});
