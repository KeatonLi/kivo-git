# Kivo Git parity design QA

source visual truth path:

- IntelliJ IDEA Git Log reference: https://resources.jetbrains.com/help/img/idea/2026.2/git_log_view.png
- Rebased reference: https://raw.githubusercontent.com/DetachHead/rebased/master/screenshot.png
- Behavioral snapshot: `docs/IDEA_PARITY.md`, pinned to Rebased `d5f15c9746e98e2f50d43196c9fbbd58b64edda4`

implementation screenshot path: unavailable

viewport: intended VS Code Changes sidebar and bottom History Panel desktop viewports; no Extension Host capture available in this environment

source and implementation pixel dimensions: source captures are available at their URLs; implementation pixels were not captured

density normalization: not applicable; implementation capture is missing

state: dark-theme Changes sidebar for files/commit plus bottom History Panel with branch navigator, compact filters, multi-lane history, and selected-commit details

## Evidence status

The source references were inspected and the implementation was statically reviewed after the two-surface parity change. A browser-rendered implementation comparison could not be completed because this workspace has neither a usable VS Code Extension Host nor an installed Chromium executable for Playwright. The static and Git-fixture gates pass; an Extension Development Host smoke test is included for CI/release runners, but this sandbox's downloaded Electron binary cannot launch. Build success is not visual verification.

## Findings

- [P1] Browser-rendered comparison is blocked. The actual left Changes placement, bottom History placement, row density, theme tokens, and Graph curves still require a real VSIX install and screenshot comparison against the reference.
  Evidence: no implementation screenshot could be captured.
  Impact: static code inspection cannot prove pixel/interaction parity.
  Fix: install the parity VSIX in VS Code and compare both the Changes sidebar and bottom History Log at the same viewport; record the result in the next QA iteration.

## Implementation checklist

- [x] Lock Rebased reference commit and IDEA two-surface tool-window contract.
- [x] Split the runtime into independent Activity Bar Changes and bottom Panel History views sharing repository state.
- [x] Move the Log hierarchy toward compact IDEA-style filters, branch/ref navigator, dense rows, and right-side Changed Files/details.
- [x] Add path filtering and tag presentation to the history model.
- [x] Disable Kivo-only Graph/list/counter motion during parity mode.
- [x] Run typecheck, JavaScript syntax checks, routing/manifest tests, real-Git integration tests, and compile.
- [x] Add a CI/release Extension Development Host entry-point smoke test plus VSIX structural verification.
- [ ] Capture and compare the real VS Code Extension Host view.
- [ ] User A/B approval of placement, Graph topology, filters, selection, and details.

## Comparison history

This is the first parity-mode implementation iteration. No browser-rendered P0/P1/P2 comparison was possible, so no visual fix can be claimed as verified yet.

final result: blocked
