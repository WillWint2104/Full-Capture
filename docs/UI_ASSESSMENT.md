# Full Capture: UI and UX assessment before release

**Date:** 12 October 2026. **Build:** `full-capture.html` from branch `claude/gallant-curie-bclea8` at `c85b491`, the head of PR #1. A rebuild was byte-identical to the committed file.

**What this is:** a read-only review of how the real app looks and behaves for a teacher recording lessons in HGL Studio.
- No app code was changed and nothing was committed.
- Each finding is backed by screenshots of the running app.
- The screenshots are in `design/ui-assessment/`, which git ignores (see [Screenshot gallery](#screenshot-gallery)). Screenshot paths below are relative to `design/ui-assessment/shots/`.

> **Status (13 October 2026):** the project owner accepted the interface as the baseline.
> - **Done in the refinement pass on PR #1:** F1 (guidance only, no new capture mode), F2, F3, F4, F5 and F6.
> - **Deferred:** F7 and F8.
> - **Screenshots:** they are not in the repository. The assessment ZIP shares them, and `design/ui-assessment/capture.mjs` re-creates them locally.

## Verdict

**Suitable for regular recording?**
- **Two monitors: yes,** once F4 is fixed (a small change).
- **One screen** (most laptops): usable, but not comfortable yet. During a whole-screen recording the teacher has no controls they can reach, and can't see alerts, without switching back to Full Capture. That switch is recorded (F1).

**Release blockers:** there is no P0: nothing found prevents recording or loses footage. The one P1 is F1. Its minimum correction is honest guidance before Start (XS–S). A proper fix needs a product decision and a Windows check first (see F1).

**What already works well:**
- **Set up:** three numbered steps with clear status chips and a progress bar. A pinned Start button says what is still missing.
- **Recording, paused and saved look unmistakably different.** Red means recording, amber means paused, and a green tick means saved. The tab title follows the state, and warnings are appended to it.
- **Errors and recovery are specific and say what to do:** microphone blocked, no sound, microphone unplugged, screen sharing ended, storage low, picker cancelled, and the unfinished-recording card after a crash.
- **Consistent and professional:** one icon set, one type scale and one colour system. The light and dark themes match.
- **Sizes:** it works well from a 960 px half-screen window to 1920 px, and at 125% zoom. At 200% it is usable but crowded.

**Minimum pre-release corrections** (a few hours in total, no change to recording, saving or export):
- **F1:** one-screen guidance.
- **F2:** reset the scroll position when the view changes.
- **F4:** microphone status in Set up reflects "No sound".

**Recommended in the same pass:** F3, the Start bar covering "Turn on microphone".

## How the screenshots were made

**The app:** the built single file, opened from `file://` in Chromium 141 (Playwright 1.56, headless), as in the project's browser tests.

**Simulated devices:**
- **Screen:** a drawn "lesson" slide at 1920 × 1080, reported as a whole monitor, with quiet computer sound.
- **Microphone:** a voice-like synthetic signal. It falls silent when the sound check asks for quiet.
- **Camera:** Chromium's fake camera.
- **File type:** MP4 recording is switched on as in the MP4 browser tests, so file names end in `.mp4`, as in Chrome and Edge.

**Clean profile:** every scenario used a fresh browser profile. No real recordings, personal data or saved settings were involved, and Downloads went to a temporary folder.

**Sizes.** Each viewport is what Chrome shows in a maximised window: the screen minus the Windows taskbar and Chrome's tab strip and toolbar. Zoom is emulated as Chrome applies it: a smaller CSS viewport at a higher pixel ratio.

| Group | Screen | Viewport (CSS px) | Captured |
| --- | --- | --- | --- |
| `laptop` | 1366 × 768 | 1366 × 633 | every state |
| `fhd` | 1920 × 1080 | 1920 × 945 | every state |
| `half` | half of 1920 × 1080 | 960 × 945 | core states |
| `zoom125` | 1920 × 1080 at 125% | 1536 × 756 | core states |
| `zoom200` | 1920 × 1080 at 200% | 960 × 472 | core states |
| `controls` | floating controls window | 320 × 420 | every state, two monitors simulated |
| `warnings`, `folder`, `dark` | 1366 × 768 | 1366 × 633 | warnings and errors, saving to a folder, dark theme |

**Not covered:**
- **Windows itself:** Segoe UI falls back to Inter here, which is slightly wider. Chrome's own screen picker, sharing bar and permission prompts don't appear.
- **The floating controls:** rendered in a stand-in frame and photographed on their own, without the real window frame.
- **Two real monitors** were not used.
- **Long takes:** test takes are seconds long, so "Saving your take…" was never visible.

**Simulation artefacts** are labelled in the gallery. In particular:
- `zoom200/10` and the toasts over the takes list (`laptop/16`, `fhd/16`) come from the capture script, not from the app.
- `warnings/54` shows "Computer sound: included" for a shared window. A real shared window has no computer sound.

## Review process

The lead assessment was checked by **two independent agents**, a narrow check as `AGENTS.md` asks, not a broad review:
- **A blind assessor** saw the screenshots and code but not the draft findings.
- **A skeptic** tried to refute each draft finding against the screenshots and the source.

**The skeptic confirmed all seven draft findings but corrected:**
- **F1's fix.** The app currently warns teachers away from sharing a window, and a shared window has no computer sound, so "copy + one condition" was wrong.
- **F2 and the toast finding:** two pieces of evidence were artefacts of the capture script.
- **F4:** the meter showing "Too quiet" after an unplug was a 2-second transient. A follow-up timed capture confirmed this: `warnings/55a`–`55c`.

**The blind assessor found the same core problems (F1, F2, F3, F4, F8) and added:**
- unreachable alerts on one screen (now part of F1);
- the floating controls' paused and after-take states (F5);
- several refinements listed at the end.

It rated F4 as P1. This report keeps F4 at P2, because a red banner, a red meter and "⚠ No sound!" in the tab title are all shown. Either way it is in the minimum corrections.

## The teacher's workflow: ten questions

1. **How quickly can a teacher prepare?**
   - **First visit:** about a minute. Name the lesson, turn on the microphone and allow it, run the optional 10-second sound check, choose the screen, then Start.
   - **Later visits:** the microphone comes on with the first click on the page, so it is Choose screen → Share → Start: about three clicks (`laptop/05-setup-ready.png`).
   - **First-visit snag (F3):** the microphone button is hidden under the Start bar.
2. **Are microphone and screen readiness obvious?**
   - Mostly. Each step has a status chip (Done, Sounds great, Needs attention, Blocked, Check this), there is a progress bar ("All 3 steps done – you're ready"), and a readiness line sits above Start (`laptop/05`, `laptop/04-setup-soundcheck-result.png`, `warnings/54-window-shared.png`).
   - **Exception (F4):** a microphone sending pure silence still shows a green tick and "All set".
3. **Is Start prominent and unambiguous?**
   - **Yes.** A large red Start recording button is pinned at the bottom of the setup column, with Alt+R on it.
   - **Not ready:** it turns pale and the line above says what is missing (`laptop/01-setup-first-open.png`).
   - **Pressed too early:** it explains and points to the fix (`warnings/45-start-blocked.png`).
   - **At 200% zoom** it is no longer pinned and sits far down the page (F8).
4. **Are recording, paused and saving visually distinct?**
   - **Yes:**
     - **Recording:** red badge, red line along the top of the page, red preview frame, a large timer and "● 00:09 Recording" in the tab title (`laptop/10-recording.png`).
     - **Paused:** a full-width amber "Paused – not recording" banner with a big Resume, plus an amber timer and frame (`laptop/11-paused.png`).
     - **Saved:** a green "Saved – nice work!" (`laptop/13-review.png`).
   - Saving itself was too quick to see with short takes.
5. **Can recording controls be operated without interrupting the lesson?**
   - **On two monitors, yes.** The floating controls stay on top with the timer, Pause, Add chapter and Stop & save (`controls/31-controls-recording.png`).
   - **On one screen with a whole-screen recording, no** (F1).
6. **Are warnings and failures easy to notice and understand?**
   - **In Full Capture, yes:** sticky red banners for sound problems, amber for storage, and a recovery card after a crash. The messages are concrete (`warnings/47`, `48`, `50`, `51`).
   - **On one screen, not during the lesson:** they appear only in the Full Capture tab and its title (F1).
   - **Set up can contradict a no-sound alert** (F4).
7. **Can a finished take be found, reviewed and saved easily?**
   - **Yes:**
     - **Review** opens at once with the player, the length and size, and where the file went ("Downloaded to your Downloads folder as …" or "Saved to Lessons › …").
     - **Your takes** lists every take with a thumbnail, length and actions (`laptop/16-library.png`, `folder/62-folder-review.png`, `laptop/17-library-open-older.png`).
   - **Saving:** the default is Downloads, and the header chip invites the teacher to choose a folder.
   - **Gaps:** the floating controls don't confirm the save (F5), and retakes are not numbered (optional refinements).
8. **Is it visually consistent and professional?** **Yes**, in both themes (`dark/`). The small inconsistencies are in F5.
9. **Anything unnecessarily complicated or technical?**
   - **Little in the main path.** Advanced sound settings are folded away.
   - **Minor exceptions:** "Copy a prompt for Claude Code" in the sound-check help, YouTube chapter rules shown as an amber warning in Review, and a 25–1600% mic level slider (optional refinements).
10. **Is it usable at different sizes and zoom levels?**
    - **Yes from 960 px to 1920 px and at 125%.**
    - **At 1366 × 768 vertical space is tight:** the Start bar covers part of the steps (F3), views keep their scroll position (F2), and a warning banner pushes Pause below the fold (F7).
    - **200% zoom is usable but crowded** (F8).

## Findings

Ranked by priority, then by how often a teacher meets them.

| # | Priority | Finding | Type | Effort |
| --- | --- | --- | --- | --- |
| F1 | **P1** | One screen, whole-screen recording: no usable controls and no visible alerts during the lesson | Workflow gap (current design) | XS–S guidance; M for a window mode |
| F2 | P2 | Recording and Review views keep the previous scroll position, so the timer and "Recording" badge can be off-screen | Observed failure | XS |
| F3 | P2 | First visit: the pinned Start bar covers "Turn on microphone" | Observed failure | S |
| F4 | P2 | Set up says "All set · ✓ Microphone" under a red "No sound from your microphone" banner | Observed failure | XS–S |
| F5 | P3 | Floating controls: no "Saved" confirmation after a take; when paused, Stop & save stays the big button | Usability, partly preference | XS–S |
| F6 | P3 | The 10-second "Floating controls hidden" toast appears at the start of every take on one screen | Observed | XS |
| F7 | P3 | At 1366 × 768, a warning banner pushes Pause and Add chapter below the fold | Observed | S |
| F8 | P3 | At 200% zoom: Start isn't pinned, and the empty preview's picture overlaps its heading | Observed | XS–S |

Effort: XS is under an hour, S is a few hours, M is a day or more.

### F1 · P1 · One screen, whole-screen recording: no usable controls and no visible alerts during the lesson

**Evidence:**
- `laptop/01b-setup-first-open-full.png`: the Screen step says "Click the **Entire screen** tab", and the Set up card says "Floating controls stay on top of your slides: the timer, Pause, Add chapter and Stop & save".
- `laptop/09-recording-just-started.png`: at Start, a "Floating controls hidden … press Alt+H or Floating controls" toast appears.
- `laptop/10-recording.png`: "Floating controls · Hidden".
- `laptop/24-help.png`: "Alt+H brings them back".
- `warnings/47-mic-lost-recording.png` and `warnings/49-no-sound-recording.png`: the alerts appear only in the Full Capture page and tab title.
- `warnings/54-window-shared.png`: sharing a window instead is flagged "Only one window will be recorded … choose the Entire screen tab".

**Observed:**
- **The controls always close on one display.** When a whole-screen take starts on a single display, the floating controls close so they aren't recorded (`controlsWouldBeRecorded` in `src/app/ui/popout.js`). They never close for window or tab captures.
- **Shortcuts don't reach HGL Studio.** They work only while Full Capture or its controls have focus. The Help text, the README and `docs/ACCEPTANCE.md` (2b) say so; no web page can see keys pressed in another application.
- **Set up promises the opposite.** The "What happens when you press Start recording" card promises controls "on top of your slides", even on one display.
- **The app steers teachers away from the alternative.** It warns against window capture, and a window capture has no computer sound.

**Effect on the teacher (inferred from the above; to confirm in the Windows acceptance test):**
- **Pausing, marking a mistake with Add chapter, or stopping** means leaving HGL Studio and switching to the Full Capture tab, and that switch is recorded. So are the ends of takes.
- **Bringing the controls back** with Alt+H or the button puts them in the video. Nothing says so.
- **A microphone that dies mid-lesson** can go unnoticed until the teacher switches back, because the alerts are only in Full Capture.
- **Nothing is lost,** and the tails can be trimmed later. But the planned way of working (pause and mark mistakes while teaching) doesn't work on one screen, and teachers aren't told before they start.

**Recommended corrections:**
1. **Minimum, before release (XS–S, copy only).** When Set up sees a single display (`screen.isExtended === false`), say it before Start:
   - **In the Screen step:** "On one screen, the floating controls hide while you record so they stay out of the video. To pause, add a chapter or stop, switch back to this tab; that moment is recorded and can be trimmed later."
   - **In the Set up card:** replace the "stay on top of your slides" promise on one display.
   - **In the "Floating controls hidden" toast:** say that showing the controls again puts them in the recording.
2. **Proper fix, after a product decision and a Windows check (M).** Offer a one-screen mode that records only the HGL Studio window, or its Chrome tab if HGL Studio runs in the browser. The floating controls then stay visible and out of the video: the code already never hides them for window or tab captures.
   - **What has to change:** the Screen step today warns against this. The warning card, the "Check this" chip, "! One window" with no "All set", the "No screen chosen" toast, Help and the README would need to accept it for one-display setups. Entire screen stays the default.
   - **Verify on the teacher's Windows PC first.** `docs/ACCEPTANCE.md` (section 2b) already lists an "(Alternative)" window check; extend it to cover these:
     1. The floating controls on top of HGL Studio are absent from a window recording. This depends on Chrome using Windows Graphics Capture.
     2. Is HGL Studio a desktop app or a browser tab? If it is a tab in the same Chrome window, share the tab, not the window.
     3. HGL Studio's presentation mode, menus and pop-ups stay inside the capture.
     4. Resizing or maximising its window mid-take still gives an MP4 that plays and scrubs. The frame size can change.
     5. Window capture has no computer sound. Lessons that play videos would be silent, but a shared Chrome tab keeps its sound.

### F2 · P2 · Recording and Review views keep the previous scroll position, so the timer and "Recording" badge can be off-screen

**Evidence:**
- **Laptop, after scrolling:** `laptop/18a-setup-scrolled-before-start.png` (Set up scrolled down to the Screen step, as a teacher checking it would) followed by `laptop/18-recording-after-scrolled-start.png`. The recording view opens 273 px down: the timer and "● Recording" badge are above the window, and Stop, Pause and the red preview frame are visible.
- **Half window:** `half/13-review.png`. The recording view had been scrolled to reach Add chapter, and Review then opened at the same position, with the top of the video cut off.
- **Compare** `laptop/10-recording.png`, where Start was pressed from the top of the page.

**Observed:**
- **Nothing resets the scroll position.** Nothing scrolls to the top when the view changes between Set up, Record and Review. The only scroll calls in `src/app/ui/` bring the paused banner, the sound check, an opened take's player or a blocked step's fix into view.
- **Who meets it:** teachers at 1366 × 768 and in smaller windows. At 1920 × 1080 the recording view fits, so it doesn't happen there.

**Effect:**
- **The best confirmation is hidden.** The clearest sign that recording has started, the big timer and the badge, is off-screen.
- **Why only P2:** the red preview frame, "Recording · preview hidden" and the tab title still show it, so nothing misleads.

**Recommended correction:** when the shown view changes, call `window.scrollTo(0, 0)` before the existing focus step. Add a browser test: scroll Set up, press Start, then check the page is at the top and the timer is visible.

**Effort:** XS.

### F3 · P2 · First visit: the pinned Start bar covers "Turn on microphone"

**Evidence:**
- `fhd/01-setup-first-open.png`: at 1920 × 1080 only the top edge of the Turn on microphone button shows under the Start card.
- `laptop/01-setup-first-open.png`: at 1366 × 768 the Microphone step's heading is under it.
- `half/01-setup-first-open.png`: the step is below the fold.

**Observed:**
- **The bar covers the first action.** The Start bar is pinned to the bottom (`position: sticky` in `src/styles/setup.css`). It is only released while the sound check runs or at very short heights. On a first visit the microphone step shows an explanation and an illustration of Chrome's permission prompt, then the button, and the bar sits over it.
- **There is a way out.** Pressing the pale Start button scrolls to the button and explains (compare `warnings/45-start-blocked.png`).

**Effect:** the very first thing a new teacher has to press is hidden. It is easy to recover from, so P2.

**Recommended correction:**
- **Unpin the Start bar until the microphone is on or "Record without my voice" is set.** One CSS rule, like the existing sound-check rule.
- **At 1366 × 768, also put the button above its illustration.**
- **Check** 1920 × 945, 1366 × 633 and 960 × 945, and that the bar pins again once the microphone is live.

**Effort:** S.

### F4 · P2 · Set up says "All set · ✓ Microphone" under a red "No sound from your microphone" banner

**Evidence:**
- **The contradiction:** `warnings/48-silent-mic-setup.png` shows a red banner ("The microphone is sending pure silence…"). Underneath, the Microphone step shows a green tick with "On – sound not checked", and the Start bar says "All set · ✓ Microphone: Headset Microphone".
- **For comparison:** a failed sound check does mark the step "Needs attention" and the Start bar "(check it)" (`warnings/52-soundcheck-no-voice.png`).
- **During a take** the meter does say "No sound from your microphone" (`warnings/49`, `warnings/55b`).

**Observed:** the step's status and the readiness line in `src/app/ui/setup.js` never look at the "no-audio" alert.

**Effect:** a teacher who trusts the green "All set" can start a lesson with a muted headset. The banner and the "⚠ No sound!" tab title make this unlikely before Start. On one screen the alert can't be seen during the lesson (F1), so getting Set up right matters.

**Recommended correction:** while the "no-audio" alert is active:
- give the Microphone step status "attention" with the chip "No sound";
- with that status the readiness line drops "All set" and adds "(check it)".

Start stays allowed. Add a browser test with a silent microphone.

**Effort:** XS–S.

### F5 · P3 · Floating controls: no "Saved" confirmation after a take; when paused, Stop & save stays the big button

**Evidence:**
- `controls/35-controls-after-take.png`: straight after Stop & save, the window shows "Ready when you are" and Start recording.
- `controls/33-controls-paused.png`: paused, with a full-width Stop & save and a small red Resume.

**Observed:**
- **No visual confirmation of the save** in the floating window. Only screen readers hear "Saved". Confirmation is on the main page ("Saved – nice work!", `laptop/13`).
- **Paused, the emphasis is the reverse of the main page.** The floating window keeps Stop & save as its biggest button. The main page makes Resume the big button (`laptop/11`).

**Effect:**
- **On two monitors** the teacher looks at the floating window. They may wonder whether the take was kept.
- **Reaching for the big button to carry on** ends the take, which is saved but cuts the lesson into two takes.
- **Partly a matter of taste:** Resume is already red.

**Recommended correction:**
- **After a take:** show one line in the floating window until the next Start: "✓ Saved · 12:40 · Downloads".
- **When paused:** make Resume the full-width button, with Stop & save in the row below.

**Effort:** XS–S.

### F6 · P3 · The 10-second "Floating controls hidden" toast appears at the start of every take on one screen

**Evidence:** `laptop/09-recording-just-started.png`, `warnings/47-mic-lost-recording.png` and `warnings/49-no-sound-recording.png`. The toast covers the preview's top-right corner, and other toasts stack under it.

**Effect:** repeated clutter after the first time. No data risk.

**Recommended correction:**
- **Show the toast once per session.** On later takes the "Floating controls · Hidden" tag is enough.
- **Keep announcing it to screen readers** on every take.

**Effort:** XS.

### F7 · P3 · At 1366 × 768, a warning banner pushes Pause and Add chapter below the fold

**Evidence:** `warnings/41-storage-low-recording.png` and `warnings/49-no-sound-recording.png`. With one banner, the card shows the timer and meters, and Stop & save sits at the bottom edge. Pause and Add chapter need scrolling.

**Effect:** when something is wrong, which is when a teacher may want to pause, the button is out of sight. Alt+P still works, and Stop stays visible.

**Recommended correction:** at short window heights (under about 700 px), make the timer and meters more compact.

**Effort:** S. It can wait.

### F8 · P3 · At 200% zoom: Start isn't pinned, and the empty preview's picture overlaps its heading

**Evidence:**
- `zoom200/01-setup-first-open.png`: the monitor drawing sits on top of "Your screen will appear here".
- `zoom200/05-setup-ready.png`: no Start button in view. The bar is deliberately unpinned below 480 px of height, so Start is several screens down.

**Recommended correction:**
- **Overlap:** hide the drawing when the preview is short, as the phone layout already does (XS).
- **Start:** consider a compact pinned bar at short heights, with only the button (S).

## Minimum pre-release corrections

1. **F1, step 1:** one-screen guidance in the Screen step, the Set up card and the auto-hide toast. Copy only, so a teacher on one screen knows before Start how pausing and stopping work.
2. **F2:** scroll to the top when the view changes. Includes a regression test.
3. **F4:** the microphone step and readiness line reflect a "No sound" alert. Includes a regression test.

**Recommended in the same small change:** F3 (Start bar pinned only once the microphone is on).

**Together:** a few hours, mostly in `src/app/ui/setup.js`, `src/app/ui/app.js`, `src/index.html` and `src/styles/setup.css`. No change to the recorder, sinks, journal or export.

**Separately, for decision:** F1 step 2, a one-screen window or tab mode. It needs the five Windows checks listed under F1 first. It is a product decision because it changes what is recorded.

## Optional future refinements

None of these is needed for release.

- **YouTube chapter rules in Review:** they show as an amber warning on most takes ("YouTube needs at least 3 chapters…", `laptop/13b-review-full.png`), so a good take looks like it has a problem. Use neutral styling, or show the rules only when the teacher copies chapters.
- **"Copy a prompt for Claude Code"** in the sound-check Windows help (`warnings/53-soundcheck-windows-help.png`) is technical for most teachers. Move it below the steps or behind "More help".
- **Storage warning:** it gives space in MB ("About 919.2 MB left", `warnings/40`). Adding minutes ("about 25 minutes at this quality") would answer the teacher's real question.
- **Retake numbers in the takes list:** retakes are numbered per lesson and day ("Take 2" in Review), but library rows show no take number. Retakes with the same name differ only by time and size (`laptop/16`). Showing "Take 2" in the row would help pick the good one.
- **Mark mistakes vs chapters:** the plan has teachers marking mistakes for later trimming. Today that is "Add chapter". When the Trim stage is built, a distinct "Mark mistake" may read better.
- **Mic level slider** (Advanced sound settings): it spans 25–1600%, so normal levels sit at the far left (`laptop/23-settings-advanced-sound.png`). A logarithmic scale would be easier to set.
- **Preview labels:** the "Playing back" badge shows on a take that is paused at 0:00 (`laptop/13`). The "Live preview" badge covers the top-left of the shared screen (`laptop/05`). Use "Your take", or follow the play state.
- **Long file-name line:** "Will save as: Fractions – Week 3 (2026-10-12 12.12).mp4" wraps mid-name in the narrow setup column.
- **One screen, microphone failing mid-take:** a Windows notification would reach the teacher. It would appear in the recording, so it needs the owner's approval.
- **In the Windows acceptance test,** check what a long take shows during "Saving your take…".

## Screenshot gallery

Everything is in **`design/ui-assessment/`**, which git ignores. Nothing there was committed.

| Item | What it is |
| --- | --- |
| `gallery.html` | Labelled gallery of all 111 screenshots, grouped by size and scenario. Each one shows its label, the tab title, how far the page was scrolled, and any simulation artefact. |
| `contact-sheets/*.png` | One contact sheet per group, plus `overview-sizes.png`: the core states side by side at every size. |
| `shots/<group>/<name>.png` | Full-size screenshots. |
| `capture.mjs` | Re-creates the screenshots: `npm run build`, then `node design/ui-assessment/capture.mjs` (or one scenario, e.g. `main-laptop`, `controls`, `warnings`). |
| `build-gallery.py` | Rebuilds the gallery and contact sheets: `python3 design/ui-assessment/build-gallery.py`. |
| `full-capture-ui-assessment.zip` | This report, the gallery, contact sheets and screenshots in one file. |

**Screens covered.** The prompt's list maps to these files (numbers are file-name prefixes; most are in every size group):
- **Preparation:**
  - `01` first open, `02` microphone, `03`–`04` sound check;
  - `05`–`06` screen chosen and ready, `07` camera bubble options;
  - settings `20`–`23`.
- **Recording:**
  - `08` countdown, `09`–`10` recording, `11` paused, `12` just after Stop, `18` started from a scrolled page;
  - the floating controls `controls/30`–`35`;
  - warnings and errors `warnings/40`–`55`.
- **Review:**
  - `13` review, `14` playback after seeking, `15` chapters;
  - `16`–`17` takes library and an older take;
  - `folder/62` saved to a folder.
- **Settings:**
  - recording, while recording, save location, advanced sound and help (`20`–`24`);
  - folder chosen (`folder/60`–`61`).
