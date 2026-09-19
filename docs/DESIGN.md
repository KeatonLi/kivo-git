# IdeaGit product design

## Product promise

IdeaGit brings the IntelliJ IDEA Git workflow to VS Code. It copies the mental model—not every pixel—and keeps native VS Code editors for code, diff, and merge work.

## Interaction model

| IDEA concept | IdeaGit behavior |
| --- | --- |
| Commit tool window | Persistent sidebar with changelists, selection, message, and commit action |
| Local changelists | Named groups stored per repository under `.git/ideagit/` |
| Branch widget | One-click branch popup with local and remote branches plus ahead/behind state |
| Changes diff | Single-click for a focused preview; double-click or Enter pins VS Code's native diff editor |
| Git log | Compact animated commit list; graph lanes and filters follow in milestone 2 |
| Update/push | Direct actions in the repository header with progress and result feedback |

## Visual language

IdeaGit uses VS Code Codicons, host theme tokens, compact spacing, quiet surfaces, and a single accent color for focus and active intent. Incoming, outgoing, active, warning, and destructive states remain visually distinct without turning the sidebar into a dense toolbar.

The repository header exposes upstream freshness and separate Pull/Push commit counts. A non-interactive background fetch refreshes remote refs while the view is visible; failures stay local to the sync status instead of interrupting editing with notifications.

## Motion language

Motion communicates state. The default timings are 80 ms for press feedback, 120 ms for hover, 160–190 ms for structural changes, and 230–260 ms for operation results. Every animation respects `prefers-reduced-motion`.

## Architecture

```mermaid
flowchart TD
  UI[Webview UI] --> Bridge[Typed message bridge]
  Bridge --> Services[Extension services]
  Services --> Git[Native Git CLI]
  Services --> Editors[VS Code diff and merge editors]
  Services --> Store[Repository-local changelists]
```

The extension never stores credentials or tokens. Fetch, pull, and push are delegated to the user's existing Git installation and credential helper.

## Milestones

1. **Foundation:** real status, changelists, selective commit, branch popup, native diff, fetch/pull/push.
2. **Daily workflow:** graph log, branch operations, partial-hunk assignment, stash and shelf.
3. **Conflict workflow:** merge editor integration, rebase status, abort/continue actions.
4. **Polish:** multi-root repositories, performance work, keyboard map, accessibility audit, marketplace release.
