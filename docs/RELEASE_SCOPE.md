# Kivo Git release scope

## 0.4: complete the everyday Git workflow

Commit owns local files, changelists, rollback, commit and push review. History owns branches, commit history, search, filters and committed-file review. Native VS Code editors own diff and merge editing.

Branch comparison, Stashes and unfinished Git operations open only when needed. This release includes comparison of local/remote branch tips, each side's unique commits, stash preview/restore, stash-and-switch, and native conflict resolution with continue/abort controls.

Polish priorities are readable commit titles, predictable layout at narrow/short sizes, stable selection/drafts during refresh, exact repository/branch context, and local/remote status freshness. Keep the five recent commits as a compact, collapsible review area.

Before release, verify the real Git tests, Webview interaction suite, native extension-host entry points, package contents and current screenshots. Screenshots are fixtures, and do not prove operating-system-specific credential or Trash behavior.

## Proposed 0.5: Repository Insights

Open a separate editor tab. Default to the current branch and the last 30 days, with explicit repository-wide scope and author/date filters.

| Information | Presentation | Drill-down |
| --- | --- | --- |
| Commits, active contributors, distinct changed files, accumulated additions/deletions | One compact overview row | Apply the same scope to the report |
| Daily commits | Vertical bars, including days with zero commits | Commits on that day |
| Daily additions/deletions | Switch the trend chart to grouped bars with separate labels and units | Commits behind the changes |
| Contributor activity | Sorted horizontal bars with values | Author-filtered History |
| Frequently changed files | Sortable table with modification count, short directory and small bars | File History and Diff |

Use a large trend area and a two-column contributor/hotspot section. Keep host-theme surfaces, restrained blue accents and state colors. Additions and deletions carry both labels and colors.

Aggregate by author identity with mailmap and user-controlled aliases. Deduplicate commits across selected branch refs; exclude stash internals. Separate merge counts from line-change totals. Make generated/lockfile exclusions explicit. Mark shallow or incomplete history. Line-change totals measure churn, not repository line count or individual productivity.

Compute lazily with cancellable, cached reads so reporting does not slow Commit or History. Require History/File History links before calling the first report complete.

## Deferred from this scope

Annual heatmaps, weekly-summary export, AI-generated reports, PR management, worktrees, interactive rebase, a separate Git Studio, custom animation and extra dashboards need a separate decision. Existing advanced actions stay in context menus rather than adding persistent toolbar buttons.
