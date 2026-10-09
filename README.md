# Full Capture

A lesson screen recorder for teachers. It's **one HTML file**:
download `full-capture.html`, double-click it, and it opens in Chrome or Edge.
Nothing is installed, nothing is uploaded, and it works offline.

## Recording a lesson

1. **Name the lesson.** The name becomes the file name, e.g.
   `Fractions – Week 3 (2026-10-08 14.32).mp4`.
2. **Turn on your microphone** and press **Check my sound**. Stay quiet for
   three seconds, then read the sentence aloud. The app sets your mic level
   and tells you if anything needs fixing, with plain Windows steps.
3. **Choose your screen.** Pick a monitor on the "Entire screen" tab. Tick
   "Also share system audio" if you'll play videos or sounds.
4. Optionally turn on the **camera bubble** and drag it where you want it.
5. Press **Start recording**. After a 3-2-1 countdown you're recording.

While recording, the **floating controls** stay on top of your other
windows: the timer, a sound meter, Pause, Add chapter and Stop & save. When
you record the whole screen they're on, they hide as recording starts, so
they never appear in the video; bring them back with Alt+H or the *Floating
controls* button (they're recorded while shown). The browser tab's title
also shows the state (`● 12:34 Recording – Fractions…`) and any warning.

Shortcuts work while the Full Capture tab or its floating controls are the
active window.

| Shortcut | Action |
|---|---|
| Alt + R | Start recording / Stop & save |
| Alt + P | Pause / Resume |
| Alt + M | Add a chapter marker |
| Alt + H | Hide / show the floating controls |
| Esc | Cancel the countdown, close a dialog |

## Where recordings go

- **A folder you choose** (recommended): click **Choose a folder** at the top.
  Takes are written straight into it while you record, and Delete take really
  deletes the file. Chrome asks once per visit to reconnect the folder.
- Otherwise each take **downloads** to your Downloads folder when you stop.

Chapters you mark while recording appear in Review, where you can rename
them and **Copy YouTube chapters** for the video description.

## If something goes wrong

- **The browser crashed or the PC restarted mid-lesson.** Open the app again:
  it offers to save the unfinished recording ("We found a recording that
  didn't finish"). A safety copy is kept while you record.
- **Your headset gets unplugged.** Recording continues; the sound comes back
  as soon as the mic reconnects, and a red banner tells you meanwhile.
- **"No sound from your microphone".** The mic is muted (headset switch, or
  Windows sound settings) or the wrong mic is selected.
- **Screen sharing was stopped from Chrome's bar.** The take is saved up to
  that point.

## Requirements

Chrome or Edge 116 or newer on Windows, macOS or Linux. MP4 recording needs
Chrome/Edge 126+; older versions record WebM, which YouTube and Google Drive
also accept.

## For developers

```sh
npm install          # esbuild + Playwright test runner
npm run build        # src/ -> full-capture.html (one self-contained file)
npm test             # unit tests (node:test)
npx playwright test  # browser tests from file:// with fake camera, mic and screen
```

- `src/` holds the source; `full-capture.html` is built from it and committed.
- `docs/ARCHITECTURE.md` describes the design and every module's contract.
- `docs/AUDIT-v13.md` is the audit of the previous version that shaped v2.
- `legacy/lesson-recorder-v13.html` is the previous version, for reference.

Changes land in `main` through a pull request, reviewed by an agent other than
the one that made them, and are merged only with the project owner's approval.
`AGENTS.md` has the full development and review policy.
