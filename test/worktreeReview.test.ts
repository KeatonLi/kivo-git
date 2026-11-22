import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';

const ui = vi.hoisted(() => ({ pick: vi.fn(), folder: vi.fn(), input: vi.fn(), information: vi.fn(), warning: vi.fn(),
  workspace: { workspaceFolders: [] as { uri: { scheme: string; fsPath: string } }[], textDocuments: [] as { uri: { scheme: string; fsPath: string }; isDirty: boolean }[] } }));
vi.mock('vscode', () => ({ workspace: ui.workspace, window: { showQuickPick: ui.pick, showOpenDialog: ui.folder, showInputBox: ui.input,
  showInformationMessage: ui.information, showWarningMessage: ui.warning, showErrorMessage: vi.fn() } }));
import { IdeaGitViewProvider } from '../src/IdeaGitViewProvider';
import { WorktreeCreationError, WorktreeRemovalError } from '../src/git/checkout';
import { operationFailure } from '../src/operationFeedback';

function harness() {
  const root = '/repo';
  let selected = root;
  const plan = { root, branch: 'feature', head: 'a'.repeat(40), path: path.join('/parent', 'feature') };
  const client = { workspaceRoot: root, listAvailableWorktreeBranches: vi.fn().mockResolvedValue([{ name: 'feature', oid: 'b' }]),
    prepareWorktree: vi.fn().mockResolvedValue(plan), prepareNewBranchWorktree: vi.fn().mockResolvedValue({ ...plan }),
    createWorktree: vi.fn().mockResolvedValue({ path: plan.path }),
    prepareWorktreeRemoval: vi.fn().mockResolvedValue({ worktree: plan }), removeWorktree: vi.fn().mockResolvedValue({ removed: true }) };
  const provider = Object.assign(Object.create(IdeaGitViewProvider.prototype), {
    selectedWorkspace: () => ({ uri: { fsPath: selected } }), operationRunning: false,
    operation: vi.fn(async (_kind, _label, action) => { await action(); return true; }),
    openRegisteredWorktree: vi.fn().mockResolvedValue(undefined)
  });
  return { root, plan, client, provider, select: (next: string) => { selected = next; } };
}

beforeEach(() => {
  vi.resetAllMocks();
  ui.workspace.workspaceFolders.length = 0;
  ui.workspace.textDocuments.length = 0;
  ui.pick.mockResolvedValue({ label: 'feature' });
  ui.folder.mockResolvedValue([{ scheme: 'file', fsPath: '/parent' }]);
  ui.input.mockResolvedValue('feature');
  ui.information.mockResolvedValueOnce('Create Worktree').mockResolvedValueOnce(undefined);
});

describe('worktree creation review', () => {
  it('shows only unoccupied local branches and creates exactly the reviewed plan', async () => {
    const { provider, client, plan } = harness();
    await provider.createWorktreeWithReview(client, 'history');
    expect(ui.pick.mock.calls[0]![0]).toEqual([{ label: 'feature' }]);
    expect(client.prepareWorktree).toHaveBeenCalledWith('feature', path.join('/parent', 'feature'));
    expect(ui.information.mock.calls[0]![1].detail).toContain(plan.path);
    expect(ui.information.mock.calls[0]![1].detail).toContain(plan.head);
    expect(client.createWorktree).toHaveBeenCalledExactlyOnceWith(plan);
  });

  it('does not write if review is cancelled or the repository changes', async () => {
    const first = harness();
    ui.information.mockReset().mockResolvedValue(undefined);
    await first.provider.createWorktreeWithReview(first.client, 'history');
    expect(first.client.createWorktree).not.toHaveBeenCalled();
    const second = harness();
    ui.information.mockImplementation(async () => { second.select('/other'); return 'Create Worktree'; });
    await second.provider.createWorktreeWithReview(second.client, 'history');
    expect(second.client.createWorktree).not.toHaveBeenCalled();
  });

  it('reviews and opens a new branch at the exact selected commit without querying available branches', async () => {
    const { provider, client, plan } = harness();
    const oid = 'f'.repeat(64);
    ui.information.mockReset().mockResolvedValue('Create and Open');
    await provider.createWorktreeWithReview(client, 'history', { oid, label: 'Selected commit' });
    expect(client.listAvailableWorktreeBranches).not.toHaveBeenCalled();
    expect(client.prepareNewBranchWorktree).toHaveBeenCalledExactlyOnceWith('feature', plan.path, oid);
    expect(ui.information.mock.calls[0]![1].detail).toContain('Base: Selected commit');
    expect(client.createWorktree).toHaveBeenCalledExactlyOnceWith(plan);
    expect(provider.openRegisteredWorktree).toHaveBeenCalledExactlyOnceWith(client, plan.path);
  });

  it('reviews the exact removal plan before writing', async () => {
    const { provider, client, plan } = harness();
    ui.pick.mockImplementation(async choices => choices[0]);
    ui.warning.mockResolvedValue('Remove Worktree');
    await provider.removeWorktreeWithReview(client, 'history', [plan]);
    expect(client.prepareWorktreeRemoval).toHaveBeenCalledExactlyOnceWith(plan.path);
    expect(ui.warning.mock.calls[0]![1].detail).toContain(plan.head);
    expect(ui.warning.mock.calls[0]![1].detail).toContain('No branch will be deleted');
    expect(client.removeWorktree).toHaveBeenCalledExactlyOnceWith({ worktree: plan });
  });

  it('does not remove after cancel, repository switch, or an unsaved edit during confirmation', async () => {
    const { provider, client, plan, select, root } = harness();
    ui.pick.mockImplementation(async choices => choices[0]);
    await provider.removeWorktreeWithReview(client, 'history', [plan]);
    ui.warning.mockImplementationOnce(async () => { select('/other'); return 'Remove Worktree'; });
    await provider.removeWorktreeWithReview(client, 'history', [plan]);
    select(root);
    ui.warning.mockImplementationOnce(async () => {
      ui.workspace.textDocuments.push({ uri: { scheme: 'file', fsPath: path.join(plan.path, 'edit.txt') }, isDirty: true });
      return 'Remove Worktree';
    });
    await expect(provider.removeWorktreeWithReview(client, 'history', [plan])).rejects.toThrow('unsaved editors');
    expect(client.removeWorktree).not.toHaveBeenCalled();
  });

  it('reports actual registration and directory after Git reports a removal failure', () => {
    const error = new WorktreeRemovalError('Removal incomplete', 'Git failed', { removed: false, pathExists: true, worktree: { path: '/parent/feature' } });
    expect(operationFailure(error, { root: '/repo', kind: 'branch', id: 1 })).toMatchObject({
      worktreePath: '/parent/feature', details: expect.stringContaining('Directory present: yes'), actions: expect.arrayContaining(['openWorktree', 'refresh'])
    });
  });

  it('offers an actionable recovery for a worktree registered after Git reported failure', () => {
    const error = new WorktreeCreationError('Creation needs inspection', { path: '/parent/feature', branch: 'feature' }, 'hook failed');
    expect(operationFailure(error, { root: '/repo', kind: 'branch', id: 1 })).toMatchObject({
      worktreePath: '/parent/feature', details: expect.stringContaining('hook failed'), actions: expect.arrayContaining(['openWorktree'])
    });
  });
});
