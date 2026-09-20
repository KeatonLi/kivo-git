# Kivo Git parity design QA

source visual truth:

- User-provided dark IDEA **Commit** and **Log** screenshots in this conversation (the original attachment paths are unavailable in the workspace, so they cannot be reopened as local image files).
- Behavioral reference: [`docs/IDEA_PARITY.md`](docs/IDEA_PARITY.md), including the pinned Rebased commit `d5f15c9746e98e2f50d43196c9fbbd58b64edda4`.

implementation screenshot path:

- Cloud-browser render of [`test/visual-preview.html`](test/visual-preview.html) with `?surface=changes` and `?surface=history`. The fixture executes the production `media/main.js` and `media/main.css` against a realistic Git snapshot; it is not a substitute for a real VS Code Extension Host capture.

viewport:

- Browser fixture: 1363 × 936 CSS px, dark host-token fixture.
- Intended product targets: a narrow VS Code Activity Bar view for Commit and a wide bottom Panel for Log.

source and implementation pixel dimensions:

- Source attachment dimensions: unavailable because the supplied attachment files could not be opened from the workspace.
- Implementation fixture: 1363 × 936 CSS px at device scale factor supplied by the cloud browser.

density normalization: not applicable. The target images cannot be reopened into the same comparison input, so a pixel-normalized pass is blocked.

state:

- Commit: local changes present, no selected file, anchored Amend/message/actions base.
- Log: current branch selected, local/remote/tag tree populated, first commit selected, nested Changed Files tree and commit body loaded.

## Evidence and fixed findings

- [P1, fixed] The incremental renderer patched `#app` against a generic `div`, which stripped the root ID after the first snapshot. The bottom Log then collapsed to content height and left a large empty area below it.
  - Evidence: the first browser render measured `.log-workspace` at 576.5 px inside a 936 px viewport, and `#app` was absent after the snapshot.
  - Fix: patch the root against a `<main id="app">` target. The second browser render measured `#app` present and both `.content` and `.log-workspace` at 936 px.
- [P1, fixed] Commit controls were disabled until a repository refresh after typing because the new visual state depended on the message textarea without a rerender.
  - Fix: align with IDEA's actionable Commit control: it enables after files are selected and validates a missing message on activation. Browser interaction confirmed both **Commit** and **Commit and Push…** enable after selecting a file and remain enabled while typing.
- [P2, fixed] Checkbox automation and keyboard-equivalent state changes could bypass the click-only file-selection listener.
  - Fix: retain Shift-click behavior while also accepting the checkbox `change` event.
- [P1, fixed] The branch tree and Graph had a fixed boundary, even though the reference Log gives the user control over the tree width.
  - Fix: inserted a real vertical separator between the branch tree and the history table. Browser-fixture interaction verified mouse drag from 240 px to 335 px, `ArrowLeft` keyboard resizing, double-click reset to 240 px, and cleanup of the drag state after release. The separator hides with the branch tree in narrow panels.
- [P1, fixed] Right-clicking a History branch opened the browser's Cut/Copy/Paste menu, so a branch could not be used as the start point for a new branch.
  - Fix: the webview now owns the branch context menu and sends a validated `createBranch` operation to Git. The new branch is created from the selected local/remote ref and checked out immediately.
- [P1, fixed] Changed-file rows used one generic code icon, obscuring file type in the Commit surface.
  - Fix: resolve the active VS Code file-icon theme on the extension-host side and send only CSP-safe image/font resources to the Commit webview. The matcher covers VS Code filename, parent-path, compound-extension, language, light, and high-contrast precedence, with a generic native fallback when a theme cannot supply an icon.

## Current visual review

- Commit composition now follows the reference hierarchy: compact icon strip, a single blue **Changes** row, flat dense file rows, then a bottom-anchored Amend/message/Commit/Commit-and-Push base. The native View title is `Commit`.
- The bottom container is now named **Kivo Git History**. Its content follows the reference hierarchy: action rail, searchable branch/tag tree, a draggable tree/history divider, compact filters, **Author → Graph → Commit → Date** rows, and a right-hand Changed Files tree above commit text. The branch is retained as native View context.
- The browser fixture exercised selection, text/hash filtering, Commit enablement, Commit-and-Push enablement, initial details loading, and nested file-tree rendering. The only browser-console errors belonged to the cloud browser's own extension metadata bridge; none referenced Kivo Git media code.

## Findings

- [P1] Final 1:1 visual comparison remains blocked.
  - Location: real VS Code Extension Host vs. the two user screenshots.
  - Evidence: the source screenshots' file paths are unavailable locally, and the available browser render is a Webview fixture rather than VS Code's actual native chrome and sidebar width.
  - Impact: native title spacing, narrow-sidebar wrapping, theme variation, and host border placement are not yet proven pixel-for-pixel.
  - Fix: install the release VSIX in VS Code, capture the real **Commit** and bottom **Log** views at the same state, then compare those images against reattached source screenshots.
- [P1] Local Extension Host capture is blocked by the workspace filesystem.
  - Evidence: `npm run test:extension` reached the official VS Code 1.95 download, but its archive extraction failed on ownership restoration (`tar: Cannot change ownership ... Invalid argument`) before the Extension Host launched.
  - Impact: this workspace cannot capture native VS Code chrome or execute the Extension Host smoke test locally.
  - Fix: the GitHub Release workflow runs the identical command under Ubuntu/Xvfb before it is allowed to publish the VSIX.

## Implementation checklist

- [x] Establish independent Activity Bar Commit and bottom Panel Log contributions.
- [x] Apply screenshot-aligned Commit and Log hierarchy in production media.
- [x] Add real Commit-and-Push sequencing and preserve committed state if the later push fails.
- [x] Add routing, manifest, media-layout, Git integration, and browser-fixture interaction coverage.
- [x] Capture browser-rendered Commit and Log fixtures and correct the full-height layout defect they exposed.
- [ ] Capture real VS Code Extension Host screens at both target dimensions.
- [ ] Compare against reattached source screenshots and obtain user A/B approval before Marketplace publication.

## Comparison history

1. Browser fixture pass found a P1 root-layout collapse and two interaction-state defects; all three were fixed.
2. Browser fixture recheck confirmed full-height Log, anchored Commit base, Commit/Commit-and-Push enablement, commit selection, Log text filtering, and no Kivo media console errors.
3. Browser-fixture recheck confirmed the History divider drag, keyboard resize, reset behavior, and release cleanup alongside the existing selection/filter/detail interactions.
4. Real Extension Host and source-image comparison remain unavailable in this workspace; the local Extension Host download fails before launch because this filesystem rejects archive ownership restoration.

final result: blocked
