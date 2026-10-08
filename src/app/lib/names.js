// File naming. Recordings land on Windows disks, so names avoid the
// characters and device names Windows refuses, but keep accented letters.

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_BASE = 80;
const pad = n => String(n).padStart(2, '0');

/** Turn a lesson title into a safe file-name base ("Fractions – Week 3" -> "Fractions_Week_3"). */
export function safeName(base, fallback = 'lesson') {
  let s = String(base ?? '').normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ')
    .replace(/[^\p{L}\p{N}\-_.,()&'+ ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .replace(/ /g, '_');
  if (s.length > MAX_BASE) s = s.slice(0, MAX_BASE).replace(/[._\-]+$/, '');
  if (!s) return fallback;
  if (RESERVED.test(s.split('.')[0])) s = `_${s}`;
  return s;
}

/** "2026-10-08_1430" in local time. */
export function dateStamp(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}`;
}

/** "Fractions_Week_3_2026-10-08_1430.mp4", with "_take2" from the second take of a lesson on. */
export function makeFilename({ lessonName, date = new Date(), ext = 'webm', take = 1 } = {}) {
  const takePart = take > 1 ? `_take${take}` : '';
  return `${safeName(lessonName)}_${dateStamp(date)}${takePart}.${ext}`;
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
