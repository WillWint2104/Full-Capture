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
export const EXPANDER_RANGE_DB = -18      // VoiceDsp's default rangeDb; the sound check's noise cap uses it

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
    gateOpen, gateGainDb, compGrDb, levelerDb,   // gains in dB; compGrDb = most reduction in the window (<= 0)
    speech,                           // voice activity (detector above open threshold at any point)
    digitalSilence,                   // every raw sample exactly 0 (dead/muted device) in this window
  }
}
export class MixDsp {
  constructor(sampleRate)
  setParams({ systemLevel = 0.7, duckDb = -10, duckAttackMs = 50, duckReleaseMs = 400, ceilingDb = -1, lookaheadMs = 5 })
  // Ducking keys on voice activity that MixDsp detects itself from input 0 (> -45 dBFS RMS over 10 ms windows),
  // held 250 ms so music doesn't pump between words.
  process(voiceIn /* mono */, sysL, sysR /* may be null */, outL, outR)
  takeMeter() -> { outRmsDb, outPeakDb, sysPeakDb /* system input, before trim */, limiterGrDb /* <= 0 */, ducking }
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
  setMonitor(on)                       // refused (returns false) with speakers, or while recording with system audio; UI explains
  get monitor()                        // whether Listen is on (the engine may switch it off: see 'monitor')
  setRecording(on)                     // lets the engine enforce recording-time rules (monitor, etc.)
  getAnalyser()                        // AnalyserNode on the voice output, for the optional spectrum view (float data)
  get micInfo()                        // { deviceId, label, settings: track.getSettings() } or null when no mic is open
  async stop()                         // releases everything; make a new engine to start again
  // Events
  // 'meter' { raw:{rmsDb, peakDb, clips}, voice:{rmsDb, peakDb}, mix:{rmsDb, peakDb, sysPeakDb, limiterGrDb, ducking},
  //           gateOpen, gateGainDb, compGrDb, levelerDb, speech, digitalSilence, t }   ~25/s, keeps working when hidden
  // 'monitor' { on: false, message }   the engine switched Listen off (speakers, or recording with system audio)
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
camera/mic icon in the address bar. Returning from a stand-in to the chosen
device (when it is listed again) tries only the chosen device; if it is not
ready yet (Windows often refuses a headset for a moment after it is plugged
in) the stand-in keeps working, the choice is kept, no `'mic'` event is sent,
and it tries again every 5 s and on every `devicechange`. A call that changes
nothing (`setMicEnabled(true)` while on, the same mode, speakers or device)
leaves the open microphone alone, so it never cuts a gap into a recording.

Calibration is stored per `deviceId + mode` (in settings) and invalidated
when either changes; until re-checked the expander stays off (fail open).
The engine enforces this itself: a calibration applies only to the
microphone + mode actually in use when `setCalibration` was called; it
applies again if they change back. A stand-in counts as itself (as
`'default'`), so the chosen mic's calibration is off while it stands in,
and one measured on the stand-in never carries over to the chosen mic.

`start()` rejects (and emits `'error'`) only when the browser can't process
audio at all; microphone problems arrive as `'mic'` events. A failed
`setDevice` keeps the microphone that was working, reverts the choice and
says so in `message`; returning from a fallback device to the chosen one
also comes with a `message`.

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
  -> { noiseDb /* median background */, noiseHiDb, voiceLoDb, voiceDb /* median of speech windows */,
       voicePeakDb /* 95th pct of speech-window peaks */, snrDb /* voiceDb - noiseDb */, clipped,
       calibration: { noiseHiDb, voiceLoDb } | null,    // feed to gateThresholds(); null for novoice/clipping
       recommendedGain,                                 // min(target -20 dBFS RMS / voice, (-3 dBFS) / voicePeak,
                                                        //     noise cap so noiseHi × gain, less the expander range when
                                                        //     gateThresholds(calibration).enabled, <= -60 dBFS; the noise
                                                        //     cap never goes below 1), clamped 0.25..16;
                                                        //     currentGain unchanged for novoice/clipping
       limitedBy: 'target'|'peak'|'noise'|'max'|null, gateEnabled,
       voiceFaint /* ends > 4 dB under -20 dBFS */, roomQuiet /* noiseHiDb <= -50 */,
       status: 'ideal' | 'usable' | 'notready' | 'novoice' | 'clipping',
       headline,
       background: { level: 'good'|'warn'|'bad', title, advice },
       voice:      { level: 'good'|'warn'|'bad', title, advice },
       applied }                                         // e.g. 'Set your input volume to 140% and turned on room-noise blocking.'
export class SoundCheck extends Emitter {
  constructor(engine)
  start()        // 'progress' {phase:'countdown'|'background'|'voice', remainingMs, fraction (of this phase), instruction}
                 // returns false (and emits 'error') when the context isn't running or no microphone is open
                 // (engine.micInfo is null): measuring silence would blame the headset's mute switch
  cancel()       // 'cancelled'
  get running()
  // 'done' result; the caller applies gain + calibration
  // 'error' { message }   mic lost/switched off mid-check, or no meters for 2 s (context suspended)
}
export function buildDesktopFixPrompt(result | null) -> string   // v1's "copy desktop-fix prompt" (Windows mic settings task for Claude Code)
export function recordClip(track, ms, { mimeType, signal } = {}) -> Promise<Blob>   // the 8 s in-memory test clip
  // never stops `track`; aborting `signal` stops early and resolves with the clip so far
  // (rejects AbortError only if already aborted); rejects with a teacher-readable Error when nothing was caught
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
  -> { stream, videoTrack, audioTrack /* or null */, surface /* 'monitor'|'window'|'browser' */, label,
       width, height /* after fitting the preset */, nativeWidth, nativeHeight /* before */ }
  // getDisplayMedia({ video: { displaySurface: 'monitor', frameRate: { ideal: fps, max: fps }, width: { max: 3840 }, height: { max: 2160 }, cursor: 'always' },
  //   audio: systemAudio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false } : false,
  //   systemAudio: systemAudio ? 'include' : 'exclude', selfBrowserSurface: 'exclude', surfaceSwitching: 'include', monitorTypeSurfaces: 'include' })
  // Then videoTrack.contentHint = preset.contentHint and applyConstraints to fit outputSize(...) of the preset.
  // label is plain English: 'Whole screen', 'Window: <title>' / 'One window', 'Tab: <title>' / 'One browser tab'.
  // Chrome says just "Permission denied" both when the teacher closes the picker and when it refuses without
  // showing one, so: SecurityError, or NotAllowedError with policy/"disallowed"/"by system" wording, or a plain
  // NotAllowedError faster than 250 ms (nobody saw a picker) => 'blocked'; any other NotAllowedError => 'cancelled'.
  // NotSupportedError => 'unsupported'; anything else => 'failed'. The stream is stopped if anything fails after it was granted.
export async function openCamera(deviceId, { width = 1280, height = 720, fps = 30 } = {}) -> MediaStream
export async function listDevices() -> { mics: [{deviceId, label}], cameras: [{deviceId, label}] }   // labels may be empty before permission
export function onDeviceChange(fn) -> unsubscribe
```

### `compositor.js`

```js
export const BUBBLE_SIZES = { s: 0.2, m: 0.27, l: 0.35 }     // bubble diameter as a fraction of output height
/** Pure. Bubble placement in output pixels. bubble = {shape:'circle'|'rounded', size:'s'|'m'|'l', x, y (centre, 0..1), mirror} */
export function bubbleRect({ width, height }, bubble) -> { x, y, size }   // clamped fully inside the frame with a margin of 2% of height
export function isCompositingSupported() -> boolean        // MediaStreamTrackProcessor && MediaStreamTrackGenerator && OffscreenCanvas && VideoFrame
export class Compositor extends Emitter {
  constructor({ screenTrack, cameraTrack, width, height, fps, bubble })
  start() -> MediaStreamTrack        // video track to record
  setBubble(bubble)                  // live; a partial bubble is merged over the current one
  setCameraVisible(on)               // hide/show the bubble mid-take (the camera keeps clocking)
  setCameraTrack(track | null)       // swap or lose the camera mid-take; call with null BEFORE stopping a camera on purpose
  setScreenTrack(track)              // after surface switching; call BEFORE stopping the old screen track
  stop()                             // output track ends (with an 'ended' event); input tracks are never stopped
  get stats() -> { framesOut, fps }
  // 'warning' { message }
}
```
Clock: draw a frame whenever a **camera** frame arrives (≈30 fps) using the
latest screen frame; also draw when a screen frame arrives and no camera frame
came in the last 1000/fps ms (camera off, frozen or hidden). Output never
exceeds `fps` on average (a 60 fps camera is paced down). Screen frame is
letterboxed into width×height on black. Camera frame is centre-cropped to a
square, optionally mirrored, clipped to a circle or rounded square, with a
subtle 2px ring (at 1080p; scaled with output height). Close every `VideoFrame`
exactly once. Output frame timestamps must increase monotonically. If the
current screen track ends (teacher pressed "Stop sharing"), the compositor
stops itself so its output ends exactly like a raw screen track would. If the
camera track ends unexpectedly, the bubble disappears and a `'warning'` is
emitted. If `isCompositingSupported()` is false, the session records without
the bubble and tells the teacher why.

---

## Recording (`src/app/recording/`)

Tests: `test/unit/recording-*.test.mjs` (node: pure helpers, sinks, folder
store, takes list, and TakeRecorder driven by a scripted MediaRecorder) and
`test/e2e/recording.spec.mjs` (real MediaRecorder with the fake screen + mic;
every saved file is loaded into a `<video>` and seeked). Harness:
`test/e2e/harness/recording.entry.js`; an in-memory File System Access fake
(`FileSystemDirectoryHandle` with Chrome's write/close semantics, failure
injection) lives in `test/e2e/harness/recording-fakefs.entry.js` and is shared
by both.

### `recorder.js`

```js
export const TIMESLICE_MS = 1000, FIRST_CHUNK_TIMEOUT_MS = 5000, JOURNAL_UPDATE_MS = 2000, TICK_MS = 500
export class TakeRecorder extends Emitter {
  constructor({ id, videoTrack, audioTrack, options /* recorderOptions() */, sink, journal /* Journal|null */,
                meta /* {lessonName, filename, startedAt} */,
                timesliceMs?, firstChunkTimeoutMs?, updateIntervalMs?, now? /* injectable clock, tests */ })
  async start()                 // MediaRecorder.start(1000). Rejects with a teacher-facing message. A failed start has already
                                // aborted the sink, discarded the journal entry and released the lock, so the SAME id can be
                                // retried with another sink (session: folder -> memory).
  pause() -> boolean; resume() -> boolean   // false when not applicable
  addMarker(title?) -> { id, atMs, title } | null   // null unless 'recording'/'paused'; default title markerTitle(n)
  get state()                   // 'idle'|'recording'|'paused'|'stopping'|'stopped'|'failed'
  get elapsedMs()               // excludes paused time; frozen at the pause when stopped while paused
  get bytes(); get markers()    // markers are copies
  get id(); get mimeType() /* actual, after start */; get container(); get filename()
  get savingTo()                // 'folder' | 'memory' (becomes 'memory' when the folder fails mid-take)
  get safetyCopy()              // true while every chunk is reaching the journal
  get warnings(); get result()  // result: the TakeResult once stopped
  async stop() -> TakeResult    // rejects (state 'failed') only when nothing can be saved: err.code 'empty' (no data at all;
                                // the journal entry is removed) or no recoverable data (the journal entry is KEPT, so a
                                // reload offers it). Both messages are complete sentences for the teacher.
  async cancel() -> null        // stop, discard, delete partial file and journal entry
  // 'state'   {state, reason?}    reason on 'stopping': 'user' | 'share-ended' | 'error' | 'cancel'
  // 'tick'    {elapsedMs, bytes}  dataavailable + a 500 ms timer (the timer may throttle; that is fine)
  // 'warning' {message, code}     'no-journal' | 'journal-failed' | 'no-data' (first-chunk watchdog) | 'saved-elsewhere'
  //                               Warnings raised inside start() are emitted just after it resolves (setTimeout 0), so
  //                               listeners attached after `await start()` still get them.
  // 'error'   {message, fatal, code}
  //            fatal:false 'folder-failed' (+ savingTo:'memory'): the folder stopped working; recording carries on.
  //            fatal:true  'share-ended' | 'recorder-error': the recorder has ALREADY started stopping itself and keeps
  //                        everything; stop() returns that same promise.
}
/** TakeResult */ { id, filename /* final, after "(2)" */, container, mimeType, durationMs, size, markers, startedAt,
                    savedTo: 'folder'|'memory', blob /* when memory */, folderName /* when folder */,
                    warning /* '' or teacher-facing text, e.g. the folder failed so it was downloaded instead */,
                    endedBy /* null | 'share-ended' | 'error' */ }
export class Stopwatch                  // pure pause-aware clock: start/pause/resume/stop, elapsedMs; injectable now()
export function mergeChunks(...lists)   // pure: [{seq, blob}] / Map(seq -> blob) -> { parts (by seq, first copy wins), missing }
```
- Every chunk goes to the **journal first**, then the sink, each through its
  own promise chain (enqueued in that order; the sink never waits for
  IndexedDB, and a slow disk never reorders chunks). Empty chunks are
  skipped, so seq numbers run 0, 1, 2… without gaps.
- The journal failing (quota…) stops crash protection with a warning; the
  take continues. Folder takes then keep the chunks the journal didn't take
  in memory (and keep all of them when there is no journal), so a later
  folder failure still loses nothing.
- The folder failing mid-take or at finalize: the take is rebuilt from
  journal chunks ∪ in-memory chunks (by seq), its WebM Duration patched,
  `savedTo: 'memory'` with a `warning`, and the partial file removed.
- After saving: `savedTo 'folder'` => `journal.complete(id)`. `savedTo
  'memory'` with a complete journal => `journal.update(id, {elapsedMs,
  bytes, markers, filename})`, `complete(id, {keep: true})`,
  `prune({exceptId: id})`. Memory with an incomplete journal =>
  `complete(id)` (a partial copy must never pose as a safety copy). All of
  this happens before the lock is released.
- `journal.update` (progress + heartbeat) runs every ~2 s from both
  `dataavailable` and the tick timer (timers throttle in hidden tabs;
  MediaRecorder events don't), and immediately on pause, resume and marker.
- MediaRecorder gets the full options (mimeType, bitrates,
  `videoKeyFrameIntervalDuration`: MP4 only emits data at keyframes); if the
  browser refuses them, it retries with the mimeType alone. After `start()`
  the actual `recorder.mimeType` is reported. WebM pauses call
  `requestData()` first, so the journal is complete up to the pause.
- Expect the first media chunk within 5 s; if none arrives (and the take is
  not paused), warn ("Crash protection isn't working for this take…").
- If MediaRecorder errors, stops by itself, or the video track ends (screen
  sharing stopped from the browser bar), stop gracefully and keep what was
  recorded. Data arriving after stop is ignored; stop waits at most 10 s for
  MediaRecorder's `stop` event.
- Multi-tab safety: hold `navigator.locks.request(takeLockName(id), …)`
  (`'full-capture-take:' + id`) for the take's lifetime when Web Locks
  exist; `Journal.listPending()` then offers a take only if its lock can be
  acquired (`ifAvailable: true`), and falls back to the 10 s heartbeat rule
  otherwise.
- `stop()` and `cancel()` are idempotent and share one promise (whichever
  comes first wins).
- Duration comes from the recorder's own clock (performance.now, excluding
  pauses), not Date.now arithmetic. In Chromium the media timestamps also
  exclude pauses (verified by the e2e test via the file's tail).

### `sinks.js`

```js
/** Common interface */
//   kind                              'memory' | 'folder' (the recorder keeps an in-memory backup only for non-memory sinks)
//   async open({ filename, container, mimeType })
//   async write(blob)                 // in order, one at a time; rejects on failure (the recorder handles it)
//   async finalize({ durationMs }) -> { savedTo, size, blob?, filename, folderName? }
//   async abort()                     // delete partial output; safe to call twice
export const HEADER_LIMIT_BYTES = 2 MiB
export class MemorySink    // keeps Blob parts (Chrome pages large blobs to disk); finalize = new Blob(parts) then patchWebmBlob
                           // for WebM. get size.
export class FolderSink    // constructor(folderStore). Streams to a FileSystemWritableFileStream from folderStore.createFile().
                           // get filename (final name, read after open()), get folderName, get size, get durationPatchable.
                           // WebM: buffer the first chunks until prepareStreamingHeader() succeeds (NeedMoreData => keep
                           // buffering; give up after 2 MB, or on any other parse error, and write unpatched), write the
                           // prepared header, remember durationOffset; at finalize write encodeDurationPayload() at that
                           // offset ({type:'write', position, data}) before close(). A header that never completed is
                           // flushed unpatched at finalize.
                           // abort(): writable.abort() (discards Chrome's .crswap; close() if abort is missing), then
                           // folderStore.remove(name).
```

### `journal.js` (crash recovery)

```js
export const HEARTBEAT_STALE_MS = 10_000, TAIL_BYTES = 2 MiB
export const takeLockName = id => `full-capture-take:${id}`
export function isStale(meta, now = Date.now(), staleMs = 10_000)   // pure heartbeat rule (heartbeatAt, else startedAt)
export function blobTypeFor(meta)                                   // pure: meta.mimeType | v1 meta.mime | by container
export async function webmEndMs(blob) -> ms | null                  // last block timestamp in the final 2 MB
export async function buildRecording(parts, type, fallbackMs) -> { blob, durationMs }   // join + WebM Duration (tail, else fallback)
export class Journal {
  static async open() -> Journal | null
  async begin(meta /* {id, lessonName, filename, container, mimeType, startedAt} */)   // status 'recording'; clears old chunks of a reused id
  async append(id, seq, blob)       // row { id, seq, blob, size }
  async update(id, patch /* {elapsedMs, bytes, markers, ...} */)    // merges; also stamps heartbeatAt = Date.now()
  async complete(id, { keep = false } = {})
        // take saved. keep=false (saved into a folder): delete chunks + meta.
        // keep=true (handed to the browser as a download, which can't be confirmed): mark status 'downloaded'
        // and keep the chunks as a safety copy until prune().
  async prune({ exceptId } = {})   // delete every 'downloaded' take except exceptId (called after the next take is saved)
  async listPending({ staleMs = 10_000, useLocks = true } = {}) -> [{ meta, chunks, bytes }]   // newest first
        // status 'recording' and no tab is recording it: with Web Locks, its lock is free (so right after a crash);
        // without, heartbeatAt older than staleMs. Abandoned entries with no chunks are deleted.
  async listKept() -> [meta]       // 'downloaded' safety copies, newest first, so the library can offer "Download again"
  async getMeta(id) -> meta | null
  async chunks(id) -> [{ seq, blob }]
  async assemble(id) -> Blob       // chunks in seq order, typed; WebM gets its Duration from lastTimestampMs() of the tail
                                   // (falls back to meta.elapsedMs), via patchWebmBlob (header only)
  async assembleInfo(id) -> { blob, durationMs, meta }   // the same, plus the duration written (use it for the takes list)
  async discard(id)
  async estimate() -> { usage, quota } | null
}
/** meta row */ { id, lessonName, filename, container, mimeType, startedAt, status: 'recording'|'downloaded',
                  elapsedMs, bytes, markers, heartbeatAt, completedAt? }
/** v1 left unfinished recordings in IndexedDB 'lessonRecorderDB' (stores 'chunks' autoIncrement, 'meta' key 'current'
 *  = {name, mime, container, status:'recording', startTime, elapsedMs}). Checks indexedDB.databases() first so it never
 *  creates that DB (without databases(), an open that triggers upgradeneeded is aborted). discard() empties both stores,
 *  like v1's own finish (v1 may still be open in another tab, so the DB is not deleted). */
export async function findLegacyRecording()
  -> { meta, chunks, bytes, assemble: () => Promise<Blob>, assembleInfo: () => Promise<{blob, durationMs, meta}>,
       discard: () => Promise<void> } | null
```
Multiple pending takes are supported; starting a new take never deletes an
unrecovered one (v1 bug).

### `folder.js`

```js
export async function uniqueName(filename, exists /* name => bool|Promise */, { max = 999 } = {}) -> string  // pure: "name (2).ext"…
export function folderErrorMessage(error, folderName = '') -> string   // pure: teacher-facing text for a DOMException name
export class FolderStore extends Emitter {
  static isSupported()            // typeof showDirectoryPicker === 'function'
  async init() -> status          // load the persisted handle (kv 'folderHandle'), queryPermission({mode:'readwrite'})
  async refresh() -> status       // re-query the permission (e.g. before a take)
  get status()                    // 'unsupported' | 'none' | 'needs-permission' | 'ready'
  get name(); get handle()
  async choose() -> status        // showDirectoryPicker({ id: 'full-capture', mode: 'readwrite', startIn: 'videos' }); requests
                                  // permission if needed; persists (a handle that can't be stored still works this visit);
                                  // user gesture; AbortError when the teacher cancels
  async reconnect() -> boolean    // requestPermission({mode:'readwrite'}); user gesture
  async forget()
  async uniqueName(filename) -> string
  async createFile(filename) -> { handle, writable, name }   // never overwrites: picks "name (2).ext" if taken (case-insensitive
                                                             // on Windows, because the file system decides)
  async writeText(filename, text) -> name                    // sidecar files, e.g. chapters; REPLACES a file of that name
  async getFile(name) -> File | null
  async remove(name)                                         // a missing file is not an error
  async rename(oldName, newName) -> string   // final name (unique; a case-only change is allowed); FileSystemFileHandle.move()
                                             // when it works, else copy + remove (the original goes only after the copy closed)
  // 'status' { status, name }   (also when a different folder is chosen with the same status)
}
```
Errors thrown by `createFile`/`writeText`/`getFile`/`remove`/`rename` carry
a teacher-facing `message` (the DOMException `name` is kept, the original
is in `cause`). Without permission they throw `NotAllowedError` without
prompting.

### `takes.js`

```js
export function sortTakes(rows)           // pure: newest first, ties by id
export class TakesLibrary extends Emitter {
  static async open() -> TakesLibrary     // in-memory only if IndexedDB is unavailable
  get persistent()                        // false in memory mode (also after IndexedDB fails mid-session)
  async list() -> Take[]                  // newest first; copies
  async get(id) -> Take | null
  async add(take) -> Take; async update(id, patch) -> Take | null; async remove(id)
  // 'change' Take[]
}
/** Take */ { id, lessonName, filename, container, mimeType, durationMs, size, createdAt, markers, savedTo: 'folder'|'download', folderName, thumbnail /* small JPEG data URL or '' */ }
```

### Using it from `session.js`

- After `await recorder.start()`, take `savingTo` and `safetyCopy` from the
  recorder; on `'error'` with `code === 'folder-failed'` set the take's
  `savingTo` to `'memory'` (it's a warning-level event: the take goes on).
- `addMarker()` returns `null` once the take is stopping (e.g. sharing just
  ended): check before using the marker.
- `stop()` rejections already say what to do; show `e.message` as is.
- Show `result.warning` when set (or rely on the `'warning'` event with code
  `'saved-elsewhere'`, not both); `result.endedBy === 'share-ended'` covers
  the case where the recorder noticed the end of sharing first.
- Recovery: use `assembleInfo()` (journal or legacy) for the file *and* its
  duration, and `meta.markers` from `listPending()` for its chapters.

---

## Session (`src/app/session.js`)

Owns every subsystem; the UI only calls Session actions and renders Session
snapshots. Emits `'change'` with a fresh immutable snapshot after any change
(coalesced to one per microtask), `'meter'` with engine meter data (high
rate, not part of the snapshot), and `'notice'` for toasts
`{ id?, kind: 'info'|'success'|'warning'|'error', title, text, actions?: [{label, action, args?}], timeoutMs? }`
(`action` names a Session method).

Snapshot (`session.state`) — see `#buildSnapshot()` in session.js for the
exact shape. Main fields: `phase`, `countdown`, `audioStarted`, `screen`,
`mic {enabled, status, deviceId, label, devices}`, `audio {mode, speakers,
gain, gate, autoLevel, monitor, systemAudio, systemAudioLevel, calibrated,
calibration, checkStale, silent, clipping}`, `soundCheck {running, phase,
remainingMs, fraction, instruction, result, clipUrl}`, `camera`, `lesson
{name, format, quality, countdown, notes}`, `prefs {beeps,
floatingControls, hidePreview, shortcuts, noVoice, theme}`, `formats`,
`take {id, filename, elapsedMs, bytes, markers, savingTo, safetyCopy,
thumbnail, talkingWhilePaused}`, `review` (a TakeView, plus `endedBy:
'share-ended'|null`), `library` (TakeViews), `folder {supported, status,
name}`, `recovery`, `alerts`, `storage`, `estimate {bytesPerHour}`.

Mic statuses: `'off' | 'needs-permission' | 'starting' | 'live' | 'blocked'
| 'notfound' | 'busy' | 'lost' | 'error'`. The mic is opened at load only if
`navigator.permissions.query({name:'microphone'})` says `granted`; otherwise
status is `needs-permission` until `enableMic()` (from the "Turn on
microphone" click).

Actions: `init() firstGesture() enableMic()` · `chooseScreen() stopScreen()`
· `setMicDevice setAudioMode setSpeakers setGain setGate setAutoLevel
setMonitor setSystemAudio setSystemAudioLevel setNoVoice` · `startSoundCheck()
cancelSoundCheck() dismissSoundCheck() copyDesktopPrompt() copyFixSteps()` ·
`setCamera setCameraDevice setBubble` · `setLessonName setFormat setQuality
setCountdown setNotes setPref(key, value) resetSettings()` · `toggleRecord()
record() cancelCountdown() togglePause() stop() cancelTake() addMarker()` ·
`renameTake(id, lessonName) renameMarker deleteMarker chaptersFor
copyChapters saveChaptersFile openTake closeReview downloadTake deleteTake` ·
`chooseFolder reconnectFolder forgetFolder` · `recover discardRecovery` ·
`dismissAlert`.

## UX blueprint (from the UX audit; this is the design brief)

Three modes, one at a time, in a two-column layout (≥1000 px: a ~400 px
mode panel on the left, the stage on the right capped at ~55vh; <720 px:
one column, stage shrinks to a ~160 px strip, the primary button sticks to
the bottom of the viewport):

1. **Set up** (phases `setup`, `ready`, `countdown`): a numbered checklist.
   Each step shows a status chip (`To do` / `Done ✓` / `Needs attention`)
   and collapses to one summary line when done
   ("Microphone · Jabra headset · Sounds great · Change").
   1. *Lesson name*: "What's this lesson called?" Prefilled with the last
      name; a suggestion chip "Fractions – Week 4?" when the last name ends in
      a number; a "Will save as: …" preview; optional "Notes for yourself
      (shown while recording)" in a disclosure.
   2. *Microphone*: until permission is granted, a short explainer and a
      "Turn on microphone" button (no prompt on page load). Then: device
      picker (friendly labels, "(Windows default)"), a suggestion chip when a
      headset exists but isn't selected, a 3-zone level meter labelled
      "Too quiet | Good | Too loud" with a changing text label, and
      "Reduce background noise (recommended)" (Clean mode).
      **Check my sound** runs inline: "Get ready" → "Stay quiet (3 s)" →
      "Read this aloud" with the sentence in large type → a verdict card:
      "Sounds great – you're ready" (green) / "Usable – one tip below"
      (amber) / "We couldn't hear you" (red) / "Your mic is overloading"
      (red). One sentence + one action each; "Hear it back" plays the voice
      phase; "Check again". Changes are applied automatically and listed
      ("Mic level adjusted for your voice"). Amber/red results open
      "How to fix this in Windows" (Windows 11 / Windows 10 steps in plain
      language, "Copy these steps", and a secondary "Copy a prompt for
      Claude Code" that keeps v1's desktop-fix prompt). The step collapses to
      "Sound checked 14:02 · Sounds great · Check again"; if the mic, mode or
      level changes afterwards: "Settings changed – check again" (amber).
      Inline error cards per failure type, each with "Try again": blocked
      (how to allow in the address bar), not found (plug in a headset),
      busy (close Teams/Zoom), saved device missing (using the default).
   3. *Screen*: before picking: "If you'll play videos or sounds, switch on
      Share system audio in the next window." After: summary
      "Whole screen · 1920×1080" (or an inline warning for one window/tab),
      a chip "Computer sound: Included ✓" / "Not included – Choose again to
      include it", and, when `screen.isExtended`, "Move this window to your
      other screen – anything on the recorded screen appears in the video."
   4. *Camera bubble (optional)*: on/off, device, shape (circle/rounded),
      size (S/M/L), mirror, corner buttons; the bubble is draggable on the
      stage preview.
   Below the checklist: a readiness line ("✓ Microphone: Headset · ✓ Whole
   screen · Lesson: Fractions – Week 3", or "All set") and the one primary
   button **Start recording** (record red). It is never `disabled`: it uses
   `aria-disabled` and, when clicked early, focuses the first unfinished step
   with an inline explanation. During the countdown it reads "Cancel (3)".
2. **Recording** (phases `recording`, `paused`, `stopping`): the setup UI is
   hidden, not greyed. Lesson name, a state pill ("● Recording" /
   "❚❚ Paused" / "Saving…"), a 48 px tabular timer, "Safety copy: on", a
   mic meter with "We can hear you ✓" (and a "Computer sound" meter when
   included), buttons **Stop & save** (primary), Pause/Resume, "Add chapter"
   (with count), "Floating controls", and a text button "Discard take". The
   lesson notes are shown read-only. While paused, an amber full-width
   banner "Paused – not recording" with a big Resume, and "You're talking,
   but recording is paused – Resume?" when speech is detected for 5 s.
   The stage shows a still thumbnail by default ("Hide preview while
   recording", saves CPU and avoids a mirror-in-mirror effect).
3. **Review** (phase `review`): heading "Take 2 · 14 min 32 s · 412 MB",
   "Playing back" label on the stage, an editable name (renames the file
   when it lives in the folder), "Saved to Lessons › Fractions – Week 3
   (2026-10-08 14.32).mp4 ✓" or "Downloaded to your Downloads folder as …",
   chapter list with editable titles + "Copy YouTube chapters" (with the
   YouTube rule hints) + "Save chapters file", and actions: **Record another
   take** (primary), "Download a copy", "Delete take" (confirm), "Finish –
   stop sharing my screen". If sharing ended mid-take: "Recording stopped
   because screen sharing ended. Everything up to 23:14 is saved."

Below the main area, **Your takes**: this session's and earlier takes
(thumbnail, name, date, duration, size, chapters, where saved) with Play,
Download, Copy chapters, Delete.

Messages: (1) inline messages inside the step they belong to; (2) toasts
top-right (role=status, 5 s, pause on hover) for brief info; (3) sticky
banners at the top for critical states (role=alert: no sound, mic
disconnected, sharing stopped, storage low) and for recovery cards
("We found a recording that didn't finish – 'Fractions – Week 3', 8 Oct at
14:32, about 12 minutes. [Save it] [Delete it…]").

Off-screen feedback: `document.title` mirrors state ("● 12:34 Recording –
Fractions Week 3", "❚❚ Paused – …", "⚠ No sound! – …", "Starting in 3…"),
the favicon switches (neutral / red dot / pause / warning, drawn on a canvas),
and the **floating controls** (Document PiP) open automatically from the
Start click (setting "Show floating controls while recording", default on).

Settings (a `<dialog>`): File type (MP4 recommended / WebM smaller), Quality
(with expected size per hour), 3-2-1 countdown, countdown beeps, floating
controls, hide preview while recording, keyboard shortcuts, theme
(System/Light/Dark), save location (folder chosen / choose / forget), and
**Advanced**: use my mic's unprocessed sound (Studio), I'm using speakers,
mute the mic between sentences (gate; off by default), adjust my mic level
automatically, mic level slider, computer sound volume, record without my
voice, detailed meters (spectrum + dB values), reset all settings.

Vocabulary (use exactly): Start recording · Pause · Resume · Stop & save ·
Discard take (during recording) · Delete take (after saving) · Record
another take · Floating controls · Check my sound · Mic level.

Shortcuts (main window and floating controls; off while typing; listed in
Help and `aria-keyshortcuts`): **Alt+R** start / stop & save, **Alt+P**
pause/resume, **Alt+M** add chapter, **Esc** cancel countdown / close dialog.

Accessibility and look: landmarks (`header`, `main`), one `section
aria-labelledby` per step with an h2, `fieldset/legend` for option groups,
meters with `role="meter"` + aria-valuenow/valuetext, one visually hidden
`role=status` region and one `role=alert` region, focus moves to the verdict
heading / review heading / recovery card when they appear. Token palette
with checked contrast (light: record #c0392b, borders #86888d, muted text
#6b6d72, focus #1a5fd0; dark: text #ededee on #17181a, muted #a7a9ae, focus
#8ab4ff, red #ff6b5e). One primary button per view; type scale 14/16/20/28
+ 48 px timer; weights 400/600; 8 px grid; 8 px radius; one inline-SVG icon
set (`currentColor`); red only for recording. `@media (forced-colors:
active)` support; global reduced-motion block; targets ≥ 24 px (40 px for
main actions); visible 2 px focus ring with 2 px offset.

## UI contract (`src/index.html`, `src/styles/`, `src/app/ui/`)

Markup is static HTML with the ids below; `src/app/ui/*` binds it to the
Session. Dynamic items are cloned from `<template>`s in the markup. Designers
may add any wrappers, classes and decorative elements, but every id below
must exist exactly once with the stated role.

Conventions:
- Show/hide with the `hidden` attribute; CSS has `[hidden] { display: none !important; }`.
- `<html data-phase="setup|ready|countdown|recording|paused|stopping|review">`;
  CSS uses it to show `#viewSetup` / `#viewRecording` / `#viewReview`
  (JS also sets `hidden`, so either works). `<html data-theme="light|dark">`;
  absent = system.
- Step status: `section.step[data-status="todo|done|attention"]` plus
  `[data-collapsed]` when summarised.
- Meters: `.meter` element with `role="meter"`; JS sets CSS custom
  properties `--level` and `--peak` (0..1, mapped from −60..0 dBFS) and
  `data-zone="quiet|good|loud"`; the good band spans `--good-from: 0.53` to
  `--good-to: 0.8` (−28..−12 dBFS). Each meter has a text label element.
- Buttons that toggle use `aria-pressed`. Primary button disabled state =
  `aria-disabled="true"`.
- Dynamic text goes into `[data-field="name"]`; buttons in templates carry
  `data-action="name"`.
- No external resources (fonts, icons, CDNs). System font stack with
  "Segoe UI Variable", "Segoe UI", system-ui. Icons are inline SVG.

Required ids:

| Area | ids |
|---|---|
| Header | `btnFolder` (save-location chip), `btnSettings`, `btnHelp` |
| Live regions | `srStatus` (role=status), `srAlert` (role=alert) |
| Notices | `banners` (sticky critical + recovery), `toasts` (top-right) |
| Views | `viewSetup`, `viewRecording`, `viewReview` |
| Step 1 | `stepLesson`, `lessonChip`, `lessonName`, `lessonSuggest` (chip button), `fileNamePreview`, `notes` (textarea inside a disclosure) |
| Step 2 | `stepMic`, `micChip`, `micIntro` (explainer) containing `btnMicOn`, `micControls`, `micSelect`, `micSuggest` (chip button), `micMeter`, `micMeterLabel`, `noiseToggle` (checkbox), `micMessage` (inline message slot), `btnSoundCheck`, `scRun` (running panel: `scStep`, `scInstruction`, `scLine`, `scProgress`), `scResult` (verdict card: `scHeadline` with `data-status`, `scText`, `scTips`, `scApplied`, `btnScPlay`, `scAudio`, `btnScAgain`), `scFix` (`<details>` "How to fix this in Windows" with `scFixWin11`, `scFixWin10`, `btnScCopySteps`, `btnScCopyPrompt`), `micSummary` (collapsed line) |
| Step 3 | `stepScreen`, `screenChip`, `screenIntro`, `btnChooseScreen`, `screenSummary` (`screenLabel`, `screenDetail`), `sysAudioChip`, `screenMessage`, `screenTip` |
| Step 4 | `stepCamera`, `cameraChip`, `cameraToggle` (checkbox), `cameraControls`, `cameraSelect`, radios name `bubbleShape` (`circle`/`rounded`), radios name `bubbleSize` (`s`/`m`/`l`), `bubbleMirror` (checkbox), `btnCornerTL` `btnCornerTR` `btnCornerBL` `btnCornerBR`, `cameraMessage` |
| Start | `readiness`, `btnStart`, `startHint` |
| Stage | `stage`, `stageLabel` ("Live preview" / "Playing back"), `screenVideo`, `reviewVideo`, `stageThumb` (img), `stageEmpty` (contains `btnChooseScreenBig`), `bubblePreview` (contains `cameraVideo`), `countdown` (contains `countdownNum`), `stageHint` |
| Recording | `recBanner` (paused banner, contains `btnResumeBig`), `recLesson`, `recPill`, `recTimer`, `recSafety`, `recMicMeter`, `recMicLabel`, `recSysRow` (contains `recSysMeter`), `btnStop`, `btnPause`, `btnMarker` (contains `markerCount`), `btnPopout`, `btnDiscard`, `recNotes`, `recTalkingHint` |
| Review | `reviewHeading`, `reviewName` (input), `reviewSaved`, `reviewNotice`, `chapterList`, `chapterEmpty`, `chapterIssues`, `btnCopyChapters`, `btnSaveChapters`, `btnNewTake`, `btnDownloadTake`, `btnDeleteTake`, `btnFinish` |
| Library | `library`, `takeList`, `libraryEmpty` |
| Settings | `<dialog id="settingsDialog">`: `formatSelect`, `formatNote`, `qualitySelect`, `qualityNote`, `sizeEstimate`, `countdownToggle`, `beepsToggle`, `floatingToggle`, `hidePreviewToggle`, `shortcutsToggle`, `themeSelect` (`system`/`light`/`dark`), `folderStatus`, `btnChooseFolder`, `btnForgetFolder`, `advancedAudio` (`<details>`) with `rawMicToggle`, `speakersToggle`, `gateToggle`, `autoLevelToggle`, `gainSlider` (range 25–1600, percent), `gainLabel`, `sysAudioLevel` (range 0–150), `noVoiceToggle`, `detailMeters` (`<details>`) with `spectrum` (canvas), `statFloor`, `statVoice`, `statSnr`, `statPeak`; `btnResetSettings`, `btnSettingsClose` |
| Help | `<dialog id="helpDialog">` with `btnHelpClose` (shortcuts + how it works) |
| Confirm | `<dialog id="confirmDialog">` with `confirmTitle`, `confirmText`, `btnConfirmCancel` (default focus), `btnConfirmOk` (danger style) |

Templates (`<template id>`; fields by `data-field`, buttons by `data-action`):
- `tplToast`: root `.toast[data-kind=info|success|warning|error]`; fields `title`, `text`; `[data-actions]` container; action `dismiss`.
- `tplBanner`: root `.banner[data-kind]`; fields `title`, `text`; `[data-actions]`; action `dismiss`.
- `tplMessage`: inline step message, root `.message[data-kind]`; fields `title`, `text`; `[data-actions]`.
- `tplTake`: root `.take`; fields `thumb` (img), `name`, `date`, `duration`, `size`, `chapters`, `saved`; actions `open`, `download`, `copy-chapters`, `delete`.
- `tplChapter`: root `.chapter`; field `time`; input `[data-field="title"]`; action `delete`.
- `tplPopout`: the floating controls' whole body (rendered into the Document PiP window, whose `<body>` gets class `popout` and the theme attribute; its CSS lives in the main stylesheet under `.popout`). Fields `pill`, `timer`, `lesson`, `micLabel`, `notes`, `countdown`; a `.meter` with `data-field="meter"`; actions `start`, `stop`, `pause` (text Pause/Resume), `marker`, `more` (reveals discard), `discard-yes`, `discard-no`; containers `[data-part="idle|active|confirm|nosound"]` toggled with `hidden`. A "NO SOUND" state turns the whole window red.

Phase → view: `setup`/`ready`/`countdown` → `viewSetup`; `recording`/`paused`/`stopping` → `viewRecording`; `review` → `viewReview`.
