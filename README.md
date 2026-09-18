# IdeaGit

IntelliJ-like Git workflow for VS Code.

IdeaGit is for developers who like VS Code but miss the clarity of JetBrains Git tools: persistent changelists, a focused commit tool window, a useful branch popup, and a readable history.

## Current MVP

- Real repository status powered by the native Git CLI
- IDEA-style named changelists with drag-and-drop assignment
- Selective commits without forcing a staged/unstaged workflow
- Local and remote branch popup with checkout
- Ahead/behind state plus fetch, pull, and push actions
- Native VS Code diff editor on file double-click
- Recent commit log
- Theme-aware motion and reduced-motion accessibility

## Run locally

```bash
npm install
npm run compile
```

Open this folder in VS Code and press `F5` to launch the Extension Development Host. Open a Git repository there, then select the IdeaGit icon in the Activity Bar.

## Design principle

IdeaGit copies the IntelliJ workflow, not its pixels. Git operations use the local `git` executable, so GitHub, GitLab, Gitee, Bitbucket, and internal remotes work without IdeaGit storing credentials.

See [docs/DESIGN.md](docs/DESIGN.md) for the product model and roadmap.

## Status

This is an early open-source MVP. Test on a disposable repository before relying on it for production work.

## License

MIT
