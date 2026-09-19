# IdeaGit system roadmap

IdeaGit is not a Source Control sidebar skin. It is a complete Git work system for VS Code that preserves the IntelliJ IDEA mental model and improves it with continuous feedback, keyboard-first operation, reversible actions, and intent-aware assistance.

## Product principles

- **IDEA-compatible mental model:** changelists, commit review, branches, history, conflicts, stash, and shelf should feel familiar to an IDEA user.
- **Git-provider neutral:** GitHub, GitLab, Gitee, Bitbucket, and private Git servers work through the user's local Git installation.
- **Data safety first:** risky actions require a preview, a clear consequence, and a recovery path whenever Git permits one.
- **Continuous interaction:** preserve focus and spatial context; update only what changed; never replay motion because of a background refresh.
- **Keyboard complete:** every daily action must be possible without a mouse.
- **Native editor first:** use VS Code's diff, merge, text editor, commands, themes, and credential flow where they are stronger than a custom implementation.
- **Intelligence assists, never surprises:** suggestions are explainable and editable; AI must not run destructive Git commands autonomously.

## Priority legend

- **P0:** blocks a safe, coherent product.
- **P1:** required for the daily Git workflow.
- **P2:** required for advanced IDEA parity.
- **P3:** differentiating capability.

## v0.2 — Interaction Core

Goal: replace the prototype rendering model with a stable, event-driven interaction foundation.

### UI architecture

- [x] **P0** Replace full `innerHTML` rendering with stable keyed components.
- [ ] **P0** Split the UI into repository header, changes, commit, log, branches, operation center, and toast boundaries.
- [x] **P0** Preserve textarea value, cursor position, selection, scroll position, expanded nodes, and focused control across updates.
- [x] **P0** Update only changed files, changelists, branches, and commits.
- [x] **P0** Prevent stale async responses from overwriting newer repository state.
- [ ] **P0** Add typed request, response, event, and error contracts across the webview bridge.
- [x] **P1** Persist view state when the panel is hidden or VS Code reloads the webview.

### Repository event model

- [ ] **P0** Replace fixed 2.5-second full polling with file-system and Git-state watchers plus debounce.
- [x] **P0** Add a low-frequency fallback refresh without visible no-op renders.
- [x] **P0** Coalesce duplicate refresh requests and cancel obsolete reads.
- [ ] **P0** Separate cheap status reads from expensive branch and log reads.
- [ ] **P1** Refresh affected repositories only in multi-root workspaces.
- [ ] **P1** Surface paused, unavailable, detached HEAD, unborn branch, and bare repository states.

### Operation state machine

- [ ] **P0** Model Git operations as `idle → validating → running → success/error/cancelled`.
- [x] **P0** Assign an operation ID so polling and concurrent actions cannot corrupt feedback.
- [ ] **P0** Disable only conflicting controls while an operation runs.
- [ ] **P0** Support cancellation for fetch, pull, push, log loading, and other long-running operations when safe.
- [ ] **P0** Show actionable errors with retry or recovery instead of duplicate toast and notification messages.
- [ ] **P1** Add an operation timeline with command summary, duration, result, and recovery action.

### Keyboard and accessibility

- [ ] **P0** Add logical tab order and visible focus rings.
- [ ] **P0** Make file selection, diff opening, changelist movement, commit, and branch switching keyboard accessible.
- [x] **P0** Support `Escape`, arrow keys, `Enter`, type-to-search, and focus restoration in popovers.
- [x] **P0** Replace inaccessible hidden checkboxes with labelled, focusable controls.
- [x] **P0** Stop announcing the entire panel on every repository update.
- [ ] **P1** Add an IDEA keymap preset and editable command bindings.
- [ ] **P1** Verify zoom, high-contrast themes, screen readers, and reduced-motion mode.

### Motion foundation

- [x] **P0** Define motion tokens for press, hover, expand, layout change, operation, and success feedback.
- [x] **P0** Animate only real state changes; no animation on background no-op refreshes.
- [x] **P0** Implement keyed layout/FLIP motion for files moving between changelists.
- [x] **P0** Add smooth expand and collapse without `display: none` jumps.
- [ ] **P0** Add exit motion for popovers, toasts, removed files, and completed changes.
- [ ] **P0** Keep animation to transform and opacity on hot paths and target 60 fps.
- [x] **P0** Ensure all workflows remain understandable with motion disabled.
- [x] **P1** Add count morphing for changed files and ahead/behind values.
- [x] **P1** Add shared-element continuity from a selected branch row to the branch header.

### v0.2 acceptance criteria

- [ ] No focus, cursor, selection, or scroll loss during refresh.
- [x] No visible change and no entrance animation when Git state is unchanged.
- [x] Branch search does not recreate or replay the branch popup per keystroke.
- [x] Moving files between changelists has continuous layout motion and correct persisted state.
- [x] A running operation cannot be replaced by a stale polling result.
- [ ] Core flows work with keyboard only and with reduced motion enabled.

## v0.3 — Daily Git Workflow

Goal: reach strong IDEA parity for the operations developers perform every day.

### Changelists and local changes

- [ ] **P1** Create, rename, delete, reorder, and set the active changelist.
- [x] **P1** Select an entire changelist or multiple files with range and toggle selection.
- [ ] **P1** Move files through drag-and-drop, context menu, and keyboard commands.
- [ ] **P1** Add search and filters for modified, staged, untracked, ignored, and conflicted files.
- [ ] **P1** Show index and working-tree state separately when both exist.
- [ ] **P1** Add track, ignore, delete, rollback, and compare actions for unversioned files.
- [ ] **P1** Detect externally staged changes without silently changing their meaning.
- [ ] **P1** Support an optional staging-area workflow without destroying saved changelists.
- [ ] **P2** Move individual hunks and lines between changelists.
- [ ] **P2** Add automatic active-changelist assignment for new edits where the VS Code API permits it.

### Diff and review

- [x] **P1** Add single-click diff preview while keeping double-click for a full native diff editor.
- [ ] **P1** Navigate next/previous changed file and next/previous hunk.
- [ ] **P1** Open the source file at the selected changed line.
- [ ] **P1** Add ignore-whitespace, word-diff, and side-by-side/inline preferences through native APIs.
- [ ] **P1** Revert a file or hunk with explicit preview and confirmation.
- [ ] **P2** Select hunks or individual lines for a commit.
- [ ] **P2** Move a hunk to another changelist directly from the diff.
- [ ] **P2** Compare HEAD, index, and working tree when partial staging exists.

### Commit workflow

- [ ] **P1** Commit selected files, a complete changelist, or selected hunks.
- [ ] **P1** Add Commit and Push as a first-class action.
- [ ] **P1** Add Amend with a preview of the commit being replaced.
- [ ] **P1** Add commit-message history and repository commit templates.
- [ ] **P1** Show Git identity and provide a clear setup path when it is missing.
- [ ] **P1** Support author, sign-off, no-verify, and hook settings.
- [ ] **P1** Add configurable pre-commit checks: format, lint, typecheck, tests, and custom commands.
- [ ] **P1** Preserve the draft message and selection when a check or commit fails.
- [ ] **P1** Warn about secrets, debug statements, generated files, huge changes, and accidental binary additions.
- [ ] **P2** Support fixup and squash commit creation.

### Branch workflow

- [ ] **P1** Create a branch from HEAD, a selected branch, or a selected commit.
- [ ] **P1** Rename and safely delete local branches.
- [ ] **P1** Delete remote branches with explicit remote and consequence preview.
- [ ] **P1** Add recent branches, favorites, tags, and prefix grouping.
- [ ] **P1** Add compare with current and compare with working tree.
- [ ] **P1** Add merge into current and rebase current onto selected.
- [ ] **P1** Add Checkout and Update.
- [ ] **P1** Add Smart Checkout using stash or shelf, including recovery on conflict.
- [ ] **P1** Detect name collisions when creating a local branch from a remote branch.
- [ ] **P1** Handle detached HEAD and protected branches explicitly.
- [ ] **P2** Optionally restore open editors, selected files, and task context per branch.

### Remote synchronization

- [ ] **P1** Show clear incoming/outgoing commit counts and upstream state.
- [ ] **P1** Let the user choose pull strategy: fast-forward only, merge, or rebase.
- [ ] **P1** Add a push preview listing commits, files, remote, and target branch.
- [ ] **P1** Support setting upstream and selecting among multiple remotes.
- [ ] **P1** Support tags and guarded `--force-with-lease`.
- [ ] **P1** Add recovery choices when push is rejected.
- [ ] **P1** Explain authentication errors without storing passwords, tokens, or SSH keys.

## v0.4 — Git Studio

Goal: provide one coherent workspace for changes, history, review, and operations instead of forcing complex work into a narrow sidebar.

- [ ] **P1** Keep the sidebar as a compact daily overview and entry point.
- [ ] **P1** Add a full-width Git Studio editor tab for complex workflows.
- [ ] **P1** Create a resizable three-region layout: navigation, diff/content, and action/details.
- [ ] **P1** Keep selection synchronized between sidebar, Git Studio, native diff, and source editor.
- [ ] **P1** Add a universal Git command bar with fuzzy search and keyboard hints.
- [ ] **P1** Add contextual actions based on the selected file, hunk, commit, branch, tag, or operation.
- [ ] **P1** Add an undo/recovery shelf for reversible actions.
- [ ] **P2** Save named workspace layouts and focus modes.

### Real Git graph and history

- [ ] **P1** Parse and render a real multi-lane commit DAG.
- [ ] **P1** Render local branches, remote branches, tags, HEAD, and upstream labels.
- [ ] **P1** Add filters for branch, author, date, path, repository, and commit text.
- [ ] **P1** Add commit details, changed files, and immediate diff preview.
- [ ] **P1** Add jump to hash/branch/tag and parent/child navigation.
- [ ] **P1** Add context actions: checkout, new branch, tag, cherry-pick, revert, reset, and push up to commit.
- [ ] **P2** Add file history, selection history, and rename tracking.
- [ ] **P2** Add Git blame integrated with commit details and diff preview.
- [ ] **P2** Index large histories incrementally and virtualize long lists.

## v0.5 — Advanced Git and Recovery

Goal: make complex Git operations safe and understandable inside VS Code.

### Stash and shelf

- [ ] **P2** List, search, inspect, apply, pop, drop, and branch from Git stashes.
- [ ] **P2** Create stashes from selected files with untracked-file options.
- [ ] **P2** Implement repository-local shelves for selected files, hunks, and lines.
- [ ] **P2** Preview shelf and stash contents before applying them.
- [ ] **P2** Recover safely when apply or pop creates conflicts.

### Merge, rebase, and cherry-pick

- [ ] **P2** Detect in-progress merge, rebase, cherry-pick, and revert operations.
- [ ] **P2** Add Continue, Skip, Retry, and Abort controls with current-step context.
- [ ] **P2** Add interactive rebase planning: reorder, reword, edit, squash, fixup, and drop.
- [ ] **P2** Preview commits and conflicts before starting a merge, rebase, or cherry-pick.
- [ ] **P2** Protect uncommitted work automatically before risky history operations.

### Conflict center

- [ ] **P1** Add a dedicated Merge Conflicts node and conflict count.
- [ ] **P1** Open VS Code's native Merge Editor for manual resolution.
- [ ] **P1** Add Accept Yours, Accept Theirs, and Resolve Manually with accurate operation-specific wording.
- [ ] **P1** Apply all non-conflicting changes where supported.
- [ ] **P1** Track resolved and unresolved files and prevent premature continuation.
- [ ] **P2** Explain base, current, incoming, and result versions for merge, rebase, and cherry-pick contexts.
- [ ] **P2** Add a final review step before continuing the Git operation.

### Recovery tools

- [ ] **P2** Add reflog browsing and restore-from-reflog actions.
- [ ] **P2** Add safe reset modes with a precise preview of affected commits and files.
- [ ] **P2** Preserve recovery metadata for IdeaGit-initiated destructive operations.
- [ ] **P2** Add diagnostics that copy commands and non-sensitive logs for support.

## v0.6 — Intent-Aware Git

Goal: make IdeaGit meaningfully better than existing Git clients while keeping the user in control.

- [ ] **P3** Suggest changelist groups based on dependency, directory, issue, and edit context.
- [ ] **P3** Detect mixed-purpose files and recommend hunk-level separation.
- [ ] **P3** Suggest a commit series instead of one oversized commit.
- [ ] **P3** Generate editable commit messages from selected changes and repository conventions.
- [ ] **P3** Explain why each file or hunk was grouped together.
- [ ] **P3** Detect likely accidental changes, secrets, debug code, generated artifacts, and missing tests.
- [ ] **P3** Explain conflicts in terms of the intent of both sides and suggest a result without applying it automatically.
- [ ] **P3** Summarize outgoing commits and risk before push.
- [ ] **P3** Support local or user-selected model providers; never require repository upload for core Git features.
- [ ] **P3** Redact configured sensitive paths and show exactly what context would be sent before any remote AI request.

## v1.0 — Production Readiness

### Correctness and safety

- [ ] **P0** Test all write operations in disposable real Git repositories.
- [ ] **P0** Cover partially staged files, renames, deletions, conflicts, detached HEAD, unborn branches, and missing upstreams.
- [ ] **P0** Prevent argument injection and unsafe path handling.
- [ ] **P0** Never store credentials or private keys.
- [ ] **P0** Document every destructive operation and recovery path.
- [ ] **P1** Add property-based tests for status and log parsers.
- [ ] **P1** Add fault-injection tests for cancelled and interrupted Git processes.

### Compatibility and performance

- [ ] **P1** Test macOS, Windows, and Linux.
- [ ] **P1** Test supported VS Code and Git version ranges.
- [ ] **P1** Support multi-root workspaces, monorepositories, worktrees, submodules, and multiple remotes.
- [ ] **P1** Keep the UI responsive with 10,000 changed files and large histories through virtualization and incremental loading.
- [ ] **P1** Add performance budgets for first render, refresh, branch search, and graph scrolling.
- [ ] **P1** Avoid repository writes during read-only refreshes.

### Quality and release

- [ ] **P1** Add unit, integration, webview interaction, and Extension Development Host end-to-end tests.
- [ ] **P1** Add screenshot and reduced-motion regression coverage for core flows.
- [ ] **P1** Complete an accessibility review for keyboard, focus, labels, contrast, zoom, and screen readers.
- [ ] **P1** Verify built-in light, dark, and high-contrast themes.
- [ ] **P1** Add structured, privacy-safe diagnostics and a troubleshooting view.
- [ ] **P1** Add English and Chinese UI localization.
- [ ] **P1** Publish signed VSIX artifacts from CI with changelog and rollback instructions.
- [ ] **P1** Prepare Marketplace assets, usage documentation, migration notes, and a release checklist.
- [ ] **P1** Run a private alpha, public beta, and data-loss-focused release gate before 1.0.

## Definition of done for every workflow

A checkbox is complete only when all applicable items below are true:

- [ ] The happy path works against a real disposable Git repository.
- [ ] Dirty-worktree, detached-HEAD, missing-upstream, conflict, cancellation, and Git-error paths are handled.
- [ ] The operation has keyboard access, visible focus, and screen-reader labels.
- [ ] Loading, success, empty, error, and recovery states are designed.
- [ ] Motion explains the state change, does not replay on no-op refresh, and respects reduced motion.
- [ ] Risky changes have a preview and a documented recovery path.
- [ ] Unit or integration coverage prevents regression.
- [ ] The feature works in both the compact sidebar and Git Studio when applicable.
- [ ] The documentation describes behavior and known limitations.

## Explicit non-goals

- Pixel-copying IntelliJ IDEA instead of matching its workflow.
- Replacing VS Code's code editor, diff editor, or merge editor without a proven capability gap.
- Requiring a GitHub account or GitHub-specific API for local Git work.
- Storing user credentials, tokens, passwords, or SSH keys.
- Adding decorative motion that does not communicate a state change.
- Allowing AI to execute destructive Git operations without an explicit user review and confirmation.
