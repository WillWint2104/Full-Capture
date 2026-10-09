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

Stay on the task at hand: no unrelated development and no broad review
campaigns. Planned order of work:

1. Recording reliability and UX
2. Mistake markers and easy editing (mark errors while recording, review the
   cuts, produce a clean take)
3. Audio production (soundtracks, ducking, intro/outro levels, Adobe Podcast
   exchange)
4. Production automation (branding, standard exports, thumbnails,
   publish-ready packages)
