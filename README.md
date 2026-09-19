# Kivo Git

An IntelliJ-inspired Git workflow with a better feel for VS Code.

Kivo Git is for developers who like VS Code but miss the clarity of JetBrains Git tools: persistent changelists, a focused commit tool window, a useful branch popup, and a real branch-aware history graph.

## Current MVP

- Real repository status powered by the native Git CLI
- IDEA-style named changelists with drag-and-drop assignment
- Selective commits without forcing a staged/unstaged workflow
- Local and remote branch popup with checkout
- Ahead/behind state plus fetch, pull, and push actions
- Quiet background auto-fetch with explicit incoming and outgoing commit counts
- Native VS Code diff preview on single-click and a pinned editor on double-click
- Arrow-key file navigation, Space toggle, and Shift range selection
- Real multi-lane Git Graph with branch refs, merge lines, search, commit details, and file-level history diffs
- Theme-aware motion and reduced-motion accessibility

## Run locally

```bash
npm install
npm run compile
```

Open this folder in VS Code and press `F5` to launch the Extension Development Host. Open a Git repository there, then select the Kivo Git icon in the Activity Bar.

Kivo Git checks remote refs in the background every five minutes while its view is visible. Configure `ideaGit.autoFetch` or `ideaGit.autoFetchInterval` when a repository needs a different network policy.

## Release a test build

From a clean `main` branch, run:

```bash
npm run release -- 0.2.0-beta.1
```

The release tool verifies the repository and version, promotes the Unreleased changelog, runs all checks and tests, packages the VSIX, and pushes a version commit. GitHub Actions then creates the matching tag and publishes the VSIX plus SHA-256 checksum to GitHub Releases. Pre-release semantic versions are published as GitHub pre-releases.

## Design principle

Kivo Git copies the IntelliJ workflow, not its pixels. Git operations use the local `git` executable, so GitHub, GitLab, Gitee, Bitbucket, and internal remotes work without Kivo Git storing credentials.

See [docs/DESIGN.md](docs/DESIGN.md) for the product model and roadmap.

The executable system backlog, release phases, and definition of done are tracked in [docs/TODO.md](docs/TODO.md).

## Status

This is an early open-source MVP. Test on a disposable repository before relying on it for production work.

## License

MIT
