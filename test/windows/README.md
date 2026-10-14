# Windows acceptance kit

An automated acceptance run of Full Capture on a real Windows PC. It uses the
**installed Chrome and Edge**, the **real microphone** (and webcam, if asked)
and **real screen capture**. A harmless test pattern is the only thing on
screen, and every saved take is checked with ffmpeg and ffprobe. It doesn't
change the app. It writes evidence and a draft of
`docs/WINDOWS_ACCEPTANCE_RESULTS.md` to a folder **outside the repository**.

It automates what can be automated. The rest of `docs/ACCEPTANCE.md` (Windows
Media Player, the clap test, two monitors, a 20-minute take) stays a short
manual list at the end of the report.

## What it checks

| Area | Checks (per browser) |
| --- | --- |
| 1. Application | The commit is the pull request's latest. The committed `full-capture.html` is a fresh build of `src/`. The kit opens the repository's own copy, not a download. |
| 2. Screen capture | Real devices only (no fake camera, microphone or screen). Whole screen chosen, with its resolution. 3-2-1 countdown. Pause/Resume and a chapter. Stop & save gives `Acceptance test (date time).mp4`. Three takes, numbered, none overwritten. The file's length matches the time recorded, without the pause. Window capture. Whether the page is hidden and holds a wake lock while in the background. |
| 3. Floating controls | One screen: open for the countdown, closed before recording. In **no frame** of the saved video while hidden. Alt+H brings them back (and they're then in the frames, which proves the check sees them). Hide closes them again. Paused in the controls: Resume big, double-click safe, "✓ Saved · … · in Downloads". Window capture: they stay open and are in no frame. |
| 4. Audio and camera | The microphone opens. Quiet-room level and the pattern's clicks. Recorded level, clipping, gaps and digital silence. **Sync** of the pattern's flashes and clicks at the start, after the pause and at the end. Camera bubble with `--camera`. |
| 5. MP4 integrity | H.264 + AAC in MP4, finalised (`ftyp mdat moov`, not fragmented). Header length matches the app's. ffmpeg decodes every frame. Seeks at 25/50/75 % give a frame there, decode cleanly and keep the sync. The saved file holds **exactly** the recorder's packets; the recorder's original output is kept beside it. It plays and seeks in Chrome/Edge. Windows reads its length (Explorer → Properties → Details). |
| 6. Reliability | Esc in the countdown. Stop & save double-clicked. Screen sharing ended and microphone lost (*simulated*). Low disk warning (*simulated*). **The tab crashing and the browser being ended mid-take**, both real, then recovery. The safety copy is written every second, so the last few seconds can be missing: up to 4 s passes, and the report gives the number. Page console errors. |

Real-world steps that need you are opt-in with `--guided`: speaking, unplugging
the microphone, *Stop sharing* in the browser's bar, and saving into a folder.
The kit says `ACTION NEEDED: …` and waits.

## Before you run it

- Windows 10 or 11 with Google Chrome and/or Microsoft Edge (version 126 or
  newer), a microphone, and Node.js 22.
- In the repository: `git fetch origin`, `git checkout claude/gallant-curie-bclea8`,
  `git pull`, then `npm ci`.
- ffmpeg and ffprobe: `winget install --id Gyan.FFmpeg -e`, then open a new
  terminal (or pass `--ffmpeg-dir`).
- Windows must let desktop apps use the microphone: Settings → Privacy &
  security → Microphone.
- **Close or minimise anything private.** The test records the whole screen,
  with a full-screen test pattern on top. The microphone records the room for
  a few minutes. Everything stays in the evidence folder on this PC.
- Set the speakers to a moderate volume. The pattern clicks every 2 seconds so
  the microphone can hear it, which is how sync is measured. With a headset,
  sync can't be measured automatically, and the report says so.
- Leave the PC alone while it runs (about 6–8 minutes per browser). The
  floating controls appear as a **magenta** box: the kit paints them so it can
  find them in the video.

## Running it

```powershell
npm run build                                   # must leave full-capture.html unchanged
node test/windows/run.mjs                       # Chrome then Edge, about 15 minutes
node test/windows/run.mjs --browsers chrome --guided    # with the steps that need you
node test/windows/run.mjs --camera              # the main take with the camera bubble (records you)
```

Options: `--seconds N` (main take length, default 60), `--only
main,takes,reliability,recovery,window`, `--source "Screen 1"` (two monitors;
picked automatically when Windows reports more than one), `--window-source`,
`--no-sound`, `--out DIR`, `--keep-profile`. `--self-test` exists only to check
the kit itself on a machine without a microphone or H.264 (it uses a
synthetic microphone). Never use it for acceptance.

The kit starts each browser with its own temporary profile inside the evidence
folder. Your own Chrome/Edge profile, its recordings and your Downloads folder
are never touched. "Ending the browser" kills only processes started with
that temporary profile.

## What it writes

`%USERPROFILE%\FullCaptureAcceptance\<date-time>\`:

- `WINDOWS_ACCEPTANCE_RESULTS.draft.md`: the report, with a row per check and
  per browser, saying whether each used **real** or **simulated** devices.
- `results.json` and `run.log`.
- `<browser>\downloads\`: every saved take, exactly as the app saved it.
- `<browser>\original\`: MediaRecorder's own output for Take 1, before the app
  finalised it.
- `<browser>\frames\`: frames decoded after the seeks (the pattern's clock
  shows where they are).
- `<browser>\screenshots\` and `<browser>\analysis\*.json`.
- `build\full-capture.html`: the fresh build compared with the committed one.

The browser profiles are deleted at the end unless a check failed or
`--keep-profile` is given. They hold the app's safety copies of the test takes.

To write `docs/WINDOWS_ACCEPTANCE_RESULTS.md`, start from the draft. Add the
manual checks and the merge recommendation. Keep the evidence paths, but
**don't commit any recording, frame or screenshot**: they stay on the PC.

## If something goes wrong

- **The sharing window stays open:** the browser didn't pick
  `"Entire screen"` by itself. This happens with a browser that isn't in
  English or with two monitors. Pass the name it shows (`--source "Screen 1"`),
  or run with `--guided` and choose it yourself.
- **Window take fails at the picker:** pass `--window-source` with the start of
  the pattern window's title as the picker lists it.
- **"No microphone":** the report gives the app's own message. Check the Windows
  privacy setting above and that no other app holds the microphone.
- **A check fails:** keep the evidence folder, and rerun only that part with
  `--only`. A failure in the kit itself (not the app) is fixed in
  `test/windows/`; production code changes only for a confirmed app defect.

## Prompt for Claude Code on the Windows PC

> Run the Full Capture Windows acceptance test with the kit in
> `test/windows/` of the Full-Capture repository (branch
> `claude/gallant-curie-bclea8`). Read `test/windows/README.md` and
> `docs/ACCEPTANCE.md` first.
>
> 1. `git fetch origin`, check out and pull the branch, and confirm `HEAD`
>    equals `origin/claude/gallant-curie-bclea8`. Run `npm ci`, then
>    `npm run build`, and confirm `git status` shows `full-capture.html`
>    unchanged.
> 2. Check that ffmpeg/ffprobe, Chrome and Edge are installed. If ffmpeg is
>    missing, ask me before installing it with winget.
> 3. Tell me to close private windows and set the speakers to a moderate
>    volume. Then run `node test/windows/run.mjs --guided` in the background.
>    Watch its output: whenever it prints `ACTION NEEDED:`, tell me exactly
>    what to do. If it fails at a Windows permission or picker, stop and tell
>    me exactly what I need to do.
> 4. Then do with me, one at a time, the manual list at the end of the draft
>    report: Windows Media Player playback and scrubbing of Take 1, the clap
>    test with my camera, the sound check, and two monitors if I have them.
> 5. Write `docs/WINDOWS_ACCEPTANCE_RESULTS.md` from the draft and the manual
>    results. Include the commit, browser and tool versions, pass/fail per
>    check, real or simulated devices, the MP4 and seek results, sync
>    findings, evidence paths, limitations, and one recommendation: Ready to
>    merge / Ready with documented limitations / Not ready to merge.
>    Commit only that document to the branch and push.
>
> Constraints:
> - Do not modify production code unless a real defect is confirmed.
> - Do not merge PR #1, request CodeRabbit or run a broad code review.
> - Never commit or upload recordings, frames or screenshots.
> - Do not overwrite existing recordings, fill the disk or end unrelated
>   processes.
> - Do not substitute synthetic devices: never use `--self-test`.
> - Do not monitor the PR after pushing.
