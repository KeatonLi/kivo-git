import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

describe('webview surface composition', () => {
  it('renders one purpose-built surface instead of the retired Local Changes/Log tabs', async () => {
    const main = await readFile(path.join(root, 'media', 'main.js'), 'utf8');
    expect(main).toContain("const surface = document.body.dataset.surface === 'history' ? 'history' : 'changes';");
    expect(main).toContain("${surface === 'changes' ? renderChanges(s) : renderGraph(s)}");
    expect(main).not.toContain('tool-tabs');
    expect(main).not.toContain('data-tab');
    expect(main).not.toContain("message.type === 'showTab'");
  });

  it('locks the screenshot hierarchy: Commit has a bottom commit base and History has four working regions', async () => {
    const main = await readFile(path.join(root, 'media', 'main.js'), 'utf8');
    const css = await readFile(path.join(root, 'media', 'main.css'), 'utf8');
    expect(main).toContain('function renderCommitToolbar(s)');
    expect(main).toContain('class="commit-changes-heading"');
    expect(main).toContain('Commit and Push…');
    expect(main).toContain('function renderLogActionRail()');
    expect(main).toContain('class="log-branch-pane"');
    expect(main).toContain('class="branch-pane-footer"');
    expect(main).toContain('data-log-splitter');
    expect(main).toContain('Resize History branch tree');
    expect(main).toContain('data-log-detail-splitter');
    expect(main).toContain('Resize commit history and details');
    expect(main).toContain('data-commit-detail-splitter');
    expect(main).toContain('Resize changed files and commit information');
    expect(main).toContain('data-commit-panel-splitter');
    expect(main).toContain('Resize changes and commit message');
    expect(main).toContain('data-branch-context-action="new"');
    expect(main).toContain('data-branch-context-action="merge"');
    expect(main).toContain('data-branch-context-action="rename"');
    expect(main).toContain('data-branch-context-action="delete"');
    expect(main).toContain('data-branch-context-action="copy"');
    expect(main).toContain('function bindContextMenuDelegation()');
    expect(main).toContain("document.addEventListener('contextmenu'");
    expect(main).toContain('event.composedPath?.()');
    expect(main).toContain("element?.closest('[data-log-branch], [data-checkout]')");
    expect(main).toContain("element?.closest('[data-file-row]')");
    expect(main).toContain('data-file-context-action="open-diff"');
    expect(main).toContain('data-file-context-action="move"');
    expect(main).toContain('data-file-context-action="copy-path"');
    expect(main).toContain('data-file-context-action="history"');
    expect(main).toContain('data-file-context-action="reveal"');
    expect(main).toContain('data-file-menu');
    expect(main).toContain("once('[data-file-menu]', 'click'");
    expect(main).not.toContain('data-file-context-action="cut"');
    expect(main).toContain("post('createBranch', { startPoint: menu.ref })");
    expect(main).toContain("post('mergeBranch', { branch: menu.ref })");
    expect(main).toContain("post('renameBranch', { branch: menu.ref })");
    expect(main).toContain("post('deleteBranch', { branch: menu.ref, remote: menu.remote })");
    expect(main).toContain('function renderCommitContextMenu()');
    expect(main).toContain("element?.closest('[data-commit]')");
    expect(main).toContain('data-commit-context-action="copy"');
    expect(main).toContain('data-commit-context-action="copy-subject"');
    expect(main).toContain('data-commit-context-action="details"');
    expect(main).toContain('data-commit-context-action="branch"');
    expect(main).toContain('data-commit-context-action="tag"');
    expect(main).toContain('data-commit-context-action="checkout"');
    expect(main).toContain("post('copyCommitHash', { hash: menu.hash })");
    expect(main).toContain("post('createBranch', { startPoint: menu.hash })");
    expect(main).toContain("post('createTag', { hash: menu.hash })");
    expect(main).toContain("post('checkoutRevision', { hash: menu.hash })");
    expect(main).not.toContain('class="amend-row"');
    expect(main).toContain('<span>AUTHOR</span><span>GRAPH</span><span>COMMIT</span><span>DATE</span>');
    expect(main).toContain('data-graph-list');
    expect(main).toContain("once('[data-graph-list]', 'scroll', onGraphScroll)");
    expect(main).toContain('function graphRenderWindow(commits)');
    expect(main).toContain('function bindGraphViewport()');
    expect(css).toContain('.log-detail-splitter');
    expect(css).toContain('.commit-detail-splitter');
    expect(css).toContain('.commit-panel-splitter');
    expect(css).toContain('body.log-detail-resizing');
    expect(css).toContain('body.commit-detail-resizing');
    expect(css).toContain('body.commit-panel-resizing');
    expect(main).toContain("post('loadMoreCommits')");
    expect(main).toContain('class="commit-files file-tree"');
    expect(main).toContain("const target = document.createElement('main');");
    expect(main).toContain("target.id = 'app';");
    expect(main).toContain('const repositoryStates =');
    expect(main).toContain('saveRepositoryState(previousRoot)');
    expect(main).toContain('restoreRepositoryState(nextRoot, nextState)');
    expect(main).toContain('graphScrollTop: ui.graphScrollTop');
    expect(main).toContain('commitPanelHeight: ui.commitPanelHeight');
  });

  it('renders branch search results in batches and navigates to History from the branch popup', async () => {
    const main = await readFile(path.join(root, 'media', 'main.js'), 'utf8');
    expect(main).toContain('const BRANCH_PAGE_SIZE = 36;');
    expect(main).toContain('branchGroupsExpanded:');
    expect(main).toContain('data-branch-group=');
    expect(main).toContain('data-branch-more=');
    expect(main).toContain('data-branch-popup-more=');
    expect(main).toContain('const visibleCount = ui.branchVisibleCounts[key];');
    expect(main).toContain('const count = ui.branchPopupVisibleCounts[key];');
    expect(main).toContain('ui.branchVisibleCounts = { local: BRANCH_PAGE_SIZE, remote: BRANCH_PAGE_SIZE, tags: BRANCH_PAGE_SIZE };');
    expect(main).toContain('ui.branchPopupVisibleCounts = { local: BRANCH_PAGE_SIZE, remote: BRANCH_PAGE_SIZE };');
    expect(main).toContain("post('showBranchHistory', { branch: menu.ref })");
    expect(main).toContain("message.type === 'applyBranchFilter'");
  });

  it('uses one native-feeling context-menu and list-state vocabulary', async () => {
    const main = await readFile(path.join(root, 'media', 'main.js'), 'utf8');
    const css = await readFile(path.join(root, 'media', 'main.css'), 'utf8');
    expect(main).toContain('class="context-menu file-context-menu"');
    expect(main).toContain('class="context-menu branch-context-menu"');
    expect(main).toContain('class="context-menu commit-context-menu"');
    expect(main).toContain('class="graph-loading-row"');
    expect(css).toContain('--idea-hover:');
    expect(css).toContain('--idea-selection:');
    expect(css).toContain('.parity-mode .graph-row:hover:not(.selected)');
    expect(css).toContain('.graph-loading-row');
  });

  it('renders active-theme file icons for changed files and keeps a native fallback', async () => {
    const main = await readFile(path.join(root, 'media', 'main.js'), 'utf8');
    const provider = await readFile(path.join(root, 'src', 'IdeaGitViewProvider.ts'), 'utf8');
    expect(main).toContain('function renderFileTypeIcon(change)');
    expect(main).toContain('class="file-type-icon"');
    expect(main).toContain("icon('file-code', 'file-type-icon file-type-icon-fallback')");
    expect(provider).toContain('FileIconThemeResolver');
    expect(provider).toContain("type: 'fileIconCss'");
    expect(provider).toContain('workbench.iconTheme');
  });

  it('routes file context actions through the native extension surface', async () => {
    const main = await readFile(path.join(root, 'media', 'main.js'), 'utf8');
    const provider = await readFile(path.join(root, 'src', 'IdeaGitViewProvider.ts'), 'utf8');
    const layout = await readFile(path.join(root, 'src', 'viewLayout.ts'), 'utf8');
    expect(main).toContain("post('openFile', { path: change.path })");
    expect(main).toContain("post('moveFileToChangelist', { path: change.path })");
    expect(main).toContain("post('copyPath', { path: change.path })");
    expect(main).toContain("post('showFileHistory', { path: change.path })");
    expect(main).toContain("post('revealInExplorer', { path: change.path })");
    expect(provider).toContain("type: 'moveFileToChangelist'");
    expect(provider).toContain("showQuickPick(options");
    expect(provider).toContain("vscode.env.clipboard.writeText(message.path)");
    expect(layout).toContain("'openFile'");
    expect(layout).toContain("'moveFileToChangelist'");
    expect(layout).toContain("'copyPath'");
    expect(layout).toContain("'showFileHistory'");
    expect(layout).toContain("'revealInExplorer'");
  });

  it('accepts Explorer navigation and commit revision actions through the extension host', async () => {
    const main = await readFile(path.join(root, 'media', 'main.js'), 'utf8');
    const provider = await readFile(path.join(root, 'src', 'IdeaGitViewProvider.ts'), 'utf8');
    expect(provider).toContain('async openResourceDiff(uri?: vscode.Uri)');
    expect(provider).toContain('async showFileHistory(uri?: vscode.Uri)');
    expect(provider).toContain('async showResourceInChanges(uri?: vscode.Uri)');
    expect(provider).toContain('async moveResourceToChangelist(uri?: vscode.Uri)');
    expect(provider).toContain("type: 'applyPathFilter'");
    expect(provider).toContain("type: 'revealFile'");
    expect(provider).toContain('client.createTag(tag, hash)');
    expect(provider).toContain('client.checkoutRevision(hash)');
    expect(main).toContain("message.type === 'applyPathFilter'");
    expect(main).toContain("message.type === 'revealFile'");
  });

  it('keeps commit readiness and menu focus predictable', async () => {
    const main = await readFile(path.join(root, 'media', 'main.js'), 'utf8');
    expect(main).toContain('selectedCount && ui.commitMessage.trim() && !ui.busy');
    expect(main).toContain('function syncCommitActionState()');
    expect(main).toContain('syncCommitActionState();');
    expect(main).toContain("returnFocus: anchor ? 'menu' : 'file'");
    expect(main).toContain("row?.querySelector(returnFocus === 'menu' ? '[data-file-menu]' : '[data-diff]')?.focus()");
  });

  it('uses one restrained visual layer without the retired spectral overrides', async () => {
    const css = await readFile(path.join(root, 'media', 'main.css'), 'utf8');
    expect(css).toContain('Kivo restrained visual layer');
    expect(css).not.toContain('Kivo visual layer');
    expect(css).not.toContain('linear-gradient');
    expect(css).not.toContain('radial-gradient');
    expect(css).not.toContain('translateX(1px)');
  });

  it('labels each resolved webview with its declared surface for deterministic rendering', async () => {
    const provider = await readFile(path.join(root, 'src', 'IdeaGitViewProvider.ts'), 'utf8');
    expect(provider).toContain('data-surface="${surface}"');
    expect(provider).toContain('this.html(view.webview, surface)');
    expect(provider).toContain('changes.title = \'Commit\'');
    expect(provider).toContain("history.title = 'History'");
    expect(provider).toContain('history.description = snapshot.branch');
    expect(provider).toContain('private async commitAndPush');
    expect(provider).toContain("'media', 'graph-layout.js'");
    expect(provider).toContain('const HISTORY_PAGE_SIZE = 80;');
    expect(provider).toContain('this.commitLimit += HISTORY_PAGE_SIZE;');
  });
});
