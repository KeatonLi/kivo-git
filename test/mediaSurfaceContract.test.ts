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
    expect(main).toContain('function renderCommitToolbar(s)');
    expect(main).toContain('class="commit-changes-heading"');
    expect(main).toContain('Commit and Push…');
    expect(main).toContain('function renderLogActionRail()');
    expect(main).toContain('class="log-branch-pane"');
    expect(main).toContain('data-log-splitter');
    expect(main).toContain('Resize History branch tree');
    expect(main).toContain('data-branch-context-action="new"');
    expect(main).toContain("once('[data-log-branch]', 'contextmenu', openBranchContextMenu)");
    expect(main).toContain("post('createBranch', { startPoint: menu.ref })");
    expect(main).toContain('<span>AUTHOR</span><span>GRAPH</span><span>COMMIT</span><span>DATE</span>');
    expect(main).toContain('class="commit-files file-tree"');
    expect(main).toContain("const target = document.createElement('main');");
    expect(main).toContain("target.id = 'app';");
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

  it('labels each resolved webview with its declared surface for deterministic rendering', async () => {
    const provider = await readFile(path.join(root, 'src', 'IdeaGitViewProvider.ts'), 'utf8');
    expect(provider).toContain('data-surface="${surface}"');
    expect(provider).toContain('this.html(view.webview, surface)');
    expect(provider).toContain('changes.title = \'Commit\'');
    expect(provider).toContain("history.title = 'History'");
    expect(provider).toContain('history.description = snapshot.branch');
    expect(provider).toContain('private async commitAndPush');
  });
});
