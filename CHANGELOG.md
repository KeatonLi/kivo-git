# Changelog

## Unreleased

## 0.3.0-beta.11 - 2026-09-20

- Renamed the bottom Panel container to **Kivo Git History**, with the active branch retained as context instead of replacing the product name.
- Added an IDEA-style draggable divider between the History branch tree and commit graph. It has a subtle host-theme hover/focus treatment, keyboard resizing, double-click reset, Escape cancellation, responsive collapse behavior, and saved width.
- Changed files in the left Commit tool now resolve against the user's active VS Code file icon theme. Filename, parent-qualified filename, compound extension, parent-qualified extension, language, light, and high-contrast associations follow VS Code's documented precedence; image and font themes are both supported with a safe native fallback.
- Added association-precedence tests plus browser-fixture checks for drag, keyboard resize, reset, and History layout.

## 0.3.0-beta.10 - 2026-09-20

- Added a visible native **Show Log** action beside Refresh in the left **Commit** view title. It directly focuses the separate bottom **Log** panel, so the Commit-to-History transition follows the requested IDEA-style mental model.

## 0.3.0-beta.9 - 2026-09-20

- Rebuilt the left Activity Bar surface as an IDEA-style **Commit** tool window: compact operation strip, single blue **Changes** row, flat dense file list, and an anchored Amend/message/Commit/Commit-and-Push base.
- Rebuilt the bottom Panel surface as **Log: &lt;branch&gt;** with a narrow action rail, searchable local/remote/tag tree, compact filter strip, **Author → Graph → Commit → Date** rows, and a nested Changed Files tree above commit details.
- Changed the contributed View names from `Changes`/`History` to `Commit`/`Log`, and update the real VS Code Log title with the active branch.
- Added a real **Commit and Push…** operation: the commit completes and clears the draft first; a later push failure remains visible without pretending that the commit failed.
- Fixed a root incremental-rendering defect that stripped `#app` after the first snapshot and collapsed the full-height Log tool window.
- Added Git integration coverage for commit-then-push, surface/manifest/layout contracts, a visual Webview fixture, and browser-fixture interaction checks.

## 0.3.0-beta.8 - 2026-09-19

- Corrected the Git window architecture to match the requested IDEA mental model: **Changes** is a real left Activity Bar view, while **History** is a real bottom Panel view.
- Retired the single bottom-panel `Local Changes | Log` tab switcher. Graph, branches, filters, and commit details now render only in bottom History; files, changelists, diffs, and Commit render only in left Changes.
- Made the two views share one repository snapshot, sync state, and operation feedback while retaining independent UI context.
- Added view-routing, manifest, webview-composition, real-Git integration, VSIX structural, and Extension Development Host command-smoke checks. CI and the release workflow now run the Extension Host check before publishing a release.

## 0.3.0-beta.7 - 2026-09-19

- Locked the next iteration to a Rebased/IntelliJ IDEA parity contract before adding Kivo-specific polish.
- Tightened the bottom Git Tool Window header, peer tabs, compact Log filters, branch/ref navigator, and right-side Changed Files/details layout.
- Added path-aware history filtering and tag refs, and disabled Kivo-only Graph/list/counter motion in parity mode.
- Added a reproducible parity QA report that stays blocked until the VSIX is verified in a real VS Code Extension Host.

## 0.3.0-beta.6 - 2026-09-19

- Realigned the bottom Kivo Git surface with the familiar Git Tool Window hierarchy: `Local Changes` and `Log` are peer tabs, while the graph is only the first column inside Log.
- Added `Kivo Git: Show Log`, which focuses the bottom Panel and opens Log directly instead of creating a separate Graph destination.
- Rebuilt Log into a three-region workspace: branch navigator, commit graph/table, and selected-commit details; narrow Panels collapse gracefully.
- Made branch filtering follow reachable commit history rather than matching only the commit carrying the branch label.

## 0.3.0-beta.5 - 2026-09-19

- Moved Kivo Git from the left Activity Bar to VS Code’s bottom Panel, so Changes and Log have the width of a real Git tool window.
- Rebuilt Graph as a compact Log table: fixed graph lanes, commit, author, and date columns; inline refs; denser rows; and faster selection feedback.
- Replaced the extension and Panel artwork with Kivo’s K-topology mark, including a dedicated Marketplace PNG icon.

## 0.3.0-beta.4 - 2026-09-19

- Added loading-state motion and keyboard navigation for Graph filters, history loading, and Pull strategy menus.

## 0.3.0-beta.3 - 2026-09-19

- Added incremental Graph history loading with branch, author, time-window, and text filters.
- Added explicit Pull strategies: fast-forward only, Rebase, and Merge, with safer intent feedback.
- Added a first Kivo icon layer for Graph, Changes, and synchronization surfaces.

## 0.3.0-beta.2 - 2026-09-19

- Improved Graph hand feel with roving focus, Arrow/Home/End navigation, lazy detail requests, retryable detail errors, and stable scroll context.
- Added lane-aware Graph colors and clearer sync disabled/loading feedback.
- Renamed the GitHub repository to `KeatonLi/kivo-git` and aligned release artifacts with the Kivo Git brand.

## 0.3.0-beta.1 - 2026-09-19

- Formalized the Kivo Git brand and Graph history milestone in the release artifacts.

## 0.2.0-beta.3 - 2026-09-19

- Renamed the product to Kivo Git while preserving the internal extension and command IDs for upgrade compatibility.
- Added a real multi-lane Git Graph with branch, remote, tag, and HEAD refs, merge topology, commit search, commit details, and file-level history diffs.

## 0.2.0-beta.2 - 2026-09-19

- Reworked the repository header, changelists, popovers, and feedback states with a cohesive theme-aware visual system and VS Code Codicons.
- Added quiet background auto-fetch with a configurable interval and non-interactive timeout.
- Added explicit upstream, incoming commit, outgoing commit, last-sync, and remote-error states.
- Added real-repository coverage proving fetch refreshes diverged ahead and behind counts.

## 0.2.0-beta.1 - 2026-09-19

- Added event-driven repository refresh with unchanged-snapshot suppression.
- Added stale-read protection around Git write operations.
- Preserved Webview controls across updates to keep focus, cursor, selection, and scroll state stable.
- Added FLIP motion for files moving between changelists and smooth branch/changelist transitions.
- Added active changelists with create, rename, delete, whole-list selection, and persisted automatic assignment.
- Added keyboard branch navigation, accessible file selection, and Webview syntax validation.
- Added single-click diff preview, roving file keyboard navigation, Space toggle, and Shift range selection.
- Added optimistic changelist drag-and-drop with a native-feeling drag avatar and immediate FLIP feedback.
- Added inline operation feedback and reliable focus restoration for changelist menus.
- Added a guarded release command and version-driven GitHub workflow that publishes the tag, VSIX, and checksum.

## 0.1.0

- Initial Kivo Git MVP (the internal compatibility identifiers remain `ideaGit.*`).
- Added repository status, local changelists, selective commit, native diff, branch checkout, sync actions, and recent history.
- Added a theme-aware motion system with reduced-motion support.
