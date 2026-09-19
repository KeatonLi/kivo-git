# Changelog

## Unreleased

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

- Initial IdeaGit MVP.
- Added repository status, local changelists, selective commit, native diff, branch checkout, sync actions, and recent history.
- Added a theme-aware motion system with reduced-motion support.
