// Chapter markers dropped while recording, turned into a YouTube chapter list.
// YouTube's rules: the first chapter starts at 0:00, there are at least three
// chapters, and each one lasts at least ten seconds.

import { formatTimestamp } from './time.js';

export const MIN_CHAPTER_MS = 10_000;
export const MIN_CHAPTERS = 3;

export const markerTitle = n => `Chapter ${n}`;

export const INTRO_ID = 'intro';

/**
 * @param {{id?:string, atMs:number, title?:string}[]} markers  times exclude paused time
 * @param {number} durationMs  length of the finished video
 * @param {{introTitle?:string}} [options]
 * @returns {{chapters:{id:string, startMs:number, title:string, intro?:boolean, moved?:boolean}[], text:string, issues:string[], youtubeReady:boolean}}
 *   Each chapter carries its marker's id; an added opening chapter has id INTRO_ID.
 */
export function buildChapters(markers, durationMs, { introTitle = 'Intro' } = {}) {
  const sorted = (markers || [])
    .filter(m => Number.isFinite(m.atMs) && m.atMs >= 0 && m.atMs < durationMs)
    .map((m, i) => ({ id: m.id ?? `m${i}`, startMs: Math.floor(m.atMs), title: (m.title || '').trim() || markerTitle(i + 1) }))
    .sort((a, b) => a.startMs - b.startMs);

  const chapters = [];
  for (const m of sorted) {
    const prev = chapters[chapters.length - 1];
    // Two presses within a second are a double-tap, not two chapters.
    if (prev && m.startMs - prev.startMs < 1000) continue;
    chapters.push(m);
  }
  // A marker in the first few seconds is the opening chapter; otherwise add one.
  const intro = (introTitle || '').trim() || 'Intro';
  if (!chapters.length || chapters[0].startMs >= MIN_CHAPTER_MS) chapters.unshift({ id: INTRO_ID, startMs: 0, title: intro, intro: true });
  else chapters[0] = { ...chapters[0], startMs: 0, moved: chapters[0].startMs > 0 };

  const issues = [];
  if (chapters.length < MIN_CHAPTERS) {
    issues.push(`YouTube needs at least ${MIN_CHAPTERS} chapters; this take has ${chapters.length}.`);
  }
  const short = chapters.filter((c, i) => {
    const end = i + 1 < chapters.length ? chapters[i + 1].startMs : durationMs;
    return end - c.startMs < MIN_CHAPTER_MS;
  });
  if (short.length) {
    issues.push(`Each chapter must last at least 10 seconds: ${short.map(c => `“${c.title}”`).join(', ')} ${short.length === 1 ? 'is' : 'are'} shorter.`);
  }

  const hours = durationMs >= 3_600_000;
  const text = chapters.map(c => `${formatTimestamp(c.startMs, hours)} ${c.title}`).join('\n');
  return { chapters, text, issues, youtubeReady: issues.length === 0 };
}
