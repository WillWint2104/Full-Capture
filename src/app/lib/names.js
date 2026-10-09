// File naming. Recordings land on Windows disks, so names avoid the
// characters and device names Windows refuses, but keep accented letters.

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_BASE = 80;
const pad = n => String(n).padStart(2, '0');

/**
 * Turn a lesson title into a safe file-name base. Only what Windows forbids
 * is removed; letters (any language), spaces and dashes stay readable:
 * "Fractions: Week 3?" -> "Fractions Week 3".
 */
export function safeName(base, fallback = 'Lesson') {
  let s = String(base ?? '').normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (s.length > MAX_BASE) s = s.slice(0, MAX_BASE).replace(/[.\s_\-–]+$/, '');
  if (!s) return fallback;
  if (RESERVED.test(s.split('.')[0])) s = `_${s}`;
  return s;
}

/** "2026-10-08 14.30" in local time (sorts by date; no colons, which Windows forbids). */
export function dateStamp(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}.${pad(date.getMinutes())}`;
}

/** "Fractions – Week 3 (2026-10-08 14.30).mp4"; from the second take of the day: "(2026-10-08 14.30, take 2)". */
export function makeFilename({ lessonName, date = new Date(), ext = 'webm', take = 1 } = {}) {
  const takePart = take > 1 ? `, take ${take}` : '';
  return `${safeName(lessonName)} (${dateStamp(date)}${takePart}).${ext}`;
}

/**
 * Suggest the next lesson in a numbered series: "Fractions – Week 3" ->
 * "Fractions – Week 4". Returns '' when the name doesn't end in a number.
 */
export function suggestNextName(name) {
  const m = String(name ?? '').trim().match(/^(.*?)(\d+)$/);
  if (!m || !m[1].trim()) return '';
  return m[1] + String(Number(m[2]) + 1).padStart(m[2].length, '0');
}

/** Split "a.b.mp4" into ["a.b", ".mp4"]. */
export function splitExt(filename) {
  const i = filename.lastIndexOf('.');
  return i > 0 ? [filename.slice(0, i), filename.slice(i)] : [filename, ''];
}

/** "lesson.mp4" -> "lesson (2).mp4". */
export function withSuffix(filename, n) {
  const [base, ext] = splitExt(filename);
  return `${base} (${n})${ext}`;
}

/** Sidecar name for a recording: "lesson.mp4" -> "lesson.chapters.txt". */
export function sidecarName(filename, suffix) {
  return `${splitExt(filename)[0]}.${suffix}`;
}
