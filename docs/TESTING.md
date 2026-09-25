# Testing Kivo Git

Kivo Git has two runtime boundaries, so its tests use two different hosts.

## Webview browser tests

The browser suite runs the production `media/main.js` and `media/main.css` in a small VS Code message-bridge fixture. It does not require VS Code and never runs Git commands. It covers empty changelist drop affordance, incoming/outgoing counts, Fetch message delivery, and selected-file commit payloads.

```sh
npm ci
npm install --no-save --package-lock=false playwright@1.62.1
npx playwright install chromium
npm run test:webview
```

## Extension Host tests

`npm run test:extension` launches VS Code 1.95.0 and checks extension activation, registered commands, and the Commit/History entry points. CI runs this under Xvfb. Git command behavior is exercised separately in disposable repositories by `test/gitClient.integration.test.ts`.

The VS Code Web extension host cannot run this extension as-is: Kivo Git uses Node APIs and starts local Git processes. The browser suite therefore tests the real webview front end, while the Extension Development Host suite tests VS Code integration.
