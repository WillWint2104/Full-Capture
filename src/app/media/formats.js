// Choosing what MediaRecorder produces: container, codecs, size and bitrate.

// H.264 + AAC in MP4 imports cleanly into every editor and plays everywhere,
// so it is preferred when the browser can make it (Chrome/Edge 126+).
export const MP4_CANDIDATES = [
  'video/mp4;codecs=avc1.640033,mp4a.40.2',
  'video/mp4;codecs=avc1.640028,mp4a.40.2',
  'video/mp4;codecs=avc1.4d0028,mp4a.40.2',
  'video/mp4;codecs=avc1.42e01f,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4;codecs=avc1.640028,opus',
  'video/mp4;codecs=avc1,opus',
];

export const WEBM_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=h264,opus',
  'video/webm',
];

export const AUDIO_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
];

export const QUALITY_PRESETS = {
  standard: {
    label: 'Standard (1080p)',
    note: 'Sharp text and smaller files. Right for most lessons.',
    maxHeight: 1080, fps: 30, contentHint: 'detail',
  },
  high: {
    label: 'High (full resolution)',
    note: 'Your screen’s full resolution, up to 4K. Bigger files.',
    maxHeight: 2160, fps: 30, contentHint: 'detail',
  },
  smooth: {
    label: 'Smooth motion (1080p, 60 fps)',
    note: 'For animations, video clips and fast scrolling.',
    maxHeight: 1080, fps: 60, contentHint: 'motion',
  },
};

const MAX_WIDTH = 3840;

function firstSupported(list, isTypeSupported) {
  for (const m of list) {
    try { if (isTypeSupported(m)) return m; } catch { /* treat as unsupported */ }
  }
  return null;
}

/** Which containers this browser can record. */
export function detectFormats(isTypeSupported = t => globalThis.MediaRecorder?.isTypeSupported(t) ?? false) {
  return {
    mp4: firstSupported(MP4_CANDIDATES, isTypeSupported),
    webm: firstSupported(WEBM_CANDIDATES, isTypeSupported),
    audio: firstSupported(AUDIO_CANDIDATES, isTypeSupported),
  };
}

/** 'h264' | 'vp9' | 'vp8' | 'av1' | 'unknown' */
export function codecFromMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (/avc1|h264/.test(m)) return 'h264';
  if (/vp9|vp09/.test(m)) return 'vp9';
  if (/vp8/.test(m)) return 'vp8';
  if (/av01|av1/.test(m)) return 'av1';
  return 'unknown';
}

const even = n => Math.max(2, Math.round(n / 2) * 2);

/** Fit a source size under the preset's height (and a 4K width cap), keeping the aspect ratio. */
export function outputSize(srcWidth, srcHeight, maxHeight) {
  const w = srcWidth || 1920, h = srcHeight || 1080;
  const scale = Math.min(1, maxHeight / h, MAX_WIDTH / w);
  return { width: even(w * scale), height: even(h * scale) };
}

/**
 * Video bitrate for screen content. Lessons are mostly still text, which
 * needs bits for sharp edges rather than motion, so this scales with pixel
 * count and only gently with frame rate.
 */
export function videoBitrate({ width, height, fps = 30, codec = 'h264' }) {
  const bitsPerPixel = { h264: 0.08, vp9: 0.06, av1: 0.05, vp8: 0.09 }[codec] ?? 0.08;
  const fpsFactor = (fps / 30) ** 0.75;
  const bps = width * height * 30 * bitsPerPixel * fpsFactor;
  return Math.round(Math.min(16_000_000, Math.max(1_500_000, bps)) / 100_000) * 100_000;
}

/**
 * MediaRecorder settings for a take.
 * @param {{format:'auto'|'mp4'|'webm', width:number, height:number, fps:number, supported:{mp4:string|null, webm:string|null}}} o
 */
export function recorderOptions({ format = 'auto', width, height, fps = 30, supported }) {
  let container = format === 'webm' ? 'webm' : 'mp4';
  let note = '';
  if (container === 'mp4' && !supported.mp4) {
    container = 'webm';
    if (format === 'mp4') note = 'This browser can’t record MP4, so this take is WebM.';
  }
  if (container === 'webm' && !supported.webm && supported.mp4) container = 'mp4';
  const mimeType = (container === 'mp4' ? supported.mp4 : supported.webm) || '';
  const codec = codecFromMime(mimeType) === 'unknown' ? (container === 'mp4' ? 'h264' : 'vp8') : codecFromMime(mimeType);
  const audioIsAac = /mp4a/.test(mimeType);
  return {
    mimeType,
    container,
    ext: container,
    codec,
    videoBitsPerSecond: videoBitrate({ width, height, fps, codec }),
    audioBitsPerSecond: audioIsAac ? 160_000 : 128_000,
    note,
  };
}
