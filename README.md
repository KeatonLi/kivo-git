# Kivo Git

An IDE-inspired Git workflow with a better feel for VS Code.

Kivo Git is for developers who want a familiar IDE Git workflow in VS Code: a left-side Changes/Commit tool, persistent changelists, a useful branch popup, and a real branch-aware History Log in the bottom Panel.

## Current MVP

- Real repository status powered by the native Git CLI
- IDE-style named changelists with drag-and-drop assignment
- Selective commits without forcing a staged/unstaged workflow
- Local and remote branch popup with checkout
- Ahead/behind state plus fetch, pull, and push actions
- Quiet background auto-fetch with explicit incoming and outgoing commit counts
- Native VS Code diff preview on single-click and a pinned editor on double-click
- Arrow-key file navigation, Space toggle, and Shift range selection
- Left Activity Bar **Changes** tool for local files, changelists, diffs, and committing
- Bottom Panel **History** tool with the complete Log; Graph exists only as its first column
- Dense multi-lane Git Log with a branch navigator, graph lanes, commit/author/date columns, selected-commit details, and file-level history diffs
- Incremental Log history loading with branch, author, time-window, and text filters
- Explicit Pull strategies: fast-forward only, Rebase, and Merge
- Keyboard-first Log navigation with roving focus, instant selection, and lazy detail loading
- Clear loading, retry, disabled, and error feedback for remote sync and commit history
- Theme-aware motion and reduced-motion accessibility

## Run locally

```bash
npm install
npm run compile
```

Open this folder in VS Code and press `F5` to launch the Extension Development Host. Open a Git repository there, then select **Kivo Git** in the left Activity Bar for local changes and commit. Open VS Code's bottom Panel (`View → Appearance → Panel`, or `Ctrl/Cmd+J`) and select **Kivo Git History** to inspect the Log and Graph.

Use **Kivo Git: Show Changes** or **Kivo Git: Show Log** from the Command Palette to focus the respective surface. Graph is a column inside bottom History, never a sidebar or separate page.

Kivo Git checks remote refs in the background every five minutes while its view is visible. Configure `ideaGit.autoFetch` or `ideaGit.autoFetchInterval` when a repository needs a different network policy.

## Release a test build

From a clean `main` branch, run:

```bash
npm run release -- 0.3.0-beta.8
```

The release tool verifies the repository and version, promotes the Unreleased changelog, runs all checks and tests, packages the VSIX, and pushes a version commit. GitHub Actions then creates the matching tag and publishes the VSIX plus SHA-256 checksum to GitHub Releases. Pre-release semantic versions are published as GitHub pre-releases.

## Design principle

Kivo Git borrows the best IDE workflow ideas without copying another product’s pixels. Its K-topology mark combines the initial “K” with a commit graph: recognisable at small sizes, quiet in the Panel, and distinct in Marketplace listings. Git operations use the local `git` executable, so GitHub, GitLab, Gitee, Bitbucket, and internal remotes work without Kivo Git storing credentials.

Repository: [github.com/KeatonLi/kivo-git](https://github.com/KeatonLi/kivo-git)

See [docs/DESIGN.md](docs/DESIGN.md) for the product model and roadmap.

The executable system backlog, release phases, and definition of done are tracked in [docs/TODO.md](docs/TODO.md).

## Status

This is an early open-source MVP. Test on a disposable repository before relying on it for production work.

## License

MIT
