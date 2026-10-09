# Testing Kivo Git

Kivo Git has two runtime boundaries, so its tests use two different hosts.

## Webview browser tests

The browser suite runs the production `media/main.js` and `media/main.css` in a small VS Code message-bridge fixture. It does not require VS Code and never runs Git commands. It covers empty changelist drop affordance, incoming/outgoing counts, Fetch message delivery, selected-file commit payloads, recent-commit previews, and Unpushed markers.

`scripts/webview-experience-regressions.mjs` always runs five task regressions, including when screenshot capture is disabled: middle-of-text edits and preserved selections in six search fields; clearing live filter controls without losing a draft or selected files; details and exact diff messages for the 221st commit outside an initial 80-commit snapshot; keyboard access to the body end, parents and last file in short History panes; and focus return after nested Stash views and branch comparisons. Screenshots are optional; these assertions are not.

Push review checks cover destination and commit summaries, cancel/confirm/fetch replies, preserved drafts, focus containment, stale branch tips, and long destinations in narrow and short views. File previews cover lazy loading, cached reopening, retry, stale responses from other commits/reviews/repositories, filename priority, duplicate filenames in different directories, root files, renames, and diff messages. Host-side tests check one-use review IDs, exact commit membership, and isolation between repositories and surfaces. Git integration tests verify exact outgoing membership for diverged and selected branches, partial pushes, cleared marks after publishing, full hashes in previews, and revalidation of reviewed refs before a real push.

First-publication tests additionally cover local branches without upstreams, zero new commits, Commit and Push to an empty remote, publication without checkout, explicit remote selection, distinct fetch/push URLs, existing server branches without fetched objects, and deleted upstreams after Fetch. Real Git rejects changed publication destinations and a same-name branch created immediately before send. Browser checks cover Publish entries, connecting to an existing branch, cancellation, destination-loading replies and visible confirmation at 240px × 420px.

`scripts/history-selection-regressions.mjs` checks the pinned checkout during branch search and history navigation; Ctrl/Cmd-click, Shift ranges, keyboard selection across 220 virtual rows and right-button dragging; context-menu selection retention; exact preview membership/order, cancellation focus and one-use confirmation messages; stale checkout/repository replies; filter resets; and empty-commit Skip controls. These assertions run with or without screenshot capture.

`test/cherryPick.integration.test.ts` executes real Git in disposable repositories. It checks selected-only application across gaps, ancestry order, dirty and detached checkouts, invalid/overlarge/already-applied selections, changed reviewed heads, merge prevalidation, continuing after a conflict, aborting every commit in a batch and skipping an empty commit without dropping staged edits.

```sh
npm ci
npm install --no-save --package-lock=false playwright@1.62.1
npx playwright install chromium
npm run test:webview
```

## Extension Host tests

`npm run test:extension` launches VS Code 1.95.0 and checks extension activation, registered commands, and the Commit/History entry points. CI runs this under Xvfb. Git command behavior is exercised separately in disposable repositories by `test/gitClient.integration.test.ts`.

To test against an installed VS Code instead of downloading the pinned version, set `KIVO_VSCODE_EXECUTABLE_PATH` to its executable before running the command. All Extension Host tests use a temporary, isolated profile.

Git fixtures disable automatic line-ending conversion locally. Filenames with brackets and spaces run on Windows too; literal asterisks and trailing spaces are tested only on POSIX, where those filenames are supported. Repository identity tests cover Windows path spelling and separate linked worktrees; message tests also verify stale responses and repository switches.

`npm run package` produces `kivo-git-<version>.vsix` and verifies its runtime assets and manifest directly as a ZIP file. No external unzip command is needed. `npm run test:vsix -- <path>` can verify a specific package.

Inline blame additionally has focused controller and cache tests for cursor debounce, cancellation, stale results, unsaved edits, non-repository workspaces, and the settings toggle. The Extension Host test verifies the toggle command against VS Code's real configuration API.

The VS Code Web extension host cannot run this extension as-is: Kivo Git uses Node APIs and starts local Git processes. The browser suite therefore tests the real webview front end, while the Extension Development Host suite tests VS Code integration.

## 0.4 workflows

`test/gitWorkflows.integration.test.ts` uses disposable real repositories for branch-tip comparisons, unique commits, remote refs, renames, stash previews (including untracked files), restored index state, checkout prevalidation and failure recovery, stash identity after reflog reordering, merge continuation/abort, linked-worktree rebase, and conflicts from externally started cherry-pick/revert.

Webview E2E covers primary-ref summaries and title space, branch comparison tabs and diff messages, stash save/preview/restore, stale responses, retry, repository changes, conflict controls in both surfaces, and bounded workflow dialogs with keyboard focus containment. The Extension Host suite creates a real Git conflict and verifies that the built-in Merge Editor opens.
