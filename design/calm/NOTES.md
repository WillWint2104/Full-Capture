# Calm studio: design notes

Direction: light-first, warm paper neutrals, soft elevation, quiet type. It grows out of
v1's paper-and-ink look (`#fafaf8` paper, ink text, one red dot) and is organised by the
UX blueprint: three modes, a guided checklist, and one primary button per view.

Files: `index.html` (markup and templates), `styles.css` (all styles, including `.popout`),
`demo.js` (fake content per `?state=`; not app logic), `shots/`.

## What changed from v1, and why

| v1 | Calm studio | Why |
|---|---|---|
| One long control strip with every option visible | Numbered checklist (1 Lesson, 2 Microphone, 3 Screen, 4 Camera). Finished steps collapse to one line with **Change** | The teacher always knows what's left to do. The next step to do gets an ink number badge, a little lift, and an ink action button. |
| Disabled red record button | **Start recording** is never disabled: pale red while `aria-disabled`, solid red when ready, with the readiness line above it | A click never feels dead. Red appears only once recording is possible. |
| Big black empty preview | Light dashed placeholder until a screen is chosen; the dark video frame appears only when there is video | In light mode a black box dominates the page and looks broken. |
| Status text in the header | Header progress `1 Set up · 2 Record · 3 Review` (decorative, `aria-hidden`), with a red badge while recording and amber while paused | Orientation at a glance. Views carry the real headings. |
| Recording state shown on a badge only | Recording mode replaces the setup UI: 48 px timer, "We can hear you ✓" meter, **Stop & save**, Pause, Add chapter (count), Floating controls, Discard take. Red ring around the stage. Full-width amber banner when paused | Recording is impossible to mistake for set-up, and pause is impossible to miss. |
| Results row | Review card: "Take saved ✓", heading, where the file went, editable name, chapters with YouTube check, **Record another take** | Trust: the teacher sees where the file went. |

## Layout

- ≥ 1000 px: 440 px mode panel on the left; the stage on the right is sticky and capped at
  `55vh` (16:9 kept by width `min(100%, 55vh × 16/9)`). Under the stage sits a quiet
  "Good to know" panel (setup) or "While you teach" panel (recording). Both are static text.
- 720–999 px: one centred 680 px column with the stage on top (≤ 42vh).
- < 720 px: 16 px gutter, 160 px stage strip on top, the Start bar sticks to the bottom of
  the viewport (blurred paper backdrop). Stop & save and Record another take stick while
  their card is in view. Dialogs become full-screen sheets. No horizontal scroll at 360 px.
- "Your takes" spans the full width below the workspace and is hidden while recording.
- Every single-column grid uses `minmax(0, 1fr)`, so long device names or file names wrap
  or ellipsize instead of widening the panel.

## Hooks beyond the contract (all optional for the binding)

The design works with plain `textContent` on every contract id. Icons on buttons whose
label changes (`btnStart`, `btnPause`, `btnStop`, `btnChooseScreen`, `btnFolder`,
`btnScPlay`, Resume) are CSS pseudo-elements, so setting their text never removes the icon.

| Hook | Meaning |
|---|---|
| `.step[data-status]` | Drives the chip colour and number badge. Only set the chip's text. |
| `.step [data-action="expand-step"]` | "Change" link in a collapsed summary: remove `data-collapsed`. |
| `#scRun [data-action="cancel-sound-check"]` | Cancel link in the running sound-check panel. |
| `#sysAudioChip[data-status="ok"\|"missing"]` | Green "Included ✓" or amber "Not included". Neutral without it. |
| `#chapterIssues[data-kind="success"\|"warning"]` | Green "ready for YouTube" or amber rule hints. |
| `.take[aria-current="true"]` | The take currently open in Review (ink edge). |
| `.banner[data-kind="recovery"]` | Recovery card (shield icon). `info`, `success`, `warning` and `error` are styled too. |
| `#btnPause[aria-pressed="true"]` | Icon becomes ▶ (label "Resume" set by the binding). Same for `[data-action="pause"]` in the popout. |
| `.bubble` `--bx --by --bs` | Bubble centre (0..1) and diameter (fraction of height). Without them the preview follows the shape, size, mirror and corner controls through `:has()`. |
| `[data-actions] > button` | Injected action buttons need no classes. In banners the first button is the main (ink) one. |
| `.take-meta-row` | Wrapper inside `.take-meta`; the dot that would start a wrapped line is clipped. |

Collapsed steps: everything in `.step-body` hides except the message slots, the screen
summary, the audio chip, the two-screens tip, the Change button and the lesson's
"Will save as". The mic step shows `#micSummary` plus Change.

Floating controls (`body.popout`, 320 × 420): pill + lesson name, 48 px timer, meter with
label, Stop & save (with a red square), Pause / Add chapter / ⋯. The confirm part
overlays the whole window. When `[data-part="nosound"]` is visible, the whole window
turns red (`:has()` swaps tokens) and notes are hidden. `.pop` is capped at 520 px and
centred if the window is resized. The template uses full inline SVG because it renders in
another document; the main page uses an inline `<symbol>` sprite.

## Tokens

Theme selectors: `:root, [data-theme="light"]` (light), then
`@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) }` and
`[data-theme="dark"]` (dark). Every theme block declares literal values, so
`body.popout[data-theme]` in the PiP window themes itself independently of its `<html>`.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#f6f5f1` | `#17181a` | Page (warm paper) |
| `--surface` | `#ffffff` | `#1f2023` | Cards, inputs |
| `--surface-raised` | `#ffffff` | `#26272b` | Toasts, banners, dialogs |
| `--surface-2` / `-3` | `#f2f0eb` / `#e9e6df` | `#26272b` / `#2f3035` | Sunken panels, chips, hover |
| `--line` / `--line-strong` | `#e6e3dc` / `#d3cfc6` | `#2e2f34` / `#3e4046` | Hairlines, secondary-button edges |
| `--border` | `#86888d` | `#7d8087` | Input and switch borders (≥ 3:1) |
| `--text` / `--text-2` / `--muted` | `#1c1d1f` / `#45474c` / `#6b6d72` | `#ededee` / `#c9cacd` / `#a7a9ae` | Text levels |
| `--focus` | `#1a5fd0` | `#8ab4ff` | 2 px ring, 2 px offset |
| `--ink` / `--on-ink` | `#1c1d1f` / `#fff` | `#ededee` / `#17181a` | Primary buttons, switches, selected segments |
| `--record-fill` / `--record` | `#c0392b` | `#c43c2e` / `#ff6b5e` | Start recording, live dot, stop square (red only for recording) |
| `--good*` | `#1e6b41` on `#e7f3eb` | `#74d49d` on `#1b2b21` | Done chips, verdict "Sounds great" |
| `--warn*` | `#8a5300` on `#fcf2db` | `#f3c56b` on `#30280f` | Needs attention, "Usable" |
| `--bad*` | `#b3261e` on `#fcecea` | `#ff8a80` on `#351e1c` | Errors, red verdicts, Delete |
| `--info*` | `#1f4f8f` on `#ebf1fa` | `#9cc2ff` on `#1b2535` | Tips, info messages |
| `--paused` | `#f2b632` | `#f2b632` | Paused banner (ink text) |
| `--meter-*` | track `#ebe8e1`, good zone `#d5e9db`, loud zone `#f5dcd7`, fills quiet `#727479` / good `#2b8a57` / loud `#c0392b` | track `#2c2d31`, zones `#1e3628` / `#3f2422`, fills `#8b8d93` / `#48b97a` / `#ff6b5e` | 3-zone meter |

Type: one family (`Segoe UI Variable Text/Display`, `Segoe UI`, then system fallbacks;
`Inter` is listed before `system-ui` only so Linux screenshots have Segoe-like metrics).
Sizes 14 / 16 / 20 / 28 and a 48 px tabular timer. Weights 400 / 600. One exception: `kbd`
keycaps are 13 px so they sit inside 14 px lines. Spacing on an 8 px grid (4 px half
steps). Radius 8 px on controls, 12 px on cards and dialogs (8 + 4 for nested corners),
pills fully round. Elevation uses warm-tinted shadows in light mode and deeper, flatter
ones in dark mode.

Meter: `.meter` draws everything from `--level`, `--peak`, `--good-from` (0.53) and
`--good-to` (0.8): zone tints in the background, a fill (`::before`) coloured by
`data-zone`, and a peak tick (`::after`). The "Too quiet | Good | Too loud" labels use the
same variables for their column widths, so they always line up with the zones.

## Contrast checked (WCAG 2.x relative luminance)

| Pair | Ratio |
|---|---|
| L text `#1c1d1f` / bg `#f6f5f1` | 15.46 |
| L muted `#6b6d72` / bg · surface · surface-2 | 4.75 · 5.18 · 4.55 |
| L border `#86888d` / surface | 3.55 |
| L white / record `#c0392b` | 5.44 |
| L Start (aria-disabled) `#a3301f` / `#fbe9e6` | 5.97 |
| L good / warn / bad / info on their soft fills | 5.69 / 5.69 / 5.70 / 7.19 |
| Ink `#1c1d1f` / paused `#f2b632` | 9.25 |
| L focus `#1a5fd0` / bg · surface | 5.36 · 5.85 |
| L meter fills / track (non-text, ≥ 3) | good 3.52 (3.39 on good zone), quiet 3.82 |
| D text `#ededee` / bg `#17181a` | 15.19 |
| D muted `#a7a9ae` / bg · raised | 7.55 · 6.34 |
| D border `#7d8087` / surface | 4.12 |
| D white / record fill `#c43c2e` | 5.21 |
| D red `#ff6b5e` / bg | 6.36 |
| D Start (aria-disabled) `#ff8f85` / `#3a2320` | 6.61 |
| D good / warn / bad / info on their soft fills | 8.24 / 9.06 / 6.79 / 8.49 |
| D focus `#8ab4ff` / bg | 8.51 |
| D meter good / track · good zone | 5.56 · 5.27 |
| NO SOUND white · `#ffd6d1` / `#b3261e` | 6.54 · 4.92 |
| Stage label white / translucent black over a light slide (≈ `#676767`) | ≈ 5.7 |

## Accessibility

Landmarks `header` and `main` (skip link). One `section[aria-labelledby]` with an h2 per
step. `fieldset`/`legend` for shape, size and corner. Switches are checkboxes with
`role="switch"`. Meters have `role="meter"` and `aria-valuetext`. Focus targets for script:
`#scHeadline`, `#reviewHeading` and `.banner` all have `tabindex="-1"`; settings and help
dialogs autofocus their title; confirm autofocuses Cancel. Targets are at least 24 px, and
40–52 px for main actions. `forced-colors` block: borders become `CanvasText` /
`ButtonText`; meters, switches, the selected segment and the CSS-drawn icons use system
colours with `forced-color-adjust: none`. Reduced motion removes the pulse, the toast,
the dialog and the countdown animations.

## Demo states

`?state=setup | ready | soundcheck | recording | paused | review | library | popout`, plus
`checking`, `countdown`, `blocked`, `nosound`, `settings` (`&advanced=1`), `help`,
`confirm`, and `popout&part=idle|countdown|confirm|nosound`. `&theme=light|dark`.
