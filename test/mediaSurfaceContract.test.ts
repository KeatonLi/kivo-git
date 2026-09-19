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

  it('labels each resolved webview with its declared surface for deterministic rendering', async () => {
    const provider = await readFile(path.join(root, 'src', 'IdeaGitViewProvider.ts'), 'utf8');
    expect(provider).toContain('data-surface="${surface}"');
    expect(provider).toContain('this.html(view.webview, surface)');
  });
});
