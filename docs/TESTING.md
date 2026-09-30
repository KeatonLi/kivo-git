# Testing Kivo Git

Kivo Git has two runtime boundaries, so its tests use two different hosts.

## Webview browser tests

The browser suite runs the production `media/main.js` and `media/main.css` in a small VS Code message-bridge fixture. It does not require VS Code and never runs Git commands. It covers empty changelist drop affordance, incoming/outgoing counts, Fetch message delivery, selected-file commit payloads, recent-commit previews, and Unpushed markers.

Push review checks cover destination and commit summaries, cancel/confirm/fetch replies, preserved drafts, focus containment, stale branch tips, and long destinations in narrow and short views. Host-side tests check one-use review IDs and isolation between repositories and surfaces. Git integration tests verify exact outgoing membership for diverged and selected branches, partial pushes, cleared marks after publishing, and revalidation of reviewed refs before a real push.

```sh
npm ci
npm install --no-save --package-lock=false playwright@1.62.1
npx playwright install chromium
npm run test:webview
```

## Extension Host tests

`npm run test:extension` launches VS Code 1.95.0 and checks extension activation, registered commands, and the Commit/History entry points. CI runs this under Xvfb. Git command behavior is exercised separately in disposable repositories by `test/gitClient.integration.test.ts`.

Inline blame additionally has focused controller and cache tests for cursor debounce, cancellation, stale results, unsaved edits, non-repository workspaces, and the settings toggle. The Extension Host test verifies the toggle command against VS Code's real configuration API.

The VS Code Web extension host cannot run this extension as-is: Kivo Git uses Node APIs and starts local Git processes. The browser suite therefore tests the real webview front end, while the Extension Development Host suite tests VS Code integration.
