import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

// Execute the actual UI handlers without a browser. Rendering and the message
// bridge are test boundaries, not reimplementations of the selection behavior.
async function handlers() {
  const changes = [
    { path: 'visible.txt', kind: 'modified', staged: true, indexStatus: 'M', workingTreeStatus: '.' },
    { path: 'hidden.txt', kind: 'modified', staged: false, indexStatus: '.', workingTreeStatus: 'M' }
  ];
  const context: Record<string, any> = {
    ui: { snapshot: { changes, changelists: [{ id: 'default', changes }] }, selected: new Set(), collapsed: new Set(), changeFilter: 'staged', changeQuery: '', commitMessage: 'message', busy: false },
    post: vi.fn(), toast: vi.fn(), persist: vi.fn(), render: vi.fn()
  };
  runInNewContext(await readFile('media/change-selection.js', 'utf8'), context);
  const source = await readFile('media/main.js', 'utf8');
  const ast = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const names = new Set(['changeSelection', 'orderedPaths', 'setSelection', 'commitBlocker', 'commit', 'handleAction', 'renderSelectionStatus', 'runFileContextAction', 'matchesChangeFilter']);
  const handlers = ast.statements.filter((node) => ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text));
  runInNewContext(handlers.map((node) => node.getText(ast)).join('\n'), context);
  return context;
}

describe('commit interaction safety', () => {
  it('applies the current filter to context-menu selection', async () => {
    const context = await handlers();
    context.ui.fileContextMenu = { path: 'visible.txt', listId: 'default' };
    context.runFileContextAction({ preventDefault() {}, stopPropagation() {}, currentTarget: { dataset: { fileContextAction: 'select-list' } } });
    expect([...context.ui.selected]).toEqual(['visible.txt']);
  });
  it('blocks hidden selections and only submits reviewed files after removing them', async () => {
    const context = await handlers();
    context.ui.selected = new Set(['visible.txt', 'hidden.txt']);
    context.commit();
    expect(context.post).not.toHaveBeenCalled();
    expect(context.toast).toHaveBeenCalledWith(expect.stringContaining('hidden'), 'error');
    expect(context.renderSelectionStatus()).toContain('1 hidden by filters');
    context.handleAction('clear-hidden-selection');
    context.commit();
    expect(context.post).toHaveBeenCalledWith('commit', { message: 'message', paths: ['visible.txt'] });
  });

  it('uses the same validation for keyboard submission and commit-and-push', async () => {
    const context = await handlers();
    context.ui.selected.add('visible.txt');
    context.ui.snapshot.identity = { ready: false };
    context.commit(true);
    expect(context.post).not.toHaveBeenCalled();
    expect(context.commitBlocker()).toContain('identity');
    context.ui.snapshot.identity.ready = true;
    context.ui.snapshot.changes[1].kind = 'conflict';
    context.commit(true);
    expect(context.post).not.toHaveBeenCalled();
    expect(context.commitBlocker()).toContain('conflicts');
  });

  it('preserves drafts while clearing selection and explains full-file semantics', async () => {
    const context = await handlers();
    context.ui.selected.add('visible.txt');
    expect(context.renderSelectionStatus()).toContain('all working-tree changes');
    context.handleAction('clear-selection');
    expect(context.ui.selected.size).toBe(0);
    expect(context.ui.commitMessage).toBe('message');
    context.commit();
    expect(context.post).not.toHaveBeenCalled();
  });
});
