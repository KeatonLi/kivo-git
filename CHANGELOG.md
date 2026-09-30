# Changelog

## Unreleased

## 0.3.13 - 2026-09-30

- Highlight commits not yet pushed to their tracking branch with a subtle green row, green node, and Unpushed badge in History and Recent commits; refresh the exact commit membership after tracking refs move.
- Replace the native Push warning dialog with a themed in-extension review showing repository, source and destination branches, outgoing commits, and changed-file count.
- Keep actions visible in narrow and short views, support Escape and keyboard focus containment, and route behind or rejected branches to Fetch and Review.
- Keep reviewed refs on the extension host with one-use confirmation IDs, revalidate before pushing, and dismiss stale reviews after repository or branch changes.

## 0.3.12 - 2026-09-30

- Show the current branch's latest five commits independently of History filters; click a commit to preview its changed files, then open a file diff or full History.
- Group recent commits by absolute date and show compact times with seconds, keeping the full timestamp on hover.
- Remove redundant counts for a single changelist or file group; retain counts when they distinguish multiple lists or tracked/untracked groups.
- Cache recent commit files, support retry, and ignore late responses after selecting another commit or repository.

## 0.3.11 - 2026-09-30

- Show the selected repository in a compact header above Commit actions, with the full path on hover and a clickable picker in multi-repository workspaces.
- Truncate long repository names without squeezing toolbar controls and update the header when the selected repository changes.

## 0.3.10 - 2026-09-30

- Remove repeated file-status labels from the changes list; keep Git state in filename colors, hover details, and screen-reader descriptions, including when selected.
- Use normal theme foregrounds for Commit toolbar icons and the same clear accent for Branches and History.
- Fit Recent commits to its contents, move timestamps below full-width subjects, and add a persistent collapse control; retain manual resizing with a reset to automatic height.

## 0.3.9 - 2026-09-29

- Add Rollback for selected files in the Commit view and file context menu, with a native confirmation listing affected paths.
- Restore selected tracked changes to HEAD, move new files to Trash, and recheck file state before changing anything; keep unrelated staged work intact.

## 0.3.8 - 2026-09-29

- Preload the selected repository's local Git snapshot and file icon theme after extension activation, keeping the snapshot current while views are hidden.
- Show the cached snapshot as soon as a view opens, then check the remote asynchronously so Fetch does not hold up the first render.

## 0.3.7 - 2026-09-29

- Group tracked changes above untracked files within each changelist, and color file names and status by added, modified, deleted, renamed, or untracked state using VS Code theme colors.
- Keep only Recent commits in the lower Commit area; move Git identity, upstream setup, and detached-HEAD branch creation into the toolbar menu.

## 0.3.6 - 2026-09-29

- Replace unclear Working and Untracked file badges with Modified, New file, or the specific change type; explain Git tracking and staging in the tooltip.

## 0.3.5 - 2026-09-29

- Show the active repository name before Commit in the left view title, updating when the selected repository changes.
- Refresh branch status when VS Code Git updates repository state, and check the selected repository immediately after switching.
- Check remote refs on manual Refresh and every minute by default while Kivo Git is visible.

## 0.3.4 - 2026-09-29

- Search the full repository history by commit text or hash, author, date, path, and ref while retaining automatic pagination.
- Show per-repository and aggregate working-tree counts clearly in multi-repository workspaces, and avoid redundant status scans.
- Explain remote checks and failures in the Commit view and offer a direct action to configure a branch's upstream.
- Show absolute timestamps in History, commit details, and recent commits; preserve whitespace in committed file paths.
- Load the next History page only at the bottom of the scrollable list, with a compact pagination hint.
- Display numeric incoming and outgoing commit counts beside local branches, including non-current branches.

## 0.3.3 - 2026-09-28

- Show the total number of uncommitted files on the Kivo Git Activity Bar icon, updating on file changes and while the view is hidden; clear the badge for a clean workspace.
- Keep full History timestamps legible at narrow widths by wrapping the date and time.

## 0.3.2 - 2026-09-28

- Show incoming and outgoing markers beside each local branch with a configured remote upstream when the refs differ.
- Add an Update action to tracked non-current local branches in History; fetch only the selected upstream and fast-forward only that branch without switching HEAD or changing the working tree. Diverged branches remain untouched.
- Align the Commit branch picker typography with History and highlight the branch toolbar button.
- Automatically load older History while scrolling, show local timestamps to the second, and strengthen the graph lanes and selected commits.
- Add Update and Push to tracked local branch menus, including other local branches without switching checkout; review the destination and outgoing commits before pushing.
- Label History's action rail, remove the duplicate clear control and change summary, and show five recent commits in a compact timeline with working tree and remote counts.
- Discover repositories through VS Code's Git integration so nested repositories appear in the switcher and file actions use the matching repository.

## 0.3.1 - 2026-09-28

- Kept Pull available on tracking branches even when no incoming commits are cached; Push still requires outgoing commits.
- Made the branch picker compact, placed the current branch first, and collapsed remote branches until expanded or searched.
- Added a visible Commit toolbar button that opens Kivo Git History in the bottom Panel.

## 0.3.0 - 2026-09-28

- Corrected the Marketplace category to `SCM Providers` so the release can be uploaded.
- Renamed the Marketplace extension ID to `KeatonLi.kivo-git` because `idea-git` was already taken.
- Added optional current-line inline blame with delayed, bounded Git lookups, short-lived caching, unsaved-edit safety, hover details, and a Command Palette toggle.
- Preserved ID-keyed controls when opening file search so the file tree cannot inherit splitter drag handlers during DOM reuse.
- Made checkbox decorations ignore pointer events so mouse selection reaches the actual input reliably.
- Gave file review and the commit form 65% of the initial sidebar height while preserving user-resized layouts, and removed obsolete branch-flight animation bookkeeping.
- Restricted file movement animation to actual changelist transfers, removed repeat row/detail entrance effects and counter bounce, and stopped active animations when motion is reduced or the view is hidden.
- Improved keyboard focus, selected-row text contrast, high-contrast selection borders, narrow summary wrapping, and long notification text; reduced-motion mode now disables animations rather than accelerating them.
- Unified filtered selection, list checkboxes, and keyboard ranges; added an inline selected-file count, hidden-selection guard, and whole-file commit explanation for staged changes.
- Preserved unrelated staged work and restored newly staged files after commit failures; validated current selections, treated Git pathspecs literally, and committed both sides of selected staged renames.
- Protected changelist data with schema validation, atomic writes, and cross-window locking; preserved assignments across tracked renames and recognized all unmerged Git states.
- Serialized Git identity updates with other Git operations and added regression coverage for selection, persistence, failed hooks, literal paths, and recent messages.
- Displayed the effective Git commit identity in Repository status and added a guided repository-local name and email setup action when it is missing, so commit authorship is clear before committing.
- Added a Recent Messages action beside Commit that lists the current branch's last 20 commits and reuses the full selected message; replacing an existing draft requires confirmation, and edits made while choosing are preserved.
- Previewed the focused changed file while navigating the Commit list with Arrow keys, Home, or End, so keyboard review follows the selected row without leaving the list.
- Added Staged and Working tree choices to Commit file filtering, so partial staging and untracked edits can be found directly; existing saved type filters are preserved.
- Added Show Line Blame to the editor context menu to identify the current line's author, commit time, message, and hash, with quick actions to copy the hash or open file history.
- Explained detached HEAD in Repository status and the History title, showed its commit hash, and added a Create branch action that starts from that exact commit so new work stays easy to find.
- Added separate staged and unstaged diff actions for files changed in both the index and working tree, so commit review can distinguish HEAD → Index from Index → Working Tree without altering either state.
- Updated History typography to use the native macOS system font where available, with a Segoe UI Variable fallback on Windows, and increased commit-row text for easier reading.
- Added Ctrl+A / ⌘A on a focused Commit file row to select every changed file while keeping keyboard focus on the current row.
- Added an expandable Commit file search, opened with Ctrl+F / ⌘F or the toolbar, that filters by path and Git status and remembers its query per repository.
- Added a type filter beside Commit file search for modified, added, deleted, renamed, untracked, and conflicted files; the active filter is saved per repository.
- Made History hash searches load older commit pages automatically until a matching commit is found or the repository history ends.
- Showed index and working-tree status separately on changed-file rows (for example, `M·`, `·M`, and `MM`) with accessible explanations.
- Added the `M` keyboard action on a focused Commit file to move that file, or the current multi-selection, to another changelist.

## 0.3.0-beta.25 - 2026-09-24

- Added a restrained Repository Status summary beneath Changelists, using real working-tree and upstream counts to explain whether the branch is in sync, ahead, behind, or diverged.
- Showed the tracked branch and last remote check state, with a direct fetch action and clear missing-upstream or fetch-error messages.
- Kept the displayed remote-check timestamp tied to fetches, so push and pull do not claim a new fetch happened.

## 0.3.0-beta.24 - 2026-09-24

- Removed the extra space between branch icons and names in the History branch tree.
- Displayed the current branch's behind and ahead counts beside a remote check action in History; counts update after fetching and show an explicit state without an upstream.

## 0.3.0-beta.23 - 2026-09-24

- Fixed History getting stuck loading when switching between refs with identical commit windows.
- Showed changed files for merge commits by comparing against the first parent.
- Kept the selected History ref in sync after renaming or deleting that branch.

## 0.3.0-beta.22 - 2026-09-24

- Loaded History from the selected branch or tag directly, including tips beyond the recent all-ref window; retained clear partial-result messaging when searching older history.
- Kept commit details aligned with active filters and restored selected commit details when reopening History.
- Cached parsed Git history until HEAD, refs, or the requested window changes so working-tree refreshes avoid repeating Git log.
- Improved History filter spacing, commit row legibility, empty states, and the load-more action; included detached HEAD commits in the all-ref view.

## 0.3.0-beta.21 - 2026-09-23

- Fixed Show History from the Commit branch popup to open and filter the History panel, including tags and newly opened History views.
- Kept Local, Remote, and tag searches incremental even when many branches match, and avoided rendering the closed branch popup on every update.
- Reset incompatible History filters during file and branch navigation, restored keyboard focus after the final batch, and removed repeated Graph row entrance animation.

## 0.3.0-beta.20 - 2026-09-23

- Added complete File, Branch, and Commit context menus with keyboard access and native Explorer/history actions.
- Added draggable, persisted Commit pane sizing plus lazy Branch groups/search and consistent Graph loading/selection feedback.
- Refined the compact UI with shared spacing, row states, lighter surfaces, and fewer borders and radii.

## 0.3.0-beta.19 - 2026-09-23

- Added a compact Kivo Git submenu to Explorer files for opening a working-tree diff, filtering History to a file, revealing it in Commit, and moving it to another changelist.
- Added commit-row context actions in History for copying the full hash, creating a branch or lightweight tag at that commit, and confirmed detached-HEAD checkout, with mouse and keyboard access.
- Removed the disabled Amend placeholder from the Commit footer so every visible control now performs a real action.

## 0.3.0-beta.18 - 2026-09-23

- Isolated Commit and History view state per repository, including filters, drafts, selections, expansion, Graph position, and resizable pane dimensions; switching projects no longer carries stale filters into the next repository.
- Made Commit and Commit and Push react immediately to file selection, commit-message content, and running operations, with clear disabled-state explanations.
- Restored focus to the invoking file or branch after dismissing a context menu with Escape.
- Removed the retired spectral CSS layer so the compact host-theme UI now has one predictable restrained style path instead of competing overrides.

## 0.3.0-beta.17 - 2026-09-23

- Made changed-file actions reliably accessible through document-level right-click capture, including composed event paths across Webview refreshes.
- Added a compact, hover-revealed file action button that opens the same menu for mouse, trackpad, and keyboard users.
- Simplified the Commit and History visual layer to flat VS Code theme surfaces with quieter selection, focus, resize, and hover feedback; removed decorative gradients, glow, and lateral hover motion.

## 0.3.0-beta.16 - 2026-09-23

- Expanded the IDEA-style History branch menu with checkout, branch creation, merge into current, local rename, safe local/confirmed remote delete, copy name, and history filtering.
- Made every History pane boundary adjustable: branch tree/history, history/commit details, and Changed Files/commit information now support pointer dragging, keyboard resizing, double-click reset, Escape cancellation, responsive orientation, and persisted sizes.
- Added Git integration coverage for merge, rename, safe deletion, and protection of unmerged local branches.

## 0.3.0-beta.15 - 2026-09-21

- Fixed History branch and changed-file context menus by routing right-clicks through a stable webview root listener, so refreshes and lazy-loaded Graph rows no longer fall back to the native Cut/Copy/Paste menu.
- Kept the existing IDEA-style branch action flow: create and check out a new local branch from the exact selected branch, remote ref, or tag.

## 0.3.0-beta.14 - 2026-09-20

- Reworked Kivo Git History for large and highly branched repositories: history now loads in incremental pages as the user reaches the end of the list, without the former 800-commit ceiling.
- Virtualized History rows so the Webview only renders the visible commit window plus a small buffer, while retaining full scroll position, mouse selection, and Arrow/Home/End keyboard navigation.
- Made the Graph width react to the actual visible history window and available Panel width. Dense topology compresses safely instead of allowing an off-screen branch fan-out to consume the Commit column.
- Added pure layout regression coverage for dense 48-lane topology and a 1,000-commit virtual window, plus VSIX verification of the new runtime asset.

## 0.3.0-beta.13 - 2026-09-20

- Added the Kivo visual layer without changing the IDEA-style layout: restrained cyan-violet accents, clearer sync direction badges, focused branch and commit states, file status signals, tactile toolbar/commit controls, and Kivo Graph/Changes marks at the two surface entrances.
- Preserved the compact density and reduced-motion behavior while adding state-driven hover, focus, selected-row, and detail feedback.

## 0.3.0-beta.12 - 2026-09-20

- Added a real branch context menu to Kivo Git History. Right-click any local branch, remote ref, or tag to create and check out a new branch from that exact ref, check out an existing branch, or focus its history.
- Added Git ref validation and integration coverage proving a new branch starts at the selected branch commit instead of the current HEAD.

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
