# Kivo Git product design

## Product promise

Kivo Git brings an IDE-style Git workflow to VS Code. It keeps the useful mental model—without copying another product's pixels—and keeps native VS Code editors for code, diff, and merge work.

## Interaction model

| IDE workflow concept | Kivo Git behavior |
| --- | --- |
| Commit tool window | Persistent bottom Panel with changelists, selection, message, and commit action |
| Local changelists | Named groups stored per repository under `.git/ideagit/` |
| Branch widget | One-click branch popup with local and remote branches plus ahead/behind state |
| Changes diff | Single-click for a focused preview; double-click or Enter pins VS Code's native diff editor |
| Git Log | Dense, table-oriented multi-lane commit DAG with branch refs, merge points, searchable commit details, and file diffs |
| Update/push | Direct actions in the repository header with progress and result feedback |

## Visual language

Kivo Git uses VS Code Codicons, host theme tokens, compact spacing, quiet surfaces, and a restrained lane palette for focus and active intent. The bottom Panel is the primary workspace: it gives Changes and Log enough horizontal room for a genuine Git tool window while leaving the editor and Source Control sidebar unobstructed. Incoming, outgoing, active, warning, and destructive states remain visually distinct without turning the tool window into a dense toolbar.

### Brand mark

The Kivo mark is a K drawn as a small commit topology: a stable vertical stem, two branching paths, and two terminal nodes. In the Panel it is monochrome and inherits the host theme; in Marketplace it sits in a blue-violet rounded square. The mark must remain legible at 16 px, avoid literal Git or JetBrains logos, and never rely on decorative detail to identify the product.

The repository header exposes upstream freshness and separate Pull/Push commit counts. A non-interactive background fetch refreshes remote refs while the view is visible; failures stay local to the sync status instead of interrupting editing with notifications.

## Motion language

Motion communicates state. The default timings are 80 ms for press feedback, 120 ms for hover, 160–190 ms for structural changes, and 230–260 ms for operation results. Every animation respects `prefers-reduced-motion`; keyboard focus and loading states remain clear when motion is disabled.

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
2. **Daily workflow:** graph history, branch operations, partial-hunk assignment, stash and shelf.
3. **Conflict workflow:** merge editor integration, rebase status, abort/continue actions.
4. **Polish:** multi-root repositories, performance work, keyboard map, accessibility audit, marketplace release.
