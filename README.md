# Kivo Git

> A tactile, graph-first Git workbench for Visual Studio Code.

[![CI](https://github.com/KeatonLi/kivo-git/actions/workflows/ci.yml/badge.svg)](https://github.com/KeatonLi/kivo-git/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/KeatonLi/kivo-git?include_prereleases&label=latest%20release)](https://github.com/KeatonLi/kivo-git/releases)
[![License: MIT](https://img.shields.io/github/license/KeatonLi/kivo-git)](LICENSE)

Kivo Git keeps a familiar two-surface workflow in VS Code: **Commit** stays in the Activity Bar for changes, while **Kivo Git History** stays in the bottom Panel for branches, Graph, commits, and file history. The goal is simple: make everyday Git work easier to scan, easier to operate, and more satisfying to use.

## Why Kivo Git

- **A stable mental model** — changes and changelists on the left; branch-aware history in the bottom Panel.
- **Clear sync state** — fetch, pull, and push feedback includes explicit incoming and outgoing commit counts.
- **Native VS Code integration** — diffs, file icons, themes, keyboard navigation, and the local `git` executable stay part of the workflow.
- **A focused visual language** — Kivo’s restrained cyan–violet accent system adds hierarchy and feedback without moving familiar Git controls.

## Features

### Commit workspace

- Real repository status powered by the native Git CLI
- IDE-style named changelists with drag-and-drop assignment
- Selective commits without forcing a staged/unstaged workflow
- Local and remote branch popup with checkout
- Branch context actions to create and checkout a new branch from any local branch, remote ref, or tag
- Native VS Code diff preview on single-click and a pinned editor on double-click
- Arrow-key file navigation, Space toggle, and Shift range selection
- Changed-file icons resolved from the active VS Code file icon theme, including compound extensions
- Readable Staged, Working, Untracked, and Conflict labels, with less-used toolbar actions in a named menu
- A commit review step that lists the selected files and offers a diff shortcut for each before confirmation

Commit operates on whole selected files, including their working-tree edits; the Staged filter does not turn it into an index-only commit. Unrelated staged files are preserved. Selection counts appear beside the commit form. Filtering never silently drops an existing selection: hidden selections must be reviewed by clearing the filter, or removed with **Remove hidden**, before committing. List checkboxes select matching files, while keyboard select-all and range selection use the expanded, visible rows.

Changelist data is stored in the worktree's Git directory under `ideagit/changelists.json`. Writes are atomic and serialized across windows, and tracked renames retain their list assignment. Invalid data is reported without overwriting it. Locks left by a terminated local Kivo Git process are recovered automatically. If an older or unreadable `changelists.json.lock` persists, close all Kivo Git windows and verify no operation is still running before removing that lock file; keep the JSON file.

### History workspace

- A dense, multi-lane Git Log with a branch/tag tree, author, Graph, commit, and date columns
- Kivo Git History lives in the bottom Panel; Graph is its first column, not a separate sidebar
- Selected-commit details with file-level history diffs
- Incremental history loading with branch, author, time-window, and text filters
- A draggable branch-tree / history divider with keyboard resizing and saved per-view width
- Keyboard-first navigation with roving focus, instant selection, and lazy detail loading
- A remembered focus mode that expands the commit graph; Blame navigation restores the detail pane automatically

### Inline blame

Kivo Git shows a quiet author, relative time, and commit summary after the current line in saved files. It waits until the cursor settles before asking Git, reuses recent results, and hides the annotation while the file has unsaved edits. Hover for the full commit details and a direct **Open commit in History** link, or use **Kivo Git: Show Line Blame** from the editor context menu for its actions.

Inline blame is on by default. Run **Kivo Git: Toggle Inline Blame** from the Command Palette, or change `ideaGit.inlineBlame.enabled` in Settings, to turn it off or back on.

### Sync and safety

- Ahead/behind state with fetch, pull, and push actions
- Quiet background auto-fetch with explicit incoming and outgoing commit counts
- Explicit pull strategies: fast-forward only, Rebase, and Merge
- A push review showing destination, outgoing commits, and changed-file count; rejection offers Fetch and Review without force-pushing
- Clear loading, retry, disabled, and error feedback for remote sync and history
- Theme-aware motion with reduced-motion accessibility

## Install

Install **Kivo Git** from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=KeatonLi.idea-git), or run:

```bash
code --install-extension KeatonLi.idea-git
```

Alternatively, download the `.vsix` asset from the [latest GitHub Release](https://github.com/KeatonLi/kivo-git/releases), then install it from VS Code’s Extensions view (`⋯` → **Install from VSIX…**) or with:

```bash
code --install-extension kivo-git-<version>.vsix
```

Kivo Git is an early release. Report problems through [GitHub Issues](https://github.com/KeatonLi/kivo-git/issues).

## Run locally

```bash
npm install
npm run compile
```

Open this folder in VS Code and press `F5` to launch the Extension Development Host. Open a Git repository there, then select **Kivo Git** in the left Activity Bar to open **Commit**. Open VS Code’s bottom Panel (`View → Appearance → Panel`, or `Ctrl/Cmd+J`) and select **Kivo Git History** to inspect history and Graph.

Use **Kivo Git: Show Changes** or **Kivo Git: Show History** from the Command Palette to focus the respective surface. Graph is a column inside bottom History, never a sidebar or separate page.

Kivo Git checks remote refs in the background every five minutes while its view is visible. Configure `ideaGit.autoFetch` or `ideaGit.autoFetchInterval` when a repository needs a different network policy.

Run the complete local verification suite with:

```bash
npm run check
npm test
npm run package
```

## Release a test build

From a clean `main` branch, run:

```bash
npm run release -- <version>
```

The release tool verifies the repository and version, promotes the Unreleased changelog, runs all checks and tests, packages the VSIX, and pushes a version commit. GitHub Actions then creates the matching tag and publishes the VSIX plus SHA-256 checksum to GitHub Releases. Pre-release semantic versions are published as GitHub pre-releases.

## Design principles

Kivo Git borrows the best IDE workflow ideas without copying another product’s pixels. Its K-topology mark combines the initial “K” with a commit graph: recognisable at small sizes, quiet in the Panel, and distinct in extension listings. Git operations use the local `git` executable, so GitHub, GitLab, Gitee, Bitbucket, and internal remotes work without Kivo Git storing credentials.

See [docs/DESIGN.md](docs/DESIGN.md) for the product model and roadmap. The executable system backlog, release phases, and definition of done are tracked in [docs/TODO.md](docs/TODO.md).

## Project status

Kivo Git is an early open-source MVP. The layout and core workflow are stable enough for hands-on testing, while interaction polish and broader Git parity are still evolving.

## License

MIT
