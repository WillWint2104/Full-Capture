# Working on Full Capture

Guidance for every agent (Claude Code, Codex or others) and person working in
this repository.

## What this is

A screen recorder for teachers that ships as **one file**, `full-capture.html`,
opened directly in Chrome or Edge 116+. Keep it that way: the source in `src/`
can be as structured as it needs to be, but the recording experience stays a
single file you open, check and record with.

```sh
npm install                     # esbuild + Playwright
npm run build                   # src/ -> full-capture.html (commit both)
npm test                        # unit tests (node:test)
npx playwright test             # browser tests from file:// with fake camera, mic and screen
node scripts/check-contract.mjs # the page has every id and template the code expects
```

Build before running the browser tests: they open the built file.
`docs/ARCHITECTURE.md` describes the design and each module's contract.

## What matters most

Review and test effort follows this order of risk:

1. **Recording starts reliably.** Pressing Start records, or says clearly why
   it can't and where to fix it. Never silently, never twice, and the page
   never shows "Recording" when nothing is being recorded.
2. **Audio and video are captured correctly** for the whole take: the right
   sources, still live, in sync.
3. **The teacher can recover from interruptions**: an unplugged mic or camera,
   screen sharing stopped, a crashed tab, a full disk, a folder that lost its
   permission.
4. **Finished footage is never silently lost.**

Changes to session state transitions, the recorder, the journal, the sinks,
media sources or export get the closest review.

## Review policy

- **The agent that implements a change is never its only reviewer.** An
  independent agent (a separate Claude Code or Codex agent with fresh context)
  reviews the diff, the tests and the affected code paths.
- **Reviews are risk-based and proportional to the change.** Reviewers report
  what threatens the change's goal and the priorities above. They do not try to
  list every conceivable problem; low-impact observations go into a short
  follow-up list instead of the current change.
- **Roles.** The *implementation agent* makes the change. The *independent
  reviewer* looks for regressions, race conditions, media-integrity and
  data-loss risks, security issues, and accessibility problems where the UI
  changes. The *verifier* runs the targeted tests, checks that each fix works
  and writes a short final assessment. For small changes the reviewer and the
  verifier can be the same independent agent.
- **Findings are addressed and the corrections verified** (with tests) before
  approval is requested.

| Change                              | Review                                         | CodeRabbit        |
| ----------------------------------- | ---------------------------------------------- | ----------------- |
| Small bug fix                       | Independent Codex/Claude review                | No                |
| UI and accessibility improvement    | ChatGPT + independent agent                    | No                |
| Routine feature development         | Independent agent + automated tests            | No                |
| Major recording or export change    | Independent agent + integration tests          | Only if high risk |
| Major architecture change           | Independent review + CodeRabbit                | Yes               |
| Release candidate                   | Full verification + selective CodeRabbit       | When justified    |

### CodeRabbit

CodeRabbit reviews are reserved for major, high-risk changes and important
release milestones. Do not request them for routine pull requests: automatic
reviews are switched off in `.coderabbit.yaml`. Use CodeRabbit only when the
project owner asks for it, or when a major high-risk change has been approved
for external review; request it with a `@coderabbitai review` comment on the
pull request.

## Tests

- Keep the unit, integration (harness) and browser test suites passing.
- A bug fix comes with a regression test that fails without the fix.
- Reproduce timing bugs deterministically (for example by delaying a device
  or picker in a page init script) rather than relying on a busy machine.
  Investigate a flaky test; never weaken an assertion or retry it to green.

## Pull requests and merging

- Work on a feature branch; changes reach `main` through a pull request.
- Never bypass branch protection or required GitHub checks.
- **Nothing is merged without explicit approval from the project owner.**

## Scope

Full Capture (the HGL Lesson Recorder) is a simple, dependable screen
recorder with lightweight post-production for teaching videos:

**Prepare → Record → Review/Trim → Export**

A teacher opens the recorder, picks their HGL Studio screen, records,
marks mistakes, removes unwanted footage, applies a stored intro and outro,
adjusts basic audio and exports an upload-ready MP4. Everything beyond that
is optional future work. HGL Studio is a separate application (lessons,
mathematics, handwriting, widgets, questions, presentations); the recorder
never duplicates its teaching features.

| Feature                                                        | Decision                    |
| -------------------------------------------------------------- | --------------------------- |
| Reliable screen recording, microphone and optional camera      | Keep — essential            |
| Saved recording settings and preflight checks                  | Keep — essential            |
| Floating controls and mistake markers                          | Keep — essential            |
| Simple timeline for trimming mistakes                          | Keep — essential            |
| Upload and store intro/outro video files                       | Keep — essential            |
| Automatically add intro/outro during export                    | Keep — essential            |
| Basic narration/music volume control and fades                 | Keep — later in core flow   |
| Adobe Podcast audio replacement (manual export/import)         | Keep — simple workflow      |
| Basic MP4 export settings                                      | Keep — essential            |
| Thumbnail creator integration, direct YouTube publishing       | Defer                       |
| AI handwriting reconstruction                                  | Separate project, paused    |
| Built-in intro/outro animation creator                         | Do not build                |
| AI editing, automatic transcription, scene reconstruction      | Do not build                |
| Complex multitrack editing, audio workstation, effects suite   | Do not build                |

Rules that follow from this:

- Preserve what works (screen/window recording, mic checks, webcam,
  presets, floating controls, pause/resume, recovery, the takes library).
  No rewrites of working systems, and no recording-UI redesign while
  reliability fixes are outstanding.
- Edits are non-destructive until export, and the original recording is
  always kept independently of any export.
- Intro, outro and music files are imported once and stored locally; an
  invalid or missing asset must never block recovery of a recording.
- Keep media processing in the browser where it is reliable. A small local
  processing component, or any move to a desktop framework, needs a
  documented justification and the project owner's approval first.
- No drawing canvas, handwriting, question tools or general-purpose video
  editor: those belong to HGL Studio or nowhere.
- Avoid large rewrites, new dependencies without a clear need, and
  speculative abstractions.
- Build one feature stage at a time (`docs/PLAN.md`), and stop for approval
  before starting each stage. No unrelated development and no broad review
  campaigns.
