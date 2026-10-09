// User preferences, persisted in localStorage. Storage can be unavailable or
// throw (private windows, blocked site data), so every access is guarded and
// the app always works with the defaults.

const KEY = 'full-capture:settings:v1';

export const DEFAULT_SETTINGS = Object.freeze({
  lessonName: '',
  format: 'auto',            // 'auto' | 'mp4' | 'webm' (auto = MP4 when the browser can)
  quality: 'standard',       // key of QUALITY_PRESETS in media/formats.js
  countdown: true,
  systemAudio: true,         // include computer sound when the shared surface offers it
  systemAudioLevel: 0.7,     // 0..1.5, computer sound relative to the voice
  micEnabled: true,
  micDeviceId: 'default',
  audioMode: 'clean',        // 'clean' (browser noise suppression) | 'studio' (raw mic + high-pass)
  speakers: false,           // true = no headset: echo cancellation on, Listen off
  micGain: 1,                // linear input trim; the sound check sets this
  gate: false,               // "mute the mic between sentences" (Advanced; engages only once calibrated)
  autoLevel: false,          // slowly ride the input trim toward a target level
  calibrations: {},          // `${deviceId}|${mode}` -> { noiseHiDb, voiceLoDb, gain, label, at }
  camera: false,
  cameraDeviceId: '',
  bubble: { shape: 'circle', size: 'm', x: 0.88, y: 0.82, mirror: true },
  notes: '',                 // speaker notes shown in the pop-out
  theme: 'system',           // 'system' | 'light' | 'dark'
  beeps: false,              // soft beeps during the countdown
  floatingControls: true,    // open the floating controls (Document PiP) when recording starts
  autoHideControls: true,    // close them as a take starts when a whole-screen recording would include them
  hidePreview: true,         // still thumbnail instead of the live screen while recording
  shortcuts: true,           // Alt+R / Alt+P / Alt+M / Alt+H
  noVoice: false,            // deliberately record without the microphone
  micPermissionAsked: false, // the teacher has pressed "Turn on microphone" before
});

function read() {
  try {
    const raw = globalThis.localStorage && localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

/** Current settings: stored values merged over the defaults. */
export function loadSettings() {
  const stored = read();
  const merged = { ...DEFAULT_SETTINGS, ...stored };
  merged.bubble = { ...DEFAULT_SETTINGS.bubble, ...(stored.bubble || {}) };
  return merged;
}

/** Forget every preference (Settings › Reset all settings). */
export function resetSettings() {
  try { localStorage.removeItem(KEY); } catch { /* storage unavailable */ }
  return loadSettings();
}

/** Merge `patch` into the stored settings. Returns the new settings. */
export function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* storage unavailable */ }
  return next;
}
