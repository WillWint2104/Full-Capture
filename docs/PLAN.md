# Implementation plan: from recorder to upload-ready video

Status: **proposal, awaiting approval.** One stage at a time; each stage
stops for approval before the next one starts. Scope rules are in
`AGENTS.md`.

Goal: Prepare → Record → Review/Trim → Export. A teacher records, marks
mistakes, removes them, gets the stored intro and outro added, adjusts basic
audio and saves an upload-ready MP4, all inside the one-file app.

## The one technical decision under all of it

**Edits are a list, rendering happens once, in the browser.**

- Each take keeps an *edit list* next to its existing library row:
  `{ trimIn, trimOut, cuts: [{ startMs, endMs }], intro, outro, audio }`.
  Nothing touches the original recording; undo is just editing the list.
- Preview plays the original file and skips the cut ranges, so no render is
  needed to review an edit.
- Export renders once: decode the original → drop cut ranges → put the
  intro and outro around it → mix audio → encode → write the file. This uses
  the browser's own encoders (WebCodecs, available on `file://`) and one
  library, **Mediabunny** (MPL-2.0, actively maintained, the successor to
  mp4-muxer) to read the MP4/WebM recordings and write MP4. It streams frame
  by frame, so an hour-long lesson never sits in memory, and it writes
  straight to a file the teacher picks (or their lessons folder).
- Not chosen: ffmpeg.wasm (about 30 MB of WebAssembly in the one file, and
  slow without threads on `file://`); a local ffmpeg helper or desktop
  framework (installation, breaks the open-the-file simplicity). Revisit only
  if the spike below fails on the real PC, with a written justification.

**Spike first (half a day, throwaway):** on the teacher's real Windows
Chrome/Edge, cut a 60-minute recording into an H.264/AAC MP4 with two cuts and
a 1080p intro. Measure speed, check audio/video sync at every join, and check
the file plays in YouTube's uploader. Our test browser has no H.264/AAC
encoder, so automated tests run the same pipeline to WebM; MP4 itself is
proven on the real machine.

## Stages, smallest viable version of each

**1. Mistake markers** (small; no dependencies)
- A second marker kind next to the existing chapter markers
  (`kind: 'mistake'`), saved through the same recorder → journal → library
  path, so they survive a crash like chapters do.
- One shortcut (proposed Alt+X, checked against browser shortcuts) and a
  "Mark mistake" button on the floating controls and the recording screen.
- In Review: a list of mistakes; clicking one jumps playback to a few seconds
  before it.

**2. Non-destructive trimming + minimal export** (medium; needs 1 for
proposed cuts, works without it)
- Review gets a single timeline bar under the player: trim start/end
  handles, mistake ticks, cut ranges. Each mistake proposes a cut that ends
  at the marker and starts about 10 s earlier (adjustable); the teacher
  accepts, adjusts or dismisses it. Undo/restore per cut.
- "Preview edited" plays with cuts skipped.
- Minimal export: the edited lesson only, no intro/outro, no music, one
  preset. This is where the render pipeline from the spike becomes real,
  because trimming is useless until the result can be saved.

**3. Stored intro/outro** (medium; needs 2's export)
- A small Production assets panel: import intro, import outro, preview,
  replace, remove, "include by default" switches, per-export override.
- Validated on import: read duration, size and codecs, and decode the
  first frames; reject what can't be decoded with a clear "export it as
  H.264 MP4" message.
- Stored in IndexedDB with `navigator.storage.persist()` requested and
  storage use shown. Intro/outro clips are small, but browsers can still
  evict data under disk pressure, so the panel shows when a file has gone
  and asks for it again. An asset that fails never blocks recovery or
  export of the lesson itself; export offers "export without intro/outro".
- Export scales or letterboxes each clip to the lesson's frame size and frame
  rate, and resamples its audio to 48 kHz stereo before joining.

**4. Simple audio** (medium; needs 2's export, reuses 3's asset storage)
- Narration level; one saved background-music file with volume, fade in/out
  and automatic ducking under the voice (computed from the narration level
  while exporting).
- Adobe Podcast, by hand: "Export narration (WAV)" for the edited lesson;
  the teacher enhances it on Adobe's site; "Import enhanced narration"
  replaces the voice at export if its length matches, otherwise it is
  refused with the reason. No API is assumed.

**5. Final MP4 export** (small; finishes 2–4)
- One YouTube-ready preset (1080p, H.264/AAC MP4) plus a small advanced
  section (720p/1080p, quality). Progress bar, cancel, the final file name
  and folder shown at the end. WebM fallback where H.264/AAC are missing,
  with the reason stated.

## Order and dependencies

```
1 Markers ──► 2 Trim + minimal export ──► 3 Intro/outro ──► 5 Final export
                         └──────────────► 4 Audio ─────────┘
```

Proposed order: 1 → 2 → 3 → 4 → 5, matching "stable recorder, then
markers and trimming, then intro/outro and reliable export, then
soundtrack and Adobe Podcast". 4 and 5 can swap if the polished export is
wanted before music.

## How each stage is checked

- Unit tests for the edit list (cut maths, merging overlapping cuts,
  timestamps after cuts) and asset validation.
- Browser tests on the fake devices: record, mark, cut, export to WebM,
  then decode the export and check duration, frame count and A/V sync
  against the edit list.
- The spike's real-PC check repeated for MP4 at the end of stages 2, 3 and 5.
- An independent agent reviews each stage (AGENTS.md), focused on the
  original never being changed or lost and the export matching the edit.

## Decisions needed before stage 2

1. Approve the browser-only render approach (after the spike), and the one
   new dependency (Mediabunny).
2. Default lead-in for a mistake's proposed cut (10 s suggested).
3. Where an export is saved when no lessons folder is chosen (a save dialog
   is suggested; a download would hold the whole video in memory).
