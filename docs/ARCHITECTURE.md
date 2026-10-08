# Full Capture v2: architecture and module contracts

Full Capture is a lesson screen recorder for teachers. It ships as **one HTML
file** (`full-capture.html`) that opens straight from disk (`file://`) in
Chrome or Edge 116+, with no network access and no dependencies. Source lives
in `src/` and `npm run build` bundles it with esbuild.

The user: a teacher on Windows with Chrome/Edge, a headset mic, often a second
monitor. Not a developer. Lessons run 10–90 minutes. Losing a recording is the
worst possible failure; a confusing screen is the second worst.

## Verified platform facts (Chromium 141, page on file://)

- `isSecureContext` is true. `getDisplayMedia`, `getUserMedia`, `MediaRecorder`,
  IndexedDB, `localStorage`, Document Picture-in-Picture and
  `window.showDirectoryPicker` all work.
- `audioWorklet.addModule()` **fails with a blob: URL** but **works with a
  `data:application/javascript;base64,` URL**. The build exposes worklet
  sources as strings: `import SRC from 'worklet:voice-processor.js'`.
- OPFS (`navigator.storage.getDirectory`) fails on file://. Don't use it.
- `MediaStreamTrackProcessor` / `MediaStreamTrackGenerator` work on the main
  thread only (not in workers). Compositing screen + camera frames through an
  `OffscreenCanvas` into a generator track that MediaRecorder records works.
- Chromium (tests) has no H.264/AAC; real Chrome/Edge 126+ record
  `video/mp4;codecs=avc1…,mp4a.40.2`.
- **MediaRecorder's first `dataavailable` chunk can be a single byte.** Header
  parsing must buffer chunks until the WebM Info element is complete.
- A screen-capture track only produces frames when the screen changes, so it
  cannot be the clock for compositing.
- `requestAnimationFrame` stops and timers throttle when the tab is hidden or
  its window is fully covered. Anything that must keep running during a
  lesson (noise gate, metering, compositing, silence detection) must not
  depend on rAF or timers. Use the audio thread (worklet + port messages),
  media-stream callbacks, or MediaRecorder events.

## Repository layout

```
full-capture.html            built app (committed; this is what the teacher opens)
src/index.html               markup shell; build inlines CSS and JS at /*@inline-css*/ and /*@inline-js*/
src/styles/main.css          @imports the other stylesheets
src/app/main.js              entry: boots Session + UI
src/app/session.js           orchestrator: owns every subsystem, exposes actions + state snapshots
src/app/lib/                 emitter.js, idb.js, settings.js, time.js, names.js, chapters.js
src/app/media/               webm.js (header/duration), formats.js (mime, size, bitrate)
src/app/audio/               dsp.js, engine.js, soundcheck.js
src/app/video/               sources.js, compositor.js
src/app/recording/           recorder.js, sinks.js, journal.js, folder.js, takes.js
src/app/ui/                  DOM binding (one module per region)
src/worklets/                AudioWorklet processors (bundled to strings)
test/unit/                   node:test, pure modules (npm test)
test/e2e/                    Playwright from file:// with fake devices (npx playwright test)
test/e2e/harness/            entry files bundled into a blank page to test one module in a real browser
legacy/                      v1 (lesson-recorder v13) for reference
```

## Conventions (all modules)

- ES modules, **named exports only**, JSDoc on every export. No dependencies.
- No side effects at import time that touch `window`, `document` or media
  APIs, so pure modules import cleanly in node tests.
- Stateful classes extend `Emitter` (`src/app/lib/emitter.js`): `on(type, fn)`
  returns an unsubscribe function; listeners receive one `detail` argument.
- Feature-detect every browser API. Never let an exception escape an event
  handler; report through an `'error'` or `'warning'` event with a
  human-readable `message` written for a teacher (no jargon, say what to do).
- Release what you acquire: stop tracks, disconnect nodes, revoke object
  URLs, close writables, clear intervals.
- IndexedDB goes through `src/app/lib/idb.js` (`openDb`, `tx`, `req`, `kv`);
  all stores are declared there. `openDb()` resolves to `null` when IndexedDB
  is unavailable; callers degrade gracefully.
- Settings go through `src/app/lib/settings.js`.
- Style: 2-space indent, semicolons, single quotes, comments explain *why*.

## Existing modules (done, tested)

- `lib/emitter.js` `Emitter`
- `lib/idb.js` `openDb() tx(stores, mode, fn) req(request) kv.get/set/delete` with stores
  `journalMeta (keyPath 'id')`, `journalChunks (keyPath ['id','seq'])`, `takes (keyPath 'id')`, `kv`.
- `lib/settings.js` `DEFAULT_SETTINGS loadSettings() saveSettings(patch)`
- `lib/time.js` `formatClock formatTimestamp formatDuration formatBytes`
- `lib/names.js` `safeName dateStamp makeFilename({lessonName,date,ext,take}) splitExt withSuffix sidecarName`
- `lib/chapters.js` `buildChapters(markers, durationMs) -> {chapters, text, issues, youtubeReady}`, `markerTitle(n)`
- `media/webm.js` `prepareStreamingHeader(bytes) -> {bytes, durationOffset, durationSize, timecodeScale}` (throws `NeedMoreData` until Info is complete),
  `encodeDurationPayload(ms, timecodeScale, size)`, `injectDuration(bytes, ms)`,
  `patchWebmBlob(blob, ms) -> Promise<Blob>` (reads only the head),
  `lastTimestampMs(tailBytes, timecodeScale)`, `readTimecodeScale(headBytes)`, `NeedMoreData`
- `media/formats.js` `detectFormats() -> {mp4, webm, audio}`, `QUALITY_PRESETS {standard, high, smooth}` each `{label, note, maxHeight, fps, contentHint}`,
  `outputSize(w, h, maxHeight)`, `videoBitrate(...)`, `codecFromMime(mime)`,
  `recorderOptions({format, width, height, fps, supported}) -> {mimeType, container, ext, codec, videoBitsPerSecond, audioBitsPerSecond, note}`

---

## Audio (`src/app/audio/`, `src/worklets/`)

All level math is **float**, on the **audio thread**, in two AudioWorklet
processors (one source file, `src/worklets/voice-processor.js`, which imports
`src/app/audio/dsp.js`). No `getByteTimeDomainData`, no rAF loops, no native
`DynamicsCompressorNode` (it adds hidden makeup gain).

### Signal graph

```
mic track ─► MediaStreamSource ─► [studio only: 2 × highpass 80 Hz, Q = -3.01 (Butterworth; Q is in dB for HP/LP)]
          ─► voiceNode  AudioWorklet 'voice'   (detector + raw meter on its INPUT, trim gain, expander with 5 ms
          │                                    lookahead, compressor, optional slow leveler, processed meter)
          ─► micMute (GainNode: 1, or 0 when the mic is switched off)
          ─► mixNode input 0
system audio track ─► MediaStreamSource ─► mixNode input 1
mixNode   AudioWorklet 'mix'  (system trim, ducking keyed on voice activity, sum, 5 ms lookahead limiter at -1 dBFS, meter)
          ─► MediaStreamAudioDestinationNode  ═► recordTrack (stable for the engine's lifetime)
voiceNode ─► monitorGain (0/1) ─► ctx.destination     ("Listen"; headphones only)
```

- The **record track never changes** while the engine lives. Swapping the
  mic, switching modes, unplugging a headset or muting the mic only rewires
  sources upstream, so a recording in progress continues seamlessly. This is
  the key reliability property of the audio design.
- `new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' })`.
  Created at start (suspended until a gesture); `engine.resume()` runs on the
  first pointer/key event. Watch `statechange`; if the context is not
  `running`, the UI says "Click anywhere to start the microphone" and Record
  is not allowed to start a take with dead audio.
- Worklet source is ASCII-only (btoa) and loaded via a `data:` URL.
- Meter messages arrive via `port.onmessage` every 1920 samples (25/s) and
  keep flowing when the tab is hidden.
- Mic constraints. Clean (default): `noiseSuppression: true,
  echoCancellation: false, autoGainControl: false`. Studio: all three false.
  Setting `speakers: true` ("I'm using speakers, not a headset") turns on
  `echoCancellation` and disables Listen. Always `deviceId: {exact}` when a
  device is chosen, `channelCount: {ideal: 1}`, `sampleRate: {ideal: 48000}`.
  Read back `track.getSettings()` and expose what is actually active.
- Monitoring ("Listen") is unavailable while recording with system audio
  (it would be captured twice).

### `dsp.js` (pure; used by the worklet and by node tests)

```js
export const dbToAmp = db => …, ampToDb = (amp, floorDb = -100) => …
/** Block-level stats used by the sound check and the meters. */
export function percentile(values, p)                    // p in 0..100, linear interpolation
/**
 * Expander thresholds from a calibration.
 * calibration = { noiseHiDb /* 95th pct of background block RMS */, voiceLoDb /* 20th pct of speech blocks */ }
 * open = max(noiseHiDb + 6, voiceLoDb - 6), close = open - 6.
 * If voiceLoDb - noiseHiDb < 8 the room is too close to the voice: enabled = false (never gate speech).
 * Uncalibrated (null) => enabled = false: fail open.
 */
export function gateThresholds(calibration) -> { enabled, openDb, closeDb }

export class VoiceDsp {
  constructor(sampleRate)
  setParams({
    gain = 1,                         // linear trim, smoothed over ~50 ms
    gateEnabled = false, openDb = -50, closeDb = -56,
    rangeDb = -18, holdMs = 250, attackMs = 2, releaseMs = 150, lookaheadMs = 5,
    // hold restarts whenever the detector is above CLOSE (not only above open)
    compressor = { thresholdDb: -20, ratio: 3, attackMs: 10, releaseMs: 150 },   // RMS detector, NO makeup gain
    autoLevel = false, autoLevelTargetDb = -20, autoLevelRangeDb = 6,           // slow (4 s), speech-gated, ±range around `gain`
  })
  process(input /* Float32Array mono */, output /* Float32Array */)
  /** Since the last call; then resets. dBFS with floor -100. */
  takeMeter() -> {
    rawRmsDb, rawPeakDb, rawClips,    // INPUT (pre-trim): the detector + sound check use these; clips = samples with |x| >= 0.98
    outRmsDb, outPeakDb,              // after trim/expander/compressor
    gateOpen, gateGainDb, compGrDb, levelerDb,
    speech,                           // voice activity (detector above open threshold at any point)
    digitalSilence,                   // every raw sample exactly 0 (dead/muted device) in this window
  }
}
export class MixDsp {
  constructor(sampleRate)
  setParams({ systemLevel = 0.7, duckDb = -10, duckAttackMs = 50, duckReleaseMs = 400, ceilingDb = -1, lookaheadMs = 5 })
  // Ducking keys on voice activity that MixDsp detects itself from input 0 (> -45 dBFS RMS over 10 ms windows).
  process(voiceIn /* mono */, sysL, sysR /* may be null */, outL, outR)
  takeMeter() -> { outRmsDb, outPeakDb, sysPeakDb, limiterGrDb, ducking }
}
```

### `src/worklets/voice-processor.js`

Registers two processors:
- `'voice'`: 1 input (mono; average channels if more), 1 output (mono). Port
  messages in: `{type:'params', params}` (VoiceDsp.setParams). Port messages out every
  1920 frames: `{type:'meter', ...VoiceDsp.takeMeter(), t: currentTime}`.
- `'mix'`: 2 inputs (voice mono, system stereo or empty), 1 output with
  `outputChannelCount: [2]`. In: `{type:'params', params}`. Out every 1920
  frames: `{type:'mix-meter', ...MixDsp.takeMeter(), t}`.

`process()` must never throw and always returns `true`. Empty inputs (no
system audio connected) are treated as silence.

### `engine.js`

```js
export class AudioEngine extends Emitter {
  constructor()
  async start({ deviceId = 'default', mode = 'clean', speakers = false, micEnabled = true, gain = 1,
                gate = true, autoLevel = false, calibration = null, systemAudioLevel = 0.7 })
  async resume()                       // from a user gesture; resolves true when running
  get running()                        // ctx.state === 'running'
  get recordTrack()                    // MediaStreamTrack (audio), stable
  get context()
  async setDevice(deviceId)            // without touching recordTrack
  async setMode(mode)                  // 'clean' | 'studio'
  async setSpeakers(on)                // echo cancellation on, monitoring off
  async setMicEnabled(on)              // off: release the device and mute
  setGain(linear)                      // 0.25..16 (+24 dB), smoothed; emits 'gain'
  get gain()
  setGate(on)                          // user switch; the expander only engages when gateThresholds(cal).enabled
  setCalibration(cal | null)
  setAutoLevel(on)
  setSystemAudioTrack(track | null)
  setSystemAudioLevel(v)               // 0..1.5
  setMonitor(on)                       // refused (returns false) while recording with system audio; UI explains
  setRecording(on)                     // lets the engine enforce recording-time rules (monitor, etc.)
  getAnalyser()                        // AnalyserNode on the voice output, for the optional spectrum view (float data)
  get micInfo()                        // { deviceId, label, settings: track.getSettings() }
  async stop()
  // Events
  // 'meter' { raw:{rmsDb, peakDb, clips}, voice:{rmsDb, peakDb}, mix:{rmsDb, peakDb, sysPeakDb, limiterGrDb},
  //           gateOpen, gateGainDb, speech, t }        ~25/s, keeps working when hidden
  // 'mic'   { status: 'off'|'starting'|'live'|'blocked'|'lost'|'error', deviceId, label, message? }
  // 'gain'  { gain }
  // 'health'{ digitalSilence: boolean, clipping: boolean }   digitalSilence after 1.5 s of exact zeros (dead/muted
  //           device) while the mic is enabled; clipping latched for 2 s after raw clips
  // 'context' { state }
  // 'error' { message }
}
```
Mic loss: on the mic track's `ended`, or a `devicechange` that removes the
active device: emit `mic {status:'lost'}` immediately, then try the same
device again, then the default device, after 800 ms and on every
`devicechange`, emitting `mic {status:'live'}` when sound is back. Never
silently switch to a different named device without saying so (`message`).
`blocked` = NotAllowedError; the message tells the teacher to click the
camera/mic icon in the address bar.

Calibration is stored per `deviceId + mode` (in settings) and invalidated
when either changes; until re-checked the expander stays off (fail open).

### `soundcheck.js`

Port v1's guided sound check (legacy lines 1131–1397): its flow (get ready →
stay quiet → read the line aloud), its readiness verdicts and its
plain-English advice. It is driven by engine `'meter'` events (raw float
levels), not rAF.

```js
export const CHECK_TIMING = { countdownMs: 1000, backgroundMs: 3000, voiceMs: 5000 }
export const TEST_LINE = '“Testing, one two three — today we’re learning about…”'
/**
 * Pure. Inputs are the raw meter windows collected in each phase:
 * background/voice = [{ rmsDb, peakDb, clips }]. currentGain is the trim in use.
 */
export function analyzeSoundCheck({ background, voice, currentGain = 1 })
  -> { noiseHiDb, voiceLoDb, voiceDb /* median of speech windows */, voicePeakDb, snrDb, clipped,
       calibration: { noiseHiDb, voiceLoDb },           // feed to gateThresholds()
       recommendedGain,                                 // min(target -20 dBFS RMS / voice, (-3 dBFS) / voicePeak,
                                                        //     noise cap so noiseHi × gain <= -60 dBFS), clamped 0.25..16
       voiceFaint, roomQuiet,
       status: 'ideal' | 'usable' | 'notready' | 'novoice' | 'clipping',
       headline,
       background: { level: 'good'|'warn'|'bad', title, advice },
       voice:      { level: 'good'|'warn'|'bad', title, advice },
       applied }                                         // e.g. 'Set your input volume to 140% and turned on room-noise blocking.'
export class SoundCheck extends Emitter {
  constructor(engine)
  start()        // 'progress' {phase:'countdown'|'background'|'voice', remainingMs, fraction, instruction}
  cancel()       // 'cancelled'
  // 'done' result; the caller applies gain + calibration
}
export function buildDesktopFixPrompt(result | null) -> string   // v1's "copy desktop-fix prompt" (Windows mic settings task for Claude Code)
export function recordClip(track, ms, { mimeType, signal } = {}) -> Promise<Blob>   // the 8 s in-memory test clip
```
Voice windows = windows whose rawRmsDb is at least 6 dB above the background
median; if fewer than 20% of voice-phase windows qualify, status `novoice`.
Any raw clips during the voice phase => status `clipping` with advice to lower
the Windows input level or turn off Microphone Boost.

---

## Video (`src/app/video/`)

### `sources.js`

```js
export class CaptureError extends Error { code: 'cancelled' | 'blocked' | 'unsupported' | 'failed' }
/** Ask the teacher to pick a screen. */
export async function pickScreen({ preset /* QUALITY_PRESETS entry */, systemAudio = true })
  -> { stream, videoTrack, audioTrack /* or null */, surface /* 'monitor'|'window'|'browser' */, label, width, height }
  // getDisplayMedia({ video: { displaySurface: 'monitor', frameRate: { ideal: fps, max: fps }, width: { max: 3840 }, height: { max: 2160 }, cursor: 'always' },
  //   audio: systemAudio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false } : false,
  //   systemAudio: systemAudio ? 'include' : 'exclude', selfBrowserSurface: 'exclude', surfaceSwitching: 'include', monitorTypeSurfaces: 'include' })
  // Then videoTrack.contentHint = preset.contentHint and applyConstraints to fit outputSize(...) of the preset.
  // NotAllowedError with no policy wording => code 'cancelled'; policy/permission wording or SecurityError => 'blocked'.
export async function openCamera(deviceId, { width = 1280, height = 720, fps = 30 } = {}) -> MediaStream
export async function listDevices() -> { mics: [{deviceId, label}], cameras: [{deviceId, label}] }   // labels may be empty before permission
export function onDeviceChange(fn) -> unsubscribe
```

### `compositor.js`

```js
export const BUBBLE_SIZES = { s: 0.2, m: 0.27, l: 0.35 }     // bubble diameter as a fraction of output height
/** Pure. Bubble placement in output pixels. bubble = {shape:'circle'|'rounded', size:'s'|'m'|'l', x, y (centre, 0..1), mirror} */
export function bubbleRect({ width, height }, bubble) -> { x, y, size }   // clamped fully inside the frame with a margin of 2% of height
export function isCompositingSupported() -> boolean        // MediaStreamTrackProcessor && MediaStreamTrackGenerator && OffscreenCanvas
export class Compositor extends Emitter {
  constructor({ screenTrack, cameraTrack, width, height, fps, bubble })
  start() -> MediaStreamTrack        // video track to record
  setBubble(bubble)                  // live
  setCameraVisible(on)               // hide/show the bubble mid-take
  setCameraTrack(track | null)       // swap or lose the camera mid-take
  setScreenTrack(track)              // after surface switching
  stop()
  get stats() -> { framesOut, fps }
  // 'warning' { message }
}
```
Clock: draw a frame whenever a **camera** frame arrives (≈30 fps) using the
latest screen frame; also draw when a screen frame arrives and no camera frame
came in the last 1000/fps ms (camera off, frozen or hidden). Screen frame is
letterboxed into width×height on black. Camera frame is centre-cropped to a
square, optionally mirrored, clipped to a circle or rounded square, with a
subtle 2px ring. Close every `VideoFrame` exactly once. Output frame
timestamps must increase monotonically. If `isCompositingSupported()` is
false, the session records without the bubble and tells the teacher why.

---

## Recording (`src/app/recording/`)

### `recorder.js`

```js
export class TakeRecorder extends Emitter {
  constructor({ id, videoTrack, audioTrack, options /* recorderOptions() */, sink, journal /* Journal|null */, meta })
  async start()                 // MediaRecorder.start(1000)
  pause(); resume()
  addMarker(title?) -> { id, atMs, title }
  get state()                   // 'idle'|'recording'|'paused'|'stopping'|'stopped'|'failed'
  get elapsedMs()               // excludes paused time; correct when stopped while paused
  get bytes()
  get markers()
  async stop() -> TakeResult
  async cancel()                // stop, discard, delete partial file and journal entry
  // 'state' {state}   'tick' {elapsedMs, bytes} (driven by dataavailable + a 500 ms timer; the timer may throttle, that is fine)
  // 'warning' {message}   'error' {message, fatal}
}
/** TakeResult */ { id, filename, container, mimeType, durationMs, size, markers, startedAt, savedTo: 'folder'|'memory', blob /* when memory */, folderName /* when folder */ }
```
- Every chunk goes to the **journal first**, then the sink. Writes are
  serialised through one promise chain per destination; a slow disk never
  reorders chunks.
- If MediaRecorder errors, or a track ends (screen sharing stopped from the
  browser bar), stop gracefully and keep what was recorded.
- Duration comes from the recorder's own clock (performance.now, excluding
  pauses), not Date.now arithmetic.

### `sinks.js`

```js
/** Common interface */
//   async open({ filename, container, mimeType })
//   async write(blob)                 // in order, one at a time
//   async finalize({ durationMs }) -> { savedTo, size, blob?, filename, folderName? }
//   async abort()                     // delete partial output
export class MemorySink    // keeps Blob parts (Chrome pages large blobs to disk); finalize = new Blob(parts) then patchWebmBlob for WebM
export class FolderSink    // constructor(folderStore). Streams to a FileSystemWritableFileStream from folderStore.createFile().
                           // WebM: buffer the first chunks until prepareStreamingHeader() succeeds (NeedMoreData => keep buffering; give up
                           // after 2 MB and write unpatched), write the prepared header, remember durationOffset; at finalize write
                           // encodeDurationPayload() at that offset ({type:'write', position, data}) before close().
                           // If a write fails (disk full, permission revoked) emit an error; the recorder falls back to building the
                           // file from the journal (or memory).
```

### `journal.js` (crash recovery)

```js
export class Journal {
  static async open() -> Journal | null
  async begin(meta /* {id, lessonName, filename, container, mimeType, startedAt} */)
  async append(id, seq, blob)
  async update(id, patch /* {elapsedMs, bytes, markers} */)    // called every ~2 s and on pause/marker
  async complete(id)               // take saved: delete chunks + meta
  async listPending() -> [{ meta, chunks, bytes }]       // takes that never completed (call at boot, before recording)
  async assemble(id) -> Blob       // chunks in seq order, typed; WebM gets its Duration from lastTimestampMs() of the tail, else meta.elapsedMs
  async discard(id)
  async estimate() -> { usage, quota } | null
}
/** v1 left unfinished recordings in IndexedDB 'lessonRecorderDB' (stores 'chunks' autoIncrement, 'meta' key 'current' with status 'recording'). */
export async function findLegacyRecording() -> { meta, assemble: () => Promise<Blob>, discard: () => Promise<void> } | null
```
Multiple pending takes are supported; starting a new take never deletes an
unrecovered one (v1 bug).

### `folder.js`

```js
export class FolderStore extends Emitter {
  static isSupported()            // 'showDirectoryPicker' in window
  async init()                    // load the persisted handle (kv 'folderHandle'), queryPermission({mode:'readwrite'})
  get status()                    // 'unsupported' | 'none' | 'needs-permission' | 'ready'
  get name()
  async choose()                  // showDirectoryPicker({ id: 'full-capture', mode: 'readwrite', startIn: 'videos' }); persist; user gesture
  async reconnect()               // requestPermission({mode:'readwrite'}); user gesture
  async forget()
  async createFile(filename) -> { handle, writable, name }   // picks "name (2).ext" if taken
  async writeText(filename, text)                            // sidecar files, e.g. chapters
  async getFile(name) -> File | null
  async remove(name)
  // 'status' { status, name }
}
```

### `takes.js`

```js
export class TakesLibrary extends Emitter {
  static async open() -> TakesLibrary     // in-memory only if IndexedDB is unavailable
  async list() -> Take[]                  // newest first
  async add(take); async update(id, patch); async remove(id)
  // 'change' Take[]
}
/** Take */ { id, lessonName, filename, container, mimeType, durationMs, size, createdAt, markers, savedTo: 'folder'|'download', folderName, thumbnail /* small JPEG data URL or '' */ }
```

---

## Session (`src/app/session.js`)

Owns every subsystem; the UI only calls Session actions and renders Session
snapshots. Emits `'change'` with a fresh immutable snapshot after any change
(coalesced to one per microtask), `'meter'` with engine meter data (high
rate, not part of the snapshot), and `'notice'` for toasts/banners.

Snapshot (`session.state`):
```js
{
  phase: 'setup' | 'ready' | 'countdown' | 'recording' | 'paused' | 'stopping' | 'review',
  countdown: 3 | 2 | 1 | null,
  audioStarted: boolean,                    // false until the first user gesture resumes the context
  screen: null | { label, surface, width, height, hasAudio },
  mic: { enabled, status, deviceId, label, devices: [{deviceId, label}] },
  audio: { mode, gain, gate, autoLevel, monitor, systemAudio, systemAudioLevel, calibrated, silent },
  soundCheck: { running, phase, remainingMs, fraction, instruction, result },
  testClip: { state: 'idle' | 'recording' | 'ready', remainingMs, url, size },
  camera: { enabled, status: 'off'|'starting'|'live'|'blocked'|'error', deviceId, label, devices, bubble, supported, previewStream },
  lesson: { name, format, quality, countdown, notes },
  formats: { mp4, webm },
  take: null | { id, filename, elapsedMs, bytes, markers, savingTo: 'folder'|'memory' },
  review: null | TakeView,                   // the take shown after stopping (or opened from the library)
  library: TakeView[],                       // Take + { url /* session-only object URL */, playable }
  folder: { supported, status, name },
  recovery: [{ id, lessonName, elapsedMs, bytes, startedAt, legacy }],
  alerts: [{ id, kind: 'warning'|'error', title, text }],   // persistent problems (mic lost, no audio, storage low, window-only share)
  storage: { usage, quota } | null,
}
```

Actions (all async-safe; ignore calls that make no sense in the current phase):
```
init()  firstGesture()
chooseScreen()  stopScreen()
setMicEnabled(b) setMicDevice(id) setAudioMode(m) setGain(g) setGate(b) setAutoLevel(b) setMonitor(b) setSystemAudio(b) setSystemAudioLevel(v)
startSoundCheck() cancelSoundCheck() lockAndRetest() copyDesktopPrompt() -> text
startTestClip() stopTestClip() discardTestClip()
setCamera(b) setCameraDevice(id) setBubble(patch)
setLessonName(s) setFormat(f) setQuality(q) setCountdown(b) setNotes(s)
record()        // picks a screen first if none; then countdown (if on) then recording
cancelCountdown() togglePause() stop() cancelTake() addMarker(title?)
renameMarker(takeId, markerId, title) deleteMarker(takeId, markerId)
chaptersFor(takeId) -> {text, issues, youtubeReady}   saveChaptersFile(takeId)
openTake(takeId) closeReview() downloadTake(takeId) deleteTake(takeId)
chooseFolder() reconnectFolder() forgetFolder()
recover(id) discardRecovery(id)
dismissAlert(id)
```

Notices: `'notice'` `{ id?, kind: 'info'|'success'|'warning'|'error', title, text, actions?: [{label, action /* session method name */, args?}], timeoutMs? }`.

---

## UI contract (`src/index.html`, `src/styles/`, `src/app/ui/`)

Markup is static HTML with stable ids; `src/app/ui/*` binds it to the
Session. Dynamic lists are cloned from `<template>`s the markup provides.

Conventions:
- Show/hide with the `hidden` attribute. CSS keeps `[hidden] { display: none !important; }`.
- App phase on `<html data-phase="…">` (the Session phases). Theme on
  `<html data-theme="light|dark">`; absent = follow the system.
- Toggle buttons use `aria-pressed`. Segmented choices are radio groups.
- Meters: an element with class `meter` whose CSS reads custom properties
  `--level` and `--peak` (0..1, set by JS) and optionally `data-zone="low|good|hot"`.
- Dynamic text goes into elements with `data-field="name"`; buttons inside
  templates carry `data-action="name"`.
- Must work at 360 px wide (no horizontal scroll) up to 1920 px; light and
  dark; keyboard-only; screen reader (labels, live regions); `prefers-reduced-motion`.

Required ids:

| Region | ids |
|---|---|
| Header | `appStatus` (live region, status pill text), `btnFolder` (save-location chip; text set by JS), `btnTheme`, `btnHelp` |
| Notices | `banners` (persistent alerts + recovery), `toasts` (transient) |
| Stage | `stage`, `screenVideo` (live preview), `reviewVideo` (playback), `stageEmpty` (empty state containing `btnChooseScreenBig`), `bubblePreview` (camera bubble overlay, contains `cameraVideo`; draggable), `recBadge` (contains `recBadgeText`), `countdown` (contains `countdownNum`), `stageHint` (e.g. "Only one window is being recorded") |
| Record bar | `btnRecord` (start/stop), `timer`, `btnPause`, `btnMarker` (contains `markerCount`), `btnCancelTake`, `btnPopout`, `liveMeter` (`.meter`), `takeSize` |
| Screen card | `screenLabel`, `screenDetail`, `btnChooseScreen`, `sysAudioToggle` (checkbox), `sysAudioLevel` (range 0–150) |
| Mic card | `micToggle` (checkbox), `micSelect`, `micMeter` (`.meter`), `micStatus`, `btnSoundCheck`, `btnTestClip`, `btnListen` (aria-pressed) |
| Sound check | `soundCheck` (panel), `scStep`, `scInstruction`, `scProgress` (`.meter` or progress), `scResult`, `scHeadline` (with `data-status`), `scBgTitle`, `scBgAdvice` (row `scBgRow` with `data-level`), `scVoiceTitle`, `scVoiceAdvice` (row `scVoiceRow`), `scApplied`, `btnScRetest`, `btnScDone`, `btnScCopyPrompt`, `btnScCancel` |
| Test clip | `testClip` (panel), `testClipTitle`, `testAudio`, `btnTestRedo`, `btnTestDiscard` |
| Advanced audio | `advancedAudio` (`<details>`), `modeClean`/`modeStudio` (radios, name `audioMode`), `gateToggle`, `autoLevelToggle`, `gainSlider` (range 25–600), `gainLabel`, `spectrum` (canvas), `statFloor`, `statVoice`, `statSnr` |
| Camera card | `cameraToggle` (checkbox), `cameraSelect`, `bubbleShape` (radios `circle`/`rounded`, name `bubbleShape`), `bubbleSize` (radios `s`/`m`/`l`, name `bubbleSize`), `bubbleMirror` (checkbox), corner buttons `btnCornerTL` `btnCornerTR` `btnCornerBL` `btnCornerBR`, `cameraNote` |
| Lesson card | `lessonName`, `formatSelect` (`auto`/`mp4`/`webm`), `formatNote`, `qualitySelect` (`standard`/`high`/`smooth`), `qualityNote`, `countdownToggle`, `notes` (textarea) |
| Review | `review` (panel), `reviewName`, `reviewMeta`, `reviewSaved`, `chapterList`, `chapterIssues`, `btnCopyChapters`, `btnSaveChapters`, `btnDownloadTake`, `btnDiscardReview`, `btnNewTake` |
| Library | `library` (panel), `takeList`, `libraryEmpty` |
| Dialogs | `<dialog id="confirmDialog">` with `confirmTitle`, `confirmText`, `btnConfirmOk`, `btnConfirmCancel`; `<dialog id="helpDialog">` (shortcuts + how-to) with `btnHelpClose` |

Templates (`<template id>`; inner fields by `data-field`, buttons by `data-action`):
- `tplToast`: root `.toast[data-kind]`; fields `title`, `text`; container `[data-actions]`; `data-action="dismiss"`.
- `tplBanner`: root `.banner[data-kind]`; fields `title`, `text`; `[data-actions]`; `data-action="dismiss"`.
- `tplTake`: root `.take`; fields `thumb` (img), `name`, `date`, `duration`, `size`, `chapters`, `saved`; actions `open`, `download`, `copy-chapters`, `delete`.
- `tplChapter`: root `.chapter`; fields `time`; input `[data-field="title"]`; action `delete`.

Pop-out (Document Picture-in-Picture, ~320×420): built by `ui/popout.js` from
the same tokens: state dot + label, big timer, live meter, a loud "NO AUDIO"
alert, buttons Record/Stop, Pause, Chapter, Discard, and collapsible notes.
Keyboard shortcuts work inside it.

Keyboard shortcuts (ignored while typing in a field): `R` record/stop,
`P` pause/resume, `M` add chapter marker, `Esc` cancel countdown / close
panel, `?` help.
