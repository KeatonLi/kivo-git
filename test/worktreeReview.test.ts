import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';

const ui = vi.hoisted(() => ({ pick: vi.fn(), folder: vi.fn(), input: vi.fn(), information: vi.fn() }));
vi.mock('vscode', () => ({ window: { showQuickPick: ui.pick, showOpenDialog: ui.folder, showInputBox: ui.input,
  showInformationMessage: ui.information, showErrorMessage: vi.fn() } }));
import { IdeaGitViewProvider } from '../src/IdeaGitViewProvider';
import { WorktreeCreationError } from '../src/git/checkout';
import { operationFailure } from '../src/operationFeedback';

function harness() {
  const root = '/repo';
  let selected = root;
  const plan = { root, branch: 'feature', head: 'a'.repeat(40), path: path.join('/parent', 'feature') };
  const client = { workspaceRoot: root, listAvailableWorktreeBranches: vi.fn().mockResolvedValue([{ name: 'feature', oid: 'b' }]),
    prepareWorktree: vi.fn().mockResolvedValue(plan), createWorktree: vi.fn().mockResolvedValue({ path: plan.path }) };
  const provider = Object.assign(Object.create(IdeaGitViewProvider.prototype), {
    selectedWorkspace: () => ({ uri: { fsPath: selected } }), operationRunning: false,
    operation: vi.fn(async (_kind, _label, action) => { await action(); return true; }),
    openRegisteredWorktree: vi.fn().mockResolvedValue(undefined)
  });
  return { root, plan, client, provider, select: (next: string) => { selected = next; } };
}

beforeEach(() => {
  vi.clearAllMocks();
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

  it('offers an actionable recovery for a worktree registered after Git reported failure', () => {
    const error = new WorktreeCreationError('Creation needs inspection', { path: '/parent/feature', branch: 'feature' }, 'hook failed');
    expect(operationFailure(error, { root: '/repo', kind: 'branch', id: 1 })).toMatchObject({
      worktreePath: '/parent/feature', details: expect.stringContaining('hook failed'), actions: expect.arrayContaining(['openWorktree'])
    });
  });
});
