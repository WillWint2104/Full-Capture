# Audit of v13 (lesson-recorder_13.html)

Five parallel audits (state machine, audio, recording reliability, UX, features) of the legacy app, with every bug finding checked by an independent skeptic. This is the synthesized brief that shaped v2.

# Lesson Recorder v2: Rebuild Brief

**For:** the engineer designing v2.
**Sources:** `legacy/lesson-recorder-v13.html` (2,185 lines, read in full) and the five-part audit: state bugs, audio, reliability, UX and features. Finding ids are in brackets. The state, audio and reliability findings were checked in the code, and several were reproduced in Chromium 141. The UX and feature findings are design proposals and have not been tested.

**Rules v2 must never break:**
1. Never lose a lesson, and never spoil one without telling the teacher.
2. Wherever the teacher is looking, they can tell whether they are being recorded and heard.
3. It ships as one self-contained HTML file that opens from `file://` with no network.

---

## 1. Top problems (ranked by harm to the teacher)

1. **A whole lesson can be recorded with no voice and no warning.** Record works while the mic is off, blocked or still opening. Choose screen clears the "blocked" message, and the silence watchdog never starts. [no-audio-track-silent-record, mic-not-ready-at-record, mic-checkbox]
2. **Alarms appear where the teacher is not looking.** They go to an error bar under the preview, and the pop-out is optional with 13px text. The watchdog also listens after the noise gate, so it false-alarms on any pause over 6 s, yet it misses a dead mic that only gives low hiss, and it is switched off when the mic is off. [no-feedback-off-screen, silence-watchdog-unreliable, watchdog-false-alarm]
3. **Starting a new take wipes the whole crash store**, which deletes an unrecovered lesson. Recover and Discard act on whatever is "current", including a live take. A second tab shares the same storage slot. [new-take-wipes-unrecovered, recovery-wiped-by-new-take, shared-store-multi-tab, multi-tab-recovery]
4. **"Saved ✓" is shown, and the crash copy deleted, before anything confirms the file reached disk.** A cancelled Save As or a blocked auto-download loses the lesson. The close-tab warning (beforeunload) stops at Stop. [saved-before-download-confirmed, saved-before-confirmed, review-save-confusion]
5. **There is no stopping/saving state.** Double-clicking Stop arms a new take. During a long WebM save, the old save code then wipes the new take's journal, orphans its recorder and mixes two takes' chunks into one corrupt file. [stop-reentrancy-race, finalize-window-race]
6. **The default MP4 output only emits data at keyframes, and no keyframe interval is set.** A slide lesson can journal nothing beyond the 1.2 KB init segment, so MP4 crash recovery can come back empty. [mp4-fragments-only-at-keyframes]
7. **Wrong mic, or lost mic.** There is no device picker, so the app records the Windows default, often the webcam mic. Unplugging or muting is not handled, so the rest of the lesson records silence while the UI says "live". [no-mic-device-selection, no-mic-device-picker, mic-hot-unplug, mic-track-ended-unhandled]
8. **The noise gate does harm in both directions.** It is on by default with uncalibrated absolute thresholds, so it mutes soft speech. It cuts the start of words, chatters in rooms under about 21 dB SNR, and silently turns itself off whenever the tab is hidden, which is the pop-out workflow. [uncalibrated-gate-default-on, gate-on-main-thread-raf, gate-hidden-failopen, gate-dynamics, gate-calibrated-thresholds-collapse]
9. **Setup controls stay live during a take.** Choose screen during the countdown stops the video track being recorded. Sound check and "Lock in" change gain and gate mid-lesson. Listen gets recorded a second time through the system-audio loopback. [choose-screen-during-take, soundcheck-during-recording, live-controls-during-recording, listen-during-recording, system-audio-captures-monitor]
10. **WebM save reads the whole file into memory to patch about 200 header bytes.** Above about 2 GB it fails silently and the file has no Duration. At 1 GB it stalls about 13 s and uses about 3× the file size in RAM. Recovery does the same. [finalize-whole-file-arraybuffer, recovery-path-validity]
11. **There is no guided flow.** About 19 controls sit on one screen, with a dead red button and no reason given, audio-engineering jargon, and alerts below the fold. Cancelling the screen picker says "blocked… download this file". [no-guided-flow, record-disabled-unexplained, jargon, responsive-fold, picker-cancel-misclassified]
12. **The sound check measures 8-bit rounding, not the room.** Any noise floor below about −45 dBFS reads as −45, so good headsets get "a bit noisy" or "NOT READY". Clipping at the input is never detected, and the +12 dB gain cap fails normal headsets. [byte-quantized-measurements, soundcheck-gain-math, no-input-clip-detection]
13. **System audio is added to the voice at full level** with no limiter, trim, ducking or meter, so talking over a clip clips the file. Nothing says whether computer sound was captured at all. [no-limiter-system-mix, system-audio-visibility]
14. **"Discard take" in the pop-out opens a blocking `confirm()` in the main window**, often on the other screen. That freezes the pop-out timer, the gate and the crash-copy writes. [pip-discard-confirm, confirm-dialogs]
15. **Durations use the wall clock.** The timer keeps counting while paused, and Stop-while-paused writes a Duration that includes the pause into the file and the recovery data. [pause-timing, duration-wallclock-and-pause]

---

## 2. Must-keep behaviours of v1

- **Delivery:** one file, opens from disk, nothing uploaded. Chrome/Edge only, with a plain message on unsupported browsers.
- **Next take is one click:** the screen share stays live between takes, so "Record another take" needs no re-pick.
- **Screen picking:** the picker is hinted towards a whole monitor (`displaySurface: 'monitor'`). Picking one window or tab is allowed but gets a warning.
- **Sharing stopped from Chrome's bar:** the take ends gracefully and everything recorded so far is kept.
- **Countdown:** 3-2-1 is on by default, and pressing the main button during it cancels.
- **Pause and discard:** Pause/Resume works. Discarding a take asks first and states how many minutes will be lost.
- **Files:** the lesson name and date make the file name. MP4 is used when the browser can record it, otherwise WebM. WebM files get a Duration so players can seek.
- **Mic setup:** Chrome's automatic gain control is off because the app does its own levelling; mono, 48 kHz preferred. Clean mode (Chrome noise suppression) is the default; Studio (raw mic) stays as an opt-in.
- **Guided sound check:** keep the flow (quiet room, then read a line aloud), the single readiness verdict, and the advice that names the cause: faint voice vs noisy room vs mic hiss or Windows "Microphone Boost", "a hand-span from the mic". Settings are applied automatically. **Keep the advice text; replace the measurement.**
- **Test clip:** the 8 s clip lives only in memory and plays back inline. In v2 it becomes "Hear it back".
- **Listen:** hearing yourself, with the headphones warning, as a tool used before recording.
- **Fail-open safety:** every take starts with the voice path open, and every automatic process fails open rather than muting.
- **Alerts in the pop-out:** the silence alarm and the floating controls (Document Picture-in-Picture) with timer, start/stop, pause, discard and the state words READY / PICK SCREEN / STARTING / RECORDING / PAUSED / NO AUDIO.
- **Crash protection:** an IndexedDB chunk journal at 1 s intervals, a recovery offer on the next open, and the beforeunload warning.
- **One audio track:** system audio and voice are mixed into a single track, which is what YouTube and editors expect.
- **Review:** the finished take shows name, duration, size and inline playback.
- **Look:** Segoe UI, tabular-number timer, red only for recording, warm paper background.
- **v1 crash copies:** on first run, v2 must detect and offer any unrecovered v1 recording in IndexedDB `lessonRecorderDB` (stores `chunks`, `meta` key `current`) before anything else writes to storage.

---

## 3. Feature set

### MUST (v2.0 does not ship without these)

| Feature | Why | APIs |
|---|---|---|
| **Single state machine:** `setup → ready → countdown → recording ⇄ paused → stopping → finalizing → review`. Each take is its own object (recorder, chunks, clock, journal id, abort flag). Events carrying an old take id are ignored. Every control's enabled state is derived from the state. Clicks within 400 ms of a state change are ignored. | Removes the whole race, orphan and mid-take-change family (#5, #9, test-recorder-stale-handlers, setupmic-reentrancy, pip-double-open, start-failure-armed-ui) | — |
| **Audio is a precondition for recording:** Record needs a live mic track and an AudioContext in the `running` state. "Record without my voice" is a deliberate setting with a permanent "Voice off" chip. | #1 | `AudioContext.state`, `statechange`, `track.readyState` |
| **Mic picker:** remembered, reacts to plug/unplug, handles track `ended`/`mute`, mic shown by name everywhere. The record track never changes. | #7 | `enumerateDevices`, `getUserMedia({deviceId:{exact}})`, `devicechange`, track `ended`/`mute`/`unmute` |
| **AudioWorklet DSP engine** (see §4): float metering, expander, compressor, leveler, limiter and health checks, all on the audio thread. | #2, #8, #12, #13; keeps working while the tab is hidden | `audioWorklet.addModule('data:application/javascript;base64,…')`, `MessagePort` |
| **Rebuilt sound check** with clip detection and "Hear it back". Calibration is saved per device and mode. | #12; no re-check every day | worklet stats, `MediaRecorder` (audio), `localStorage` |
| **Save straight into a chosen folder while recording**, with Downloads as the fallback. | #4, #10; files land in the course folder | `showDirectoryPicker`, handle kept in IndexedDB, `queryPermission`/`requestPermission`, `createWritable`, `write({type:'write', position})` |
| **Per-take crash journal**, a recovery card, and import of v1 crash copies. | #3, #6 | IndexedDB, Web Locks (`navigator.locks`), `BroadcastChannel`, `storage.persist()`/`estimate()` |
| **Feedback away from the main window:** floating controls open automatically from the Start click; the tab title and favicon show state; alarms appear inside the floating window. | #2 | `documentPictureInPicture.requestWindow`, `document.title`, canvas → `data:` favicon |
| **Correct timing and duration patching:** a pause-aware `performance.now()` clock and a header-only WebM patch. | #10, #15 | `Blob.slice`, positional writes |
| **Verified recording format:** probe explicit codec strings, preflight the encoder, set a keyframe interval, read back the type actually used. | #6; never ship VP9-in-MP4 labelled "editor-friendly" (mp4-mime-detection) | `isTypeSupported`, `recorder.mimeType`, `videoKeyFrameIntervalDuration` |
| **Capped capture:** 1080p30 by default, with bitrate worked out from the real capture size. | Fixes 5 Mbps spread over 4K (bitrate-vs-resolution) | `getDisplayMedia` max constraints, `applyConstraints`, `contentHint='detail'` |
| **Computer sound:** a captured / not captured chip, trim, ducking, limiter and meter. Listen is forced off from countdown to review. | #9, #13 | `getDisplayMedia({audio, systemAudio:'include'})`, `restrictOwnAudio` (feature-detected) |
| **In-page confirmations only**, no `confirm()`: a modal dialog in the main page and an inline two-step confirm in the pop-out. | #14 | `<dialog>.showModal()` |
| **Precise error messages:** each mic failure type and each screen-capture failure type gets its own plain message. | #11; mic-error-types | `DOMException.name`, `window.top !== window`, `document.featurePolicy?.allowsFeature('display-capture')` |
| **Separate, keyed notices** derived from state (no single shared error slot). | shared-error-bar | — |
| **Settings remembered** between visits. | settings-persistence | `localStorage` with a `fullcapture.v2.` prefix, every access in try/catch (all `file://` pages share one origin) |
| **Close-tab warning** while recording, paused, stopping, finalizing, or while any take's save is unconfirmed. | #4 | `beforeunload` |
| **Accessibility and theme baseline:** live regions, meters exposed as `role=meter`, focus management, checked contrast tokens, light and dark themes, Windows contrast themes, reduced motion. | Cheap if built in from day one, costly to retrofit | ARIA, `prefers-color-scheme`, `forced-colors`, `prefers-reduced-motion` |

### SHOULD (v2.0 if it fits, otherwise v2.1)

| Feature | Why | APIs |
|---|---|---|
| **Webcam face bubble** composited into the video: circle or rounded square, S/M/L, four corners plus drag, mirror, "Hide camera" in the pop-out. | The main reason teachers pick Loom and similar tools | `MediaStreamTrackProcessor`/`Generator` (main thread only), `OffscreenCanvas` 2d, `VideoFrame`. Only when `isCompositingSupported()` is true and the performance check passes (§7). |
| Chapter button (Alt+M, pop-out), "Copy YouTube chapters", `.chapters.txt` file next to the video | Students revise by section | journal-persisted markers, `FolderStore.writeText` |
| Takes library: metadata and thumbnails in IndexedDB; play directly from the folder file | Compare takes, re-download, delete bad ones | IndexedDB, `getFile()`, `removeEntry`, `FileSystemFileHandle.move` |
| Quality presets with "≈ X GB per hour": Standard 1080p30, Sharp 1440p30, Smooth 1080p60, Small 720p30 | Text sharpness vs file size | `applyConstraints`, `contentHint` |
| Mute-mic button during a take (20 ms ramp; watchdog reminder after 30 s muted) | Coughs, knocks, interruptions | `GainNode.setTargetAtTime` |
| Shortcuts Alt+R / Alt+P / Alt+M / Esc in both windows | Speed; keyboard-only users | `keydown` on `window` and `pipWin.document` |
| Paused reminder: banner, title, and "You're talking but recording is paused" after 5 s of speech | paused-reminder | worklet `speech` flag |
| Health strip: file growth, chunk stall, storage, CPU pressure, dropped frames | recording-health | `storage.estimate`, `PressureObserver`, `MediaStreamTrack.stats` |
| Keep the screen awake during takes, plus a "plug in your laptop" warning | wake-lock | `navigator.wakeLock`, `getBattery()` |
| Lesson notes shown in the pop-out | Teaching from a plan | Document PiP |
| Privacy prep: Do Not Disturb reminder, exclude this tab from the picker, second-screen tip | privacy, pip-in-recording | `selfBrowserSurface:'exclude'`, `screen.isExtended`, `CaptureController.setFocusBehavior` |
| Camera-only mode | Welcome videos, spoken feedback | `getUserMedia` video |
| Countdown digits in the pop-out, plus optional beeps through the headphones only | recording-cues | separate path to `ctx.destination` |
| Listen output sent to the headset | Avoid speaker feedback | `AudioContext.setSinkId` |

### LATER

- Lossless start/end trim: WebM first by dropping whole clusters at 2 s keyframes, then MP4 by dropping fragments.
- Headset and keyboard media keys (`navigator.mediaSession`; needs a silent `<audio>` playing).
- Thumbnail/poster export; a "Copy for YouTube / Classroom" helper.
- Target length and "Finish & start Part 2".
- Region crop and zoom, privacy masks, title card and logo, camera saved as a separate file.
- Cues and SeekHead in WebM for faster seeking in long files.
- Mains hum detection with matching notches.
- A draft transcript, only when `SpeechRecognition` reports `processLocally` is available.

**CUT** (say so in Help): cursor highlights and click effects, drawing over the desktop, background blur and virtual backgrounds, system-wide hotkeys, upload/OAuth/share links, any "offline captions" claim, a multi-track editor.

---

## 4. Audio pipeline

### Context and microphone

- **AudioContext:** one per session, `new AudioContext({sampleRate: 48000, latencyHint: 'interactive'})`. Create or resume it inside the first user gesture ("Turn on microphone" or "Get started"). If mic permission is already `granted`, create it right after `getUserMedia` resolves; it then starts running (this is why the audioctx-suspended finding was refuted). Await `resume()`. Watch `statechange`: if the context is not running, Record is blocked, or during a take an urgent "Click here to restart sound" alert appears.
- **Mic constraints:** `{deviceId:{exact}, channelCount:{ideal:1}, sampleRate:{ideal:48000}, autoGainControl:false}`.
  - **Clean (default):** `noiseSuppression: true, echoCancellation: false`.
  - **Studio** ("Use my mic's unprocessed sound"): both false.
  - **"I'm using speakers"**: `echoCancellation: true`, and Listen is disabled.
  - Read back `track.getSettings()` and show what is actually active.

### Signal graph

Built once. Only the sources upstream ever change.

```
mic track --> MediaStreamSource --> [voice] AudioWorklet --> micMute GainNode --> [mix] input 0
                                         |
                                         +--> monitorGain (0/1) --> ctx.destination   (Listen; forced 0 from countdown to review)
system-audio track --> MediaStreamSource -----------------------------------> [mix] input 1
[mix] AudioWorklet --> MediaStreamAudioDestinationNode (2 ch) ==> recordTrack
```

- **`recordTrack` is created once per session.** Every take and every test clip records it.
- A device swap, a reconnect after unplugging, a mode change, mute, or adding or removing system audio only reconnects source nodes. The recorder never sees a new track.
- Old nodes are always `disconnect()`ed (fixes audio-node-leaks and graph-node-leaks).

### `voice` processor, in order

1. **Raw input stats (before anything else):** float block RMS and sample peak; clip count (|x| ≥ 0.98); run length of exact zeros (digital silence); DC stuck at a constant value.
2. **High-pass, Studio only, inside the worklet:** two biquads at 80 Hz, linear Q 0.541 and 1.307 (4th-order Butterworth, no resonance). Doing it here, not as native nodes in front of the worklet, keeps step 1 measuring the true raw input. No fixed 100/120 Hz notches. Clean mode is already high-passed by Chrome.
3. **Detector sidechain:** a band-limited copy (150 Hz–4 kHz), RMS over 10 ms windows. It drives voice detection and the expander, never the meters.
4. **Lookahead delay** of 5 ms on the audio path only.
5. **Trim** (the sound-check gain): −12 to +24 dB (×0.25 to ×16), smoothed over 50 ms. Never written as a step to `.value`.
6. **Expander** ("Mute the mic between sentences": Advanced, off by default):

   | Parameter | Value |
   |---|---|
   | Open threshold | max(noiseHi + 6, voiceLo − 6) dB |
   | Close threshold | open − 6 dB |
   | Attack | 2 ms |
   | Hold | 250 ms, restarted whenever the detector is above the close threshold |
   | Release | 150 ms |
   | Range | −18 dB (never full silence) |

   It is bypassed (fails open) when the mic is uncalibrated, when the calibration is stale, or when voiceLo − noiseHi < 8 dB.
7. **Compressor:** RMS detector, threshold −20 dBFS, ratio 3:1, 6 dB knee, attack 10 ms, release 150 ms, **no makeup gain**. This replaces the native compressor node, which adds about 7 dB of hidden makeup gain.
8. **Leveler** ("Adjust my mic level automatically", opt-in): only moves during speech, targets −20 dBFS RMS, 4 s time constant, limited to ±6 dB around the trim, frozen between phrases.
9. **Output meter.**

**Port message every 1920 frames (40 ms, 25 per second)** with `{raw:{rmsDb, peakDb, clips, zeroRunMs}, voice:{rmsDb, peakDb}, speech, gateGainDb, compGrDb, levelerDb, t}`. Levels are in dBFS with a −100 floor. These messages keep arriving while the tab is hidden. They drive every meter, the health checks and the pop-out timer. `requestAnimationFrame` is used only for drawing on the visible page.

### `mix` processor

- **Input 1 (system audio):** delayed 5 ms to line up with the voice lookahead.
- **System trim:** default −6 dB (×0.5); user range 0–150%.
- **Ducker:** keyed on voice activity (input 0 above −45 dBFS RMS in 10 ms windows, 250 ms hold). Duck −10 dB, attack 50 ms, release 400 ms.
- **Sum.**
- **Limiter:** 5 ms lookahead brickwall, −1 dBFS sample-peak ceiling, about 80 ms release, hard clip at the ceiling as the last safety.
- **Meter:** mix peak with a latched clip indicator, limiter gain reduction, system peak before trim, and final-bus digital silence.
- **Latency:** voice and system paths both carry 10 ms, so they stay aligned.

### Health checks

| Condition | Source | Response |
|---|---|---|
| Mic track `ended`, or a `devicechange` that removes the active device | track / mediaDevices events | Immediately: "Microphone disconnected" banner and red pop-out. Try the same deviceId, then the same label, then ask the teacher. Never switch to a different named mic without saying so. |
| Track `mute` | track event | "Your mic is muted (Windows or headset switch)" |
| Raw exact zeros for ≥ 1.5 s while the mic is on | voice worklet | Urgent: "Your mic stopped sending sound" + Reconnect |
| No speech for 60 s during a take | `speech` flag | Soft pop-out hint only. Never red, never "start a fresh take". |
| Final-bus digital silence for ≥ 3 s with the mic on | mix worklet | Urgent. Catches graph or context failures. |
| Raw clips | voice worklet | Amber "Your mic is overloading", latched for 2 s |

### Sound check

- **Driven by** port messages, not animation frames.
- **Phases:** Get ready 3 s, then Stay quiet 3 s, then "Read this aloud" 6 s with the sentence in large type. The voice phase is recorded from `recordTrack` for "Hear it back", in its own object with an `AbortController`. Handlers are detached before `stop()`, which fixes test-recorder-stale-handlers.
- **Analysis over 40 ms windows:**
  - noiseMed = median of the background windows; noiseHi = 95th percentile.
  - Voice windows = windows ≥ noiseMed + 6 dB. If fewer than 20% of the voice phase qualifies, the result is **novoice**.
  - voiceLo = 20th percentile of voice windows; voiceMed = median; voicePeak = 95th percentile of window peaks.
  - Any raw clip during the voice phase gives **clipping**, with the "lower Windows input / turn off Microphone Boost" advice.
- **Gain** = min(−20 − voiceMed, −3 − voicePeak, noise cap) dB, clamped to −12…+24 dB.
  - The noise cap keeps noiseHi + gain (+ expander range when the expander is on) at or below −60 dBFS. It never pushes the gain below 0 dB.
- **Verdict:**

  | Status | Rule |
  |---|---|
  | ideal | SNR (voiceMed − noiseMed) ≥ 20 dB and the target is reachable |
  | usable | SNR 12–20 dB, or more than +18 dB of gain needed |
  | notready | SNR < 12 dB |
  | faint | target not reachable within 4 dB at +24 dB of gain |

  "Faint" is judged on the resulting SNR and noise, never on a gain ceiling.
- **Calibration record:** `{deviceId, label, mode, settings, date, noiseMedDb, noiseHiDb, voiceLoDb, voiceMedDb, voicePeakDb, gainDb}`, keyed `deviceId|mode`, with the device label as a fallback.
  - It goes stale when the device, mode or sample rate changes. The UI then says "Settings changed – check again", the expander is bypassed, and the gain falls back to the last value saved for that device and mode.
  - A novoice result never overwrites the previous result's export data (fixes stale-lastcheck).
- **Locked during takes:** sound check, gain changes beyond a ±6 dB "Mic level" stepper, mode, device and Listen are all locked from countdown start until review. A check that is running is cancelled cleanly when the countdown starts (soundcheck-ui-stuck).

---

## 5. Recording and output pipeline

### Container and codec

1. **MP4 (H.264 + AAC-LC) is the default** when an explicit `avc1…,mp4a.40.2` string is supported.
   - Try High (`avc1.6400LL`), then Main (`avc1.4D40LL`), then Constrained Baseline (`avc1.42E0LL`).
   - Pick the level LL to match the output: 3.1 (`1F`) for 720p30, 4.0 (`28`) for 1080p30, 4.2 (`2A`) for 1080p60, 5.0 (`32`) for 1440p30.
   - **Never accept bare `video/mp4`.** In Chromium it returns VP9/Opus inside MP4.
2. **Encoder preflight:** once per screen pick, record the real tracks for 2 s off-screen with the chosen options. Require at least one media fragment, read `recorder.mimeType`, and parse the avcC profile from the init segment. This catches the case where `isTypeSupported` passes but encoding fails, and machines whose fallback encoder (openh264) only does Constrained Baseline.
3. **Fallback to WebM** `vp9,opus`, then `vp8,opus`. The "works in editors" label appears only for avc1 + mp4a. On N/KN editions of Windows without H.264/AAC, the Review screen says so in one line.
4. **MediaRecorder options:** `start(1000)` and `videoKeyFrameIntervalDuration: 2000` for both containers. Without the interval, MP4 only emits data at keyframes. Creating and starting the recorder sit in one `try`; the journal session begins only after `start()` succeeds. `onerror` saves what exists and tells the teacher in plain words.

### Capture and bitrates

- **getDisplayMedia options:** `{video:{displaySurface:'monitor', frameRate:{ideal:fps, max:fps}, width:{max}, height:{max}}, audio:{echoCancellation:false, noiseSuppression:false, autoGainControl:false}, systemAudio:'include', selfBrowserSurface:'exclude', surfaceSwitching:'include', monitorTypeSurfaces:'include'}`. Then `applyConstraints` to fit the preset, set `contentHint`, and read back `getSettings()`. Don't pass `cursor`: Chromium does not support it.
- **Video bitrate** = 0.08 bits per pixel per frame for 30 fps and 0.06 for 60 fps, taken from the **actual** settings. Audio is 128 kbps (AAC or Opus, stereo, because clips may contain music).

  | Preset | Capture | Video bitrate | Size per hour (upper bound) |
  |---|---|---|---|
  | Standard (default) | 1080p30, `detail` | ≈ 5.0 Mbps | ≈ 2.3 GB |
  | Sharp | ≤ 1440p30, `detail` | ≈ 8.8 Mbps | ≈ 4.0 GB |
  | Smooth | 1080p60, `motion` | ≈ 7.5 Mbps | ≈ 3.4 GB |
  | Small | 720p30, `detail` | ≈ 2.2 Mbps | ≈ 1.0 GB |

- **No 4K capture.** It costs CPU, smears text at these bitrates and fills disks.
- While recording, show the measured bytes per second, because the bitrate is a variable target and screen content usually comes in smaller.

### How files reach disk

- **Primary: a folder chosen by the teacher.**
  - `showDirectoryPicker({id:'full-capture', mode:'readwrite', startIn:'videos'})`. The handle is stored in IndexedDB.
  - On load, call `queryPermission`. If it returns `prompt`, the header chip reads "Reconnect to Lessons folder" and becomes a readiness item. Re-granting happens there, **not** in the Start click, which needs its user activation to open the pop-out (see §7).
  - Per take: `getFileHandle(uniqueName, {create:true})`, then `createWritable()` (never `keepExistingData:true`). Chunks are written strictly in order through one promise chain. On stop, write the duration patch at its remembered position, then `close()`.
  - **A take is "saved" only after `close()` resolves.**
  - If a write fails (disk full, permission revoked), keep recording to the journal and memory, show a plain alert, and build the file from the journal at the end.
- **Fallback: Downloads.**
  - Blob parts are kept in memory (Chrome pages large blobs to disk). At the end, apply the header-only patch and trigger the download once, close to the Stop click so the click's user activation still applies.
  - Status reads "Download started – check your Downloads bar", with **[Got it]** and **[Download again]**. Never "Saved ✓".
  - The journal copy stays in a `downloaded` state until the teacher clicks Got it, deletes the take, or the copy is older than 7 days **and** storage is tight. Never revoke the object URL of an unconfirmed take.
- **File names:** `{Lesson} - {YYYY-MM-DD} - Take {n}.{ext}`, with n counting that lesson's takes that day. Keep Unicode letters. Strip only `<>:"/\|?*`, control characters, trailing dots and spaces, and reserved names (CON, PRN, AUX, NUL, COM1–9, LPT1–9). Cap at 120 characters. An empty name becomes "Lesson". Append " (2)" on collision. Side files (chapters, notes) follow the video's name.

### Crash recovery

- **Journal per take id:**
  - IndexedDB stores: `journalMeta` keyed `id`, `journalChunks` keyed `[id, seq]`.
  - Each chunk is appended **before** it is written to the folder or memory.
  - Meta is updated every 2 s and on pause or marker: `{elapsedMs (pause-aware), bytes, markers, heartbeatAt}`.
  - Read-modify-write and begin/finish each run in one transaction across both stores. A failed or closed DB connection is reopened (idb-helper-atomicity).
- **Live takes are never offered for recovery:** hold `navigator.locks.request('full-capture-take:'+id)` for the take's lifetime. A take is offered only if its lock can be acquired; without Web Locks, only if its heartbeat is more than 10 s old. A `BroadcastChannel` shows "Lesson Recorder is already open in another tab".
- **Nothing is ever cleared wholesale.** Starting a take never touches another take's rows. Recovery cards stay pinned above Set up until the teacher chooses **[Save it]** or **[Delete it…]** (confirm, stating the minutes). Recovery actions are disabled during a take.
- **Recovery assembly** streams chunks in batches into a new folder file, or into a Blob for the Downloads path. There is never a whole-file `arrayBuffer()`.
  - Name: `{Lesson} - {start date} - Take {n} (recovered).{ext}`.
  - The journal rows are deleted only after the file is confirmed: `close()` resolved, or the teacher clicked Got it.
  - On first run, offer v1's `lessonRecorderDB` the same way.
- **Storage:**
  - Call `storage.persist()` (likely denied on file://, but harmless).
  - Before Start, compare `estimate()` with 2× the expected size of a 90-minute take: the journal plus the folder's hidden swap file both exist until `close()`.
  - Journal write failures show "Safety copy off (storage full)" in the main window and the pop-out. While healthy, the Recording view shows "Safety copy: on".
- **MP4 fragment watchdog:** after the init segment, expect the first media fragment within 8 s (a 2 s interval plus one interval of lag plus slack). If none arrives, warn "Crash protection isn't working for this take" and offer WebM for the next take.

### Duration and timing

- **One clock** feeds the display, the file duration, the discard confirm and the journal:
  `elapsed = activeMs + (state === 'recording' ? performance.now() - segmentStart : 0)`.
  It freezes while paused, and Stop-while-paused closes the open pause correctly.
- **WebM duration:** MediaRecorder writes no Duration, unknown-size Segment and Clusters, and no SeekHead or Cues.
  - **Folder path:** buffer chunks until Info and Tracks are complete and the first Cluster ID (`0x1F43B675`) is seen. The first chunk can be a single byte. Insert an 11-byte float64 Duration placeholder into Info (re-encoding Info's size), write the header, and remember the absolute offset. On stop, write the real value with `write({type:'write', position})` before `close()`. If a SeekHead is present, abort the insert and write the file unpatched.
  - **Downloads and recovery path:** patch only `blob.slice(0, 65536)` and join it back with `blob.slice(65536)`.
  - **Value written:** the media's own last timestamp (last Cluster Timecode `0xE7` plus the last SimpleBlock offset, parsed from the last ~4 MB), cross-checked against the clock. Use the clock if parsing fails.
- **MP4 duration:** Chrome's fragmented MP4 needs no patch to play, but **check** what `mvhd`/`mehd` say in Windows Photos, Clipchamp and Premiere. If it is 0, patch `mvhd.duration` (and `mehd` if present) the same way: a positional write in the folder path, a header slice in the Downloads path.

---

## 6. UX structure

### Screens

**First run:** one welcome card: "Record your screen and your voice. Videos save to a folder on this computer. Nothing is uploaded." with **[Choose a folder for your lessons]** and "Use my Downloads folder instead". Recovery cards, if any, sit above everything.

**Set up.** Two columns at 1000px and wider: a ~400px checklist on the left and the live preview on the right, capped at 55vh. One column below 720px, with the primary button stuck to the bottom of the window. Steps are numbered, each with a status chip (To do / Done ✓ / Needs attention), and each collapses to one line when done.

1. **Lesson name.** "What's this lesson called?" Prefilled with the last name used. Suggestion chip "Fractions - Week 4?". Preview line "Will save as: …". Optional notes inside a disclosure.
2. **Microphone.**
   - Before any request: a short explainer and **[Turn on microphone]**. No permission prompt on page load unless permission is already granted.
   - Then: a device dropdown with friendly names ("(Windows default)", deduplicated by `groupId`), a "Use your headset?" chip when one is available but not selected, and a meter with zones "Too quiet | Good | Too loud" plus a changing text label.
   - Toggle: "Reduce background noise (recommended)".
   - **[Check my sound]** runs the check inline and ends in one verdict card:

     | Colour | Headline |
     |---|---|
     | green | Sounds great – you're ready |
     | amber | Usable – one tip below |
     | red | We couldn't hear you |
     | red | Your mic is overloading |

     Each card has one sentence, one action, "Hear it back" and "Check again". Changes the app applied are listed ("Mic level adjusted for your voice").
   - Amber and red results open "How to fix this in Windows": Windows 11 and Windows 10 tabs, plain steps, and "Copy these steps".
   - When done, the step collapses to "Microphone · Jabra headset · Sounds great · Check again".
   - A separate inline card for each failure: blocked, not found, busy (Teams or Zoom), saved headset missing.
3. **Screen.**
   - Before picking: "If you'll play videos or sounds, switch on *Share system audio* in the next window."
   - After picking: "Whole screen · 1920×1080", plus the chip "Computer sound: Included ✓" or "Not included – choose again to include it".
   - With a second monitor: "Move this window to your other screen."
   - With one monitor: "The floating controls will appear in your video – drag them to a corner."
   - Cancelling the picker shows the calm note "No screen chosen". The "blocked" copy appears only for system or policy blocks, and the "open this file directly" advice only when the page really is inside a frame.
4. **Camera bubble** (only if the bubble ships): on/off, device, shape, size, mirror, corners; drag the bubble on the preview.

Below the steps: a readiness line ("✓ Headset · ✓ Whole screen · Saving to Lessons") and the single primary button **Start recording**.
- It is never truly disabled. It uses `aria-disabled`, and clicking it early focuses the first unfinished step and explains what's missing.
- Clicking it when ready opens the floating controls and starts 3-2-1. The digits show on the preview, in the pop-out and in the tab title. The button reads "Cancel (3)"; Esc also cancels.

**Recording.** Setup is hidden, not greyed out.
- Shown: lesson name, state pill ("● Recording" / "❚❚ Paused" / "Saving…"), 48px timer, "We can hear you ✓" meter, "Computer sound" meter when included, "Safety copy: on", read-only notes.
- Buttons: **Stop & save** (primary), Pause/Resume, Add chapter (with a count), Floating controls, and a text button "Discard take".
- While paused: a full-width amber banner "Paused – not recording" with a big Resume.
- The preview becomes a still thumbnail by default (no mirror-in-mirror effect, less CPU).

**Review.**
- Heading "Take 2 · 14 min 32 s · 412 MB". A "Playing back" label (no red badge). The name is editable and renames the file on disk.
- Status line: "Saved to Lessons › Fractions - Week 3 - 2026-10-08 - Take 2.mp4 ✓", or the Downloads wording with Got it / Download again.
- Chapter list with editable titles, "Copy YouTube chapters", "Save chapters file".
- Actions: **Record another take** (primary), "Download a copy", "Delete take" (confirm), "Finish – stop sharing my screen".
- If sharing ended mid-take: "Recording stopped because screen sharing ended. Everything up to 23:14 is saved."

**Your takes** (below the main area): thumbnail, name, date, duration, size, where saved, with Play / Download / Copy chapters / Delete.

**Floating controls** (Document PiP, about 320×200, follows the app theme):
- Contents: state pill, 32px timer, mic level bar with a marked Good zone, [Pause] [Stop & save], "…" which reveals "Discard 12 min? [Keep recording] [Discard]" **inside the pop-out**, lesson name, and optional notes.
- "No sound" and "Mic disconnected" turn the whole window red with a large sentence and a live meter. Paused is amber. Saving shows a spinner.
- It is updated from worklet messages and recorder events, never from a polling `setInterval`.
- Opening is guarded with an "opening" promise; `pagehide` only clears state if it belongs to the current window.

**Signals outside the app windows:**
- `document.title`: "● 12:34 Recording – Fractions Week 3", "❚❚ Paused – …", "⚠ No sound! – …", "Starting in 3…".
- The favicon switches between neutral, red dot, pause and warning icons.

### Hidden by default

These live in the Settings dialog; items marked Advanced sit in its "Advanced" section:
- File type; quality preset with size per hour; 3-2-1 countdown; countdown beeps; auto-open floating controls; hide preview while recording; keyboard shortcuts; theme (System / Light / Dark); save location (choose / forget).
- Advanced: unprocessed mic (Studio); "I'm using speakers"; "Mute the mic between sentences (can cut off quiet words)"; auto mic level; Mic level slider; computer sound volume; record without my voice; detailed meters (spectrum, dB, peak); reset all settings.
- The help-text link "Copy a prompt for Claude Code" sits only inside the Windows-fix section on amber/red results (see §7).

### Messages

1. **Inline in the step they belong to:** icon, bold title, one sentence, one action.
2. **Toasts** top-right (`role=status`, 5 s, pause on hover) for brief information.
3. **Sticky banners** at the top (`role=alert`) for critical states and recovery cards.

Each notice is keyed and its visibility is derived from state, so unrelated actions can never clear it. Technical exception names live only in a "Details for support" expander.

### Copy tone

- Second person, calm, sentence case. Headlines of 6 words or fewer; one action sentence of 15 words or fewer, plus a "Why?" expander.
- No dB, %, "gate", "EQ" or "noise floor" in the main interface.
- Say what happened and what to do. Never tell the teacher to "stop and start a fresh take" unless the mic is truly dead.
- Use exactly these words: Start recording · Pause · Resume · Stop & save · Discard take (during a take) · Delete take (after saving) · Record another take · Floating controls · Check my sound · Mic level.

### Accessibility and look

- `header`/`main` landmarks; one `section aria-labelledby` per step with an h2; `fieldset`/`legend` for option groups; `role=meter` with `aria-valuetext`.
- One hidden status region and one alert region. Focus moves to the verdict, the Review heading and recovery cards when they appear.
- Shortcuts Alt+R / Alt+P / Alt+M / Esc, ignored while typing, listed in Help with `aria-keyshortcuts`. Help also states plainly that browsers can't offer system-wide hotkeys.
- Colour tokens: record red #c0392b; control borders #86888d; muted text #6b6d72 at 13px or larger; focus ring #1a5fd0 (dark theme: #ededee on #17181a, muted #a7a9ae, focus #8ab4ff, red #ff6b5e).
- `forced-colors` support; one global reduced-motion block covering both windows; one inline SVG icon set using `currentColor` (no emoji).
- Targets at least 24px, 40px for main actions. Type scale 14/16/20/28px plus the 48px timer, weights 400 and 600, an 8px grid, and one primary button per view.

---

## 7. Risks and open questions

1. **H.264/AAC on real machines cannot be tested in CI** (Chromium has no H.264/AAC). Test manually: Windows 10 and 11 × Chrome and Edge stable × hardware encoder present / absent (VM) / N edition. Check: the profile actually used, whether `videoKeyFrameIntervalDuration` is honoured, fragment timing on static slides, and the duration shown in Photos, Clipchamp, Premiere and YouTube.
2. **MP4 duration (`mvhd`/`mehd`) in Chrome's fragmented output is unknown.** Decide whether to patch after test 1.
3. **Two activation-gated calls in one click.** The floating controls and folder re-permission both need a user click; the brief keeps re-permission out of the Start click so the pop-out gets it. Check: whether `requestWindow` uses up the click so a second gated call fails; whether clicks inside the pop-out count as activation for downloads; whether a wake lock can be requested from the pop-out document.
4. **Delivery while hidden.** Confirm that worklet port messages and MediaRecorder events keep the pop-out at 4 Hz or faster after 30 minutes with the main window minimised or fully covered (intensive throttling only targets timers, but measure it).
5. **Does Windows system-audio capture include Chrome's own output by default?** Is `restrictOwnAudio` available? Forcing Listen off during takes makes this low-stakes; beeps must still never play through speakers.
6. **Storage.**
   - A folder take temporarily uses about 2× its size (journal plus Chrome's hidden `.crswap` file).
   - `estimate()` reports the origin's quota, not free space on the drive holding the folder; no web API gives that.
   - `persist()` is probably denied on file://, so the journal can be evicted under disk pressure.
   - After a crash, a stale `name.ext.crswap` is left in the folder. Can the page remove it with `removeEntry`?
7. **Folder permission on `file://`.** Does Chrome's "Allow on every visit" apply, or will teachers re-grant every session? This decides how prominent the "Reconnect folder" step must be.
8. **Webcam compositing cost on school laptops.** Ship it only behind a performance check: if output frames fall below 0.8× the target for 10 s, or the CPU-pressure API reports `critical`, the bubble turns off and the teacher is told. Every `VideoFrame` must be closed exactly once.
9. **Chrome echo cancellation with a headset is unproven** (aec-on-with-headset is uncertain). The brief defaults it off; measure before revisiting.
10. **All `file://` pages share one origin.** Any other local HTML file can read the journal (lesson audio). Document this, and namespace every key.
11. **Product decisions for the owner:**
    - (a) Keep v1's "Copy desktop-fix prompt"? Recommendation: keep it only as a secondary link inside "How to fix this in Windows" on amber/red results, never in the main flow. The prompt must ask before installing modules or editing the registry. A teacher can paste a dangerous prompt; the owner built this button on purpose.
    - (b) Camera bubble in v2.0 or v2.1.
    - (c) Noise gate off by default and moved to Advanced.
    - (d) No 4K capture.
12. **Where the existing scaffold (`src/`, `docs/ARCHITECTURE.md`) disagrees with this brief:**
    - `src/app/recording/recorder.js` (~lines 625–626) calls `journal.prune({exceptId})` after each downloaded take. That deletes earlier takes' safety copies whose downloads were never confirmed, which repeats problem #4.
    - `src/app/video/sources.js` line 76 passes `cursor: 'always'`. Chromium does not support it; remove it.
    - `docs/ARCHITECTURE.md` says NotAllowedError with "permission" in the message means blocked. That is the v1 cancel bug, because Chrome's cancel message is "Permission denied". The code already classifies correctly (system/policy wording plus how long the picker was open); update the doc and add the framed-page check.
    - `soundcheck.js` `CHECK_TIMING` is 1/3/5 s; the brief says 3/3/6. A 1 s lead-in measures the teacher's own voice as room noise.
    - `formats.js` `high` preset goes to 2160p; the brief caps at 1440p and adds a Small 720p preset.
    - The architecture doc allows Listen during takes without system audio; the brief forces it off from countdown to review.
    - The Studio high-pass is native biquads in front of the worklet, so clip and digital-silence detection see filtered audio. Move it inside the worklet, after the raw stats.
    - The first-fragment watchdog waits 5 s; with a 2 s keyframe interval it should be 8 s.
    - The system audio level defaults to 0.7 (−3 dB); the brief uses 0.5 (−6 dB).
    - MP4 duration is not addressed anywhere.