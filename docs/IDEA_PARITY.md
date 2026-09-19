# Kivo Git — Rebased / IntelliJ IDEA parity contract

> Status: **active release gate**
>
> Until this contract passes user A/B testing, Kivo Git must not introduce a new visual language, custom motion, sync dashboard, or other differentiating UI. The only product-owned identity allowed in this phase is the Kivo Git name and mark.

## Reference lock

The reference is pinned so that “一致” has a stable meaning instead of changing with upstream screenshots:

- Git behavior, Log semantics, Graph interaction, branch/ref presentation, and commit details: [DetachHead/rebased](https://github.com/DetachHead/rebased) at `master` commit `d5f15c9746e98e2f50d43196c9fbbd58b64edda4` (resolved 2026-09-19).
- Tool-window placement and the `Local Changes | Log` mental model: [IntelliJ IDEA Git Log](https://www.jetbrains.com/help/idea/investigate-changes.html).
- The Rebased reference is an interaction and behavior reference. Kivo does not copy JetBrains/Rebased trademarks, logos, product names, or source code without a separate license/NOTICE review.

## Target mode

Kivo Git is considered in **parity mode** when the following is true:

1. The Git view is opened in the VS Code **bottom Panel**. It is not a left activity-bar view, a separate editor page, or a custom full-screen dashboard.
2. The bottom tool window exposes `Local Changes` and `Log` as peer tabs. The Graph is the first column of `Log`; it is not a third peer tab and not a standalone page.
3. The Log has the same hierarchy and density as IDEA: branch/ref navigator on the left, compact filter/action strip above the history, dense commit rows in the center, and changed-files/commit details on the right.
4. Graph rows are deterministic and branch-aware: commit order, lane reuse, merge joins, branch/tag/HEAD refs, selection, scrolling, and details must remain stable for the same Git repository state.
5. User actions follow the reference mental model: selecting a commit updates details; double-click/Enter opens the native diff; keyboard arrows move through rows; filters affect the Log rather than creating a second custom view; branch/ref actions are available from the selected item.
6. Loading, empty, disabled, error, and reduced-motion states use host/IDE conventions. No decorative animation or count-morphing is part of the parity gate.

## Acceptance matrix

| Area | Reference behavior | Kivo parity check | Gate |
| --- | --- | --- | --- |
| Placement | Bottom Git Tool Window | Panel only; no Graph sidebar | P0 |
| Tabs | `Local Changes` and `Log` are peers | Same order, labels, active-state behavior | P0 |
| Log structure | Branch navigator → history → details | Same regions and resize behavior | P0 |
| Filters | Text/hash, branch, user, date, paths | Same order, scope, clear/apply behavior | P0 |
| Graph | Multi-lane DAG with merge continuity | Fixture screenshots and row-by-row topology match | P0 |
| Refs | Local/remote branches, tags, HEAD | Labels and placement remain attached to the right commit | P0 |
| Selection | One selected commit drives details/files | Click, arrows, Enter, double-click are consistent | P0 |
| Details | Changed files plus commit metadata/diff | Same selected-commit relationship and actions | P0 |
| Refresh | Git state refresh preserves context | No focus/scroll/selection jump on no-op refresh | P1 |
| Error states | Actionable operation feedback | Retry/recovery without custom interruptions | P1 |

## Explicitly deferred until the gate passes

- Kivo-specific toolbar cards, sync dashboard, animated counters, shared-element transitions, and expressive motion.
- New graph gestures or visual decorations that are not present in the reference.
- Marketplace publication. The user must install the parity VSIX and approve the A/B result first.

## Evidence required before claiming “done”

- `npm run check`, `npm test`, `npm run compile`, and VSIX packaging pass.
- A fixture repository covers linear history, a merge, a branch fork, remote refs, tags, and a detached/empty state.
- A screenshot or screen recording for each P0 row is compared against the locked reference at the same viewport and state.
- The user confirms the bottom-panel placement, Log density, Graph topology, selection, filters, and details feel consistent with IDEA/Rebased.
