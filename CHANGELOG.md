# Changelog

## Unreleased

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
