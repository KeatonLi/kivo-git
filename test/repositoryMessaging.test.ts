import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({ window: { showErrorMessage: vi.fn() } }));

import { IdeaGitViewProvider } from '../src/IdeaGitViewProvider';

function harness() {
  const root = 'c:\\Projects\\Kivo';
  let selectedRoot = root;
  const stashes = vi.fn().mockResolvedValue([{ hash: 'saved', subject: 'Work in progress' }]);
  const client = { workspaceRoot: root, workflows: { stashes } };
  const post = vi.fn().mockResolvedValue(undefined);
  // Exercise the actual message handler without unrelated VS Code startup/polling.
  const provider = Object.assign(Object.create(IdeaGitViewProvider.prototype), {
    workflowSessions: new Map(),
    getClient: vi.fn().mockResolvedValue(client),
    selectedWorkspace: () => ({ uri: { fsPath: selectedRoot } }),
    postToView: post
  });
  return { provider, root, stashes, post, select: (value: string) => { selectedRoot = value; } };
}

describe('repository workflow message routing', () => {
  it('returns workflow results with the exact host repository identity', async () => {
    const { provider, root, post, stashes } = harness();
    await provider.handle('changes', { type: 'workflowRequest', kind: 'stashes', root, requestId: 1 });
    expect(stashes).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledWith('changes', {
      type: 'workflowResult', root, requestId: 1, payload: [{ hash: 'saved', subject: 'Work in progress' }]
    });
  });

  it('ends a rejected request without reading another repository', async () => {
    const { provider, root, post, stashes } = harness();
    await provider.handle('changes', { type: 'workflowRequest', kind: 'stashes', root: `${root}-other`, requestId: 2 });
    expect(stashes).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith('changes', expect.objectContaining({
      type: 'workflowResult', root: `${root}-other`, requestId: 2, error: expect.any(String)
    }));
  });

  it('ends loading when the Git client becomes unavailable', async () => {
    const { provider, root, post } = harness();
    provider.getClient.mockRejectedValueOnce(new Error('Repository was moved'));
    await provider.handle('changes', { type: 'workflowRequest', kind: 'stashes', root, requestId: 3 });
    expect(post).toHaveBeenCalledWith('changes', {
      type: 'workflowResult', root, requestId: 3, error: 'Repository was moved'
    });
  });

  it('drops an in-flight result after repository selection changes', async () => {
    const { provider, root, post, stashes, select } = harness();
    let finish!: (value: unknown[]) => void;
    stashes.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const request = provider.handle('history', { type: 'workflowRequest', kind: 'stashes', root, requestId: 4 });
    await Promise.resolve();
    select('c:\\Projects\\Another');
    finish([{ hash: 'stale' }]);
    await request;
    expect(post).not.toHaveBeenCalled();
  });

  it('drops an earlier result when a newer workflow request replaces it', async () => {
    const { provider, root, post, stashes } = harness();
    let finish!: (value: unknown[]) => void;
    stashes.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const old = provider.handle('changes', { type: 'workflowRequest', kind: 'stashes', root, requestId: 5 });
    await Promise.resolve();
    await provider.handle('changes', { type: 'workflowRequest', kind: 'stashes', root, requestId: 6 });
    finish([{ hash: 'stale' }]);
    await old;
    expect(post).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledWith('changes', expect.objectContaining({ type: 'workflowResult', requestId: 6 }));
  });
});

describe('repository activity badge', () => {
  it.each([0, 2])('clears a clean repository count while preserving %i changes in other repositories', async (otherCount) => {
    const root = 'c:\\Projects\\Kivo';
    const view = { badge: { value: 5, tooltip: 'Old count' } };
    const provider = Object.assign(Object.create(IdeaGitViewProvider.prototype), {
      views: new Map([['changes', view]]),
      readyViews: new Set(['changes']),
      badgeCounts: new Map([[root, 5], ['c:\\Projects\\Another', otherCount]]),
      postSnapshotToView: vi.fn().mockResolvedValue(undefined)
    });
    await provider.postSnapshotToReadyViews({ root, changes: [] });
    // VS Code can retain the previous activity when a Webview badge is set to undefined.
    expect(view.badge.value).toBe(otherCount);
    expect(provider.badgeCount).toBe(otherCount);
  });
});
