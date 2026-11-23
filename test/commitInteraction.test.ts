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
    ui: { snapshot: { root: '/repo', branch: 'topic', headOid: 'a'.repeat(40), changes, changelists: [{ id: 'default', changes }] }, selected: new Set(), collapsed: new Set(), changeFilter: 'staged', changeQuery: '', commitMessage: 'message', busy: false },
    document: { body: { dataset: {} } }, escapeHtml: String, icon: () => '',
    post: vi.fn(), toast: vi.fn(), persist: vi.fn(), render: vi.fn(), requestAnimationFrame: vi.fn()
  };
  runInNewContext(await readFile('media/change-selection.js', 'utf8'), context);
  const source = await readFile('media/main.js', 'utf8');
  const ast = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const names = new Set(['changeSelection', 'orderedPaths', 'setSelection', 'commitBlocker', 'canReviewCommitPush', 'commit', 'submitReviewedCommit', 'handleAction', 'renderSelectionStatus', 'runFileContextAction', 'matchesChangeFilter',
    'recordCommitPushOutcome', 'reconcileCommitPushOutcomes', 'commitPushContextKey', 'commitPushStatusRows']);
  const handlers = ast.statements.filter((node) => ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text));
  runInNewContext(handlers.map((node) => node.getText(ast)).join('\n'), context);
  return context;
}

describe('commit and push status reconciliation', () => {
  it('forgets verified pushes after upstream removal, even if tracking is restored', async () => {
    const c = await handlers();
    const s = c.ui.snapshot;
    c.ui.commitPushOutcomes = new Map();
    const destination = 'origin/topic';
    Object.assign(s, { trackingKnown: true, ahead: 0, behind: 0 });
    c.recordCommitPushOutcome({ root: s.root, id: 1, kind: 'push', phase: 'success',
      context: { root: s.root, branch: s.branch, head: s.headOid, destination } });
    // The operation event can arrive before the post-publish snapshot.
    c.reconcileCommitPushOutcomes(s);
    expect(c.commitPushStatusRows(s)).toContain('data-commit-status="push" data-state="unpublished"');
    s.upstream = destination;
    c.reconcileCommitPushOutcomes(s, true);
    expect(c.commitPushStatusRows(s)).toContain('data-commit-status="push" data-state="pushed"');
    delete s.upstream;
    c.reconcileCommitPushOutcomes(s, true);
    expect(c.commitPushStatusRows(s)).toContain('data-commit-status="push" data-state="unpublished"');
    s.upstream = destination;
    c.reconcileCommitPushOutcomes(s, true);
    expect(c.commitPushStatusRows(s)).toContain('data-commit-status="push" data-state="none"');
  });

  it.each([['error', 'failed'], ['unverified', 'unverified']])('expires a %s commit outcome when HEAD changes', async (phase, state) => {
    const c = await handlers();
    const s = c.ui.snapshot;
    c.ui.commitPushOutcomes = new Map();
    c.recordCommitPushOutcome({ root: s.root, id: 1, kind: 'commit', phase,
      context: { root: s.root, branch: s.branch, head: s.headOid } });
    c.reconcileCommitPushOutcomes(s, true);
    expect(c.commitPushStatusRows(s)).toContain(`data-commit-status="commit" data-state="${state}"`);
    s.headOid = 'b'.repeat(40);
    c.reconcileCommitPushOutcomes(s, true);
    expect(c.commitPushStatusRows(s)).toContain('data-commit-status="commit" data-state="not-ready"');
  });
});

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
    expect(context.ui.commitReviewOpen).toBe(true);
    expect(context.post).not.toHaveBeenCalled();
    context.submitReviewedCommit();
    expect(context.post).toHaveBeenCalledWith('commit', { root: '/repo', branch: 'topic', head: 'a'.repeat(40), message: 'message', paths: ['visible.txt'] });
  });

  it('only starts push review from the explicit choice after a valid local review', async () => {
    const context = await handlers();
    context.ui.selected.add('visible.txt');
    context.ui.snapshot.identity = { ready: false };
    context.commit();
    expect(context.commitBlocker()).toContain('identity');
    expect(context.ui.commitReviewOpen).not.toBe(true);
    context.ui.snapshot.identity.ready = true;
    context.commit();
    context.ui.snapshot.changes[1].kind = 'conflict';
    context.submitReviewedCommit(true);
    expect(context.post).not.toHaveBeenCalled();
    expect(context.commitBlocker()).toContain('conflicts');
    context.ui.snapshot.changes[1].kind = 'modified';
    context.ui.snapshot.remotes = [];
    context.submitReviewedCommit(true);
    expect(context.post).not.toHaveBeenCalled();
    context.ui.snapshot.remotes = ['origin'];
    context.submitReviewedCommit(true);
    expect(context.post).toHaveBeenCalledExactlyOnceWith('commitAndPush', { root: '/repo', branch: 'topic', head: 'a'.repeat(40), message: 'message', paths: ['visible.txt'] });
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
