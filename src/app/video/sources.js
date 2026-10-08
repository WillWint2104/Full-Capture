// What gets recorded: the teacher's screen (with optional computer sound) and
// the camera. Every failure becomes a CaptureError whose message tells the
// teacher what happened and what to do next.

import { QUALITY_PRESETS } from '../media/formats.js';

/**
 * A capture that could not start.
 * code: 'cancelled' (the teacher closed the picker or prompt), 'blocked' (the
 * browser, computer or school settings refuse), 'unsupported' (this browser
 * cannot do it), 'failed' (anything else; the message says what to try).
 */
export class CaptureError extends Error {
  /**
   * @param {'cancelled'|'blocked'|'unsupported'|'failed'} code
   * @param {string} message plain English for the teacher
   * @param {{cause?: unknown}} [options]
   */
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'CaptureError';
    this.code = code;
  }
}

const SCREEN_MESSAGES = {
  unsupported: 'This browser can’t record the screen. Open Full Capture in Chrome or Edge on a computer.',
  cancelled: 'No screen was chosen. Click “Choose screen”, open the “Entire screen” tab and pick your screen.',
  blocked: 'Screen recording is blocked here. Open Full Capture by double-clicking the file so it opens on its own '
    + 'in Chrome or Edge, not inside another app or preview. If it still happens, your school’s IT settings may '
    + 'have turned screen recording off.',
  blockedBySystem: 'Your computer’s privacy settings are blocking screen recording. Allow your browser to record '
    + 'the screen in the system settings, then restart the browser and try again.',
  noVideo: 'The screen you picked didn’t send any picture. Click “Choose screen” and try again.',
  stopped: 'Screen sharing was stopped. Click “Choose screen” to share your screen again.',
  failed: 'The screen couldn’t be shared. Click “Choose screen” to try again. If it keeps happening, close other '
    + 'apps that share or record the screen, then restart the browser.',
};

const CAMERA_MESSAGES = {
  unsupported: 'This browser can’t use a camera. Open Full Capture in Chrome or Edge on a computer.',
  cancelled: 'The camera didn’t start because the permission question was closed. Switch the camera on again '
    + 'and choose “Allow”.',
  blocked: 'Camera access is blocked. Click the camera icon in the address bar, choose “Allow”, then switch the '
    + 'camera on again.',
  blockedBySystem: 'Your computer’s privacy settings are blocking the camera. In Windows, open Settings › Privacy '
    + '› Camera and allow apps and your browser to use it, then switch the camera on again.',
  missingDevice: 'That camera isn’t connected. Plug it in, or choose a different camera.',
  noCamera: 'No camera was found. Plug one in, then switch the camera on again.',
  busy: 'Your camera is busy. Another app (such as Teams or Zoom) may be using it. Close that app, then switch '
    + 'the camera on again.',
  failed: 'The camera couldn’t start. Unplug it and plug it back in, then switch the camera on again.',
};

// Chrome rejects with the same "Permission denied" whether the teacher closed
// the picker or the browser refused without showing one (a managed computer,
// or a page embedded somewhere screen capture isn't allowed). The picker takes
// a moment to appear and a person a moment to close it, so a refusal faster
// than this was never seen by anyone.
const PICKER_HUMAN_MS = 250;

// Chrome labels whole screens and tabs with internal ids ("screen:0:0",
// "web-contents-media-stream://…", "current-web-contents-media-stream://…"),
// which mean nothing to a teacher.
const MACHINE_LABEL = /^([a-z]+-)*((screen|window):-?\d+:-?\d+$|web-contents-media-stream:\/\/)/;

// The largest picture ever captured (4K). Presets lower the height further.
const MAX_CAPTURE = { width: 3840, height: 2160 };

// How long to wait for a fresh capture's frame when measuring its size.
const MEASURE_TIMEOUT_MS = 500;

const mediaDevices = () => globalThis.navigator?.mediaDevices;
const now = () => globalThis.performance?.now() ?? Date.now();

/** Options for getDisplayMedia: start on the whole monitor, never offer this tab. */
function displayMediaOptions(fps, systemAudio) {
  return {
    video: {
      displaySurface: 'monitor',
      frameRate: { ideal: fps, max: fps },
      width: { max: MAX_CAPTURE.width },
      height: { max: MAX_CAPTURE.height },
      cursor: 'always',
    },
    // Computer sound must reach the mix untouched; the audio engine does the processing.
    audio: systemAudio
      ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false }
      : false,
    systemAudio: systemAudio ? 'include' : 'exclude',
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
    monitorTypeSurfaces: 'include',
  };
}

/** Turn a getDisplayMedia rejection into a CaptureError. */
function screenError(error, elapsedMs) {
  const name = error?.name;
  const text = String(error?.message ?? '');
  const make = (code, message) => new CaptureError(code, message, { cause: error });
  if (name === 'SecurityError') return make('blocked', SCREEN_MESSAGES.blocked);
  if (name === 'NotAllowedError') {
    if (/by system/i.test(text)) return make('blocked', SCREEN_MESSAGES.blockedBySystem);
    if (/polic|disallow/i.test(text)) return make('blocked', SCREEN_MESSAGES.blocked);
    if (elapsedMs < PICKER_HUMAN_MS) return make('blocked', SCREEN_MESSAGES.blocked);
    return make('cancelled', SCREEN_MESSAGES.cancelled);
  }
  if (name === 'NotSupportedError') return make('unsupported', SCREEN_MESSAGES.unsupported);
  return make('failed', SCREEN_MESSAGES.failed);
}

/** What the teacher sees as the name of the shared surface. */
function surfaceLabel(surface, trackLabel) {
  const name = MACHINE_LABEL.test(trackLabel || '') ? '' : String(trackLabel || '').trim();
  if (surface === 'monitor') return 'Whole screen';
  if (surface === 'window') return name ? `Window: ${name}` : 'One window';
  if (surface === 'browser') return name ? `Tab: ${name}` : 'One browser tab';
  return name || 'Screen';
}

/**
 * Scale the capture down to the preset at the source, so the browser never
 * captures (and copies around) more pixels than the recording keeps. The
 * limits are the preset's own (as in outputSize()): Chrome fits whatever is
 * shared inside them, keeping its aspect ratio and never upscaling, even after
 * a shared window or tab is resized. Limits worked out from the picture's size
 * would freeze the capture at that size, and Chrome reports its 16:9 limits as
 * the size until the first frame, which would squeeze wide screens.
 * @returns {Promise<boolean>} whether the browser accepted the limits
 */
async function fitToPreset(track, preset) {
  if (typeof track.applyConstraints !== 'function') return false;
  try {
    await track.applyConstraints({
      width: { max: MAX_CAPTURE.width },
      height: { max: Math.min(preset.maxHeight, MAX_CAPTURE.height) },
      frameRate: { ideal: preset.fps, max: preset.fps },
    });
    return true;
  } catch {
    return false;               // the capture still works at its native size; the recorder scales it
  }
}

/**
 * The size of the picture a display track delivers. Until its first frame
 * arrives Chrome reports the constraint limits as the track's size (3840×2160
 * for any screen), so read one frame from a clone instead. Resolves null if
 * that isn't possible here or no frame comes in time.
 * @returns {Promise<{width: number, height: number}|null>}
 */
async function measureFrame(track) {
  if (typeof globalThis.MediaStreamTrackProcessor !== 'function' || typeof track.clone !== 'function') return null;
  let clone = null;
  let reader = null;
  let timer;
  try {
    clone = track.clone();
    reader = new globalThis.MediaStreamTrackProcessor({ track: clone }).readable.getReader();
    const read = reader.read();
    const timeout = new Promise(resolve => { timer = setTimeout(resolve, MEASURE_TIMEOUT_MS, null); });
    const result = await Promise.race([read, timeout]);
    if (!result) {
      // A frame that lands after giving up must still be released.
      read.then(late => late.value?.close(), () => {});
      return null;
    }
    if (result.done) return null;
    const size = { width: result.value.displayWidth, height: result.value.displayHeight };
    result.value.close();
    return size.width > 0 && size.height > 0 ? size : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    reader?.cancel().catch(() => {});
    clone?.stop();
  }
}

/** The size a track says it has (may be the constraint limits before the first frame). */
function reportedSize(track) {
  const s = track.getSettings?.() ?? {};
  return { width: s.width || 0, height: s.height || 0 };
}

/** Tune a freshly shared screen for the preset and describe it. */
async function prepareScreen(stream, preset) {
  const videoTrack = stream.getVideoTracks()[0];
  if (!videoTrack) throw new CaptureError('failed', SCREEN_MESSAGES.noVideo);
  const audioTrack = stream.getAudioTracks()[0] ?? null;

  // 'detail' keeps text sharp; 'motion' keeps animation smooth.
  if ('contentHint' in videoTrack && preset.contentHint) videoTrack.contentHint = preset.contentHint;
  const surface = videoTrack.getSettings?.().displaySurface || 'monitor';
  const native = (await measureFrame(videoTrack)) ?? reportedSize(videoTrack);
  const fitted = await fitToPreset(videoTrack, preset);
  const size = fitted ? (await measureFrame(videoTrack)) ?? reportedSize(videoTrack) : native;

  // The teacher can press "Stop sharing" while this runs.
  if (videoTrack.readyState === 'ended') throw new CaptureError('cancelled', SCREEN_MESSAGES.stopped);
  return {
    stream,
    videoTrack,
    audioTrack,
    surface,
    label: surfaceLabel(surface, videoTrack.label),
    width: size.width,
    height: size.height,
    nativeWidth: native.width,
    nativeHeight: native.height,
  };
}

/**
 * Ask the teacher to pick a screen (the browser's own picker opens on
 * "Entire screen"). Must be called from a user gesture.
 * @param {{preset?: {maxHeight:number, fps:number, contentHint:string}, systemAudio?: boolean}} [options]
 * @returns {Promise<{stream: MediaStream, videoTrack: MediaStreamTrack, audioTrack: MediaStreamTrack|null,
 *   surface: 'monitor'|'window'|'browser', label: string, width: number, height: number,
 *   nativeWidth: number, nativeHeight: number}>} width/height after fitting the preset; native* before
 * @throws {CaptureError}
 */
export async function pickScreen({ preset = QUALITY_PRESETS.standard, systemAudio = true } = {}) {
  const md = mediaDevices();
  if (typeof md?.getDisplayMedia !== 'function') throw new CaptureError('unsupported', SCREEN_MESSAGES.unsupported);

  const startedAt = now();
  let stream;
  try {
    stream = await md.getDisplayMedia(displayMediaOptions(preset.fps, systemAudio));
  } catch (error) {
    throw screenError(error, now() - startedAt);
  }
  try {
    return await prepareScreen(stream, preset);
  } catch (error) {
    // Never leave the screen shared (and the browser's sharing bar up) after a failure.
    stream.getTracks().forEach(t => t.stop());
    throw error instanceof CaptureError ? error : new CaptureError('failed', SCREEN_MESSAGES.failed, { cause: error });
  }
}

/** Turn a getUserMedia (camera) rejection into a CaptureError. */
function cameraError(error, wantedDevice) {
  const name = error?.name;
  const text = String(error?.message ?? '');
  const make = (code, message) => new CaptureError(code, message, { cause: error });
  if (name === 'NotAllowedError') {
    if (/dismiss/i.test(text)) return make('cancelled', CAMERA_MESSAGES.cancelled);
    if (/by system/i.test(text)) return make('blocked', CAMERA_MESSAGES.blockedBySystem);
    return make('blocked', CAMERA_MESSAGES.blocked);
  }
  if (name === 'SecurityError') return make('blocked', CAMERA_MESSAGES.blocked);
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return make('failed', wantedDevice ? CAMERA_MESSAGES.missingDevice : CAMERA_MESSAGES.noCamera);
  }
  if (name === 'NotReadableError' || name === 'AbortError') return make('failed', CAMERA_MESSAGES.busy);
  return make('failed', CAMERA_MESSAGES.failed);
}

/**
 * Open a camera. `deviceId` '' / null / 'default' means any camera; a real id
 * must match exactly, so a missing camera is reported rather than silently
 * replaced by another one.
 * @param {string|null} deviceId
 * @param {{width?: number, height?: number, fps?: number}} [options]
 * @returns {Promise<MediaStream>} video only
 * @throws {CaptureError}
 */
export async function openCamera(deviceId, { width = 1280, height = 720, fps = 30 } = {}) {
  const md = mediaDevices();
  if (typeof md?.getUserMedia !== 'function') throw new CaptureError('unsupported', CAMERA_MESSAGES.unsupported);
  const wantedDevice = Boolean(deviceId) && deviceId !== 'default';
  const video = {
    ...(wantedDevice ? { deviceId: { exact: deviceId } } : {}),
    width: { ideal: width },
    height: { ideal: height },
    frameRate: { ideal: fps, max: fps },
  };
  try {
    return await md.getUserMedia({ video, audio: false });
  } catch (error) {
    throw cameraError(error, wantedDevice);
  }
}

/**
 * Microphones and cameras. Labels (and, in Chrome, ids) are empty until the
 * page has been allowed to use a device of that kind.
 * @returns {Promise<{mics: {deviceId: string, label: string}[], cameras: {deviceId: string, label: string}[]}>}
 */
export async function listDevices() {
  const md = mediaDevices();
  if (typeof md?.enumerateDevices !== 'function') return { mics: [], cameras: [] };
  let devices;
  try {
    devices = await md.enumerateDevices();
  } catch {
    return { mics: [], cameras: [] };
  }
  const ofKind = kind => devices
    .filter(d => d.kind === kind)
    .map(d => ({ deviceId: d.deviceId, label: d.label }));
  return { mics: ofKind('audioinput'), cameras: ofKind('videoinput') };
}

/**
 * Call `fn` whenever a device is plugged in or removed (Windows often fires
 * several in a row). Errors thrown by `fn`, sync or async, are logged and never
 * escape the event handler.
 * @param {() => unknown} fn
 * @returns {() => void} unsubscribe
 */
export function onDeviceChange(fn) {
  const md = mediaDevices();
  if (typeof md?.addEventListener !== 'function') return () => {};
  const report = error => console.error('[devicechange] listener failed', error);
  const handler = () => {
    try {
      const result = fn();
      if (typeof result?.catch === 'function') result.catch(report);
    } catch (error) {
      report(error);
    }
  };
  md.addEventListener('devicechange', handler);
  return () => md.removeEventListener('devicechange', handler);
}
