import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  window: { showErrorMessage: vi.fn().mockResolvedValue(undefined), withProgress: vi.fn((_options, action) => action()) },
  commands: { executeCommand: vi.fn().mockResolvedValue(undefined) },
  env: { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } },
  Uri: { file: (fsPath: string) => ({ fsPath }) }, ProgressLocation: { SourceControl: 1 }
}));
import * as vscode from 'vscode';
import { IdeaGitViewProvider } from '../src/IdeaGitViewProvider';
import { CheckoutError } from '../src/git/checkout';

const roots: string[] = [];
beforeEach(() => vi.clearAllMocks());
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
function harness(visible = true) {
  const root = '/repo/main', post = vi.fn().mockResolvedValue(undefined), viewPost = vi.fn().mockResolvedValue(true);
  const client = { workspaceRoot: root, getWorktrees: vi.fn().mockResolvedValue([]), checkCheckout: vi.fn() };
  const provider = Object.assign(Object.create(IdeaGitViewProvider.prototype), {
    operationId: 0, operationRunning: false, operationFailures: new Map(),
    operationOutput: { appendLine: vi.fn(), show: vi.fn() },
    views: new Map([['history', { visible, webview: { postMessage: viewPost } }]]), readyViews: new Set(['history']),
    selectedWorkspace: () => ({ uri: { fsPath: root } }), getClient: vi.fn().mockResolvedValue(client),
    postToReadyViews: post, postToView: vi.fn(), availableRepositories: () => [],
    coordinator: { beginWrite: vi.fn(), endWrite: vi.fn(), reset: vi.fn() }, repositoryEmitter: { fire: vi.fn() }
  });
  return { root, provider, client, post, viewPost };
}

describe('operation failure visibility and recovery', () => {
  it('retains a write failure and replays it when the History panel reopens', async () => {
    const { provider, root, post, viewPost } = harness();
    expect(await provider.operation('checkout', 'Switching', async () => { throw new Error('Git failed'); }, 'Switched')).toBe(false);
    expect(provider.operationFailures.get(root)).toMatchObject({ root, title: 'Git failed', id: 1 });
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'operationFailure', root }));
    await provider.postSnapshotToView('history', { root, changes: [] });
    expect(viewPost).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'snapshot', payload: expect.objectContaining({ failure: expect.objectContaining({ title: 'Git failed' }) }) }));
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    expect(provider.repositoryEmitter.fire).toHaveBeenCalled();
    expect(provider.coordinator.endWrite).toHaveBeenCalledOnce();
  });
  it('uses a native notification if no plugin panel is visible', async () => {
    const { provider, root } = harness(false);
    await provider.recordOperationFailure(new Error('Checkout blocked'), root, 'checkout', 3);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Kivo Git: Checkout blocked', 'Show Details', 'Open History');
  });
  it('makes preflight rejection visible without attempting a write', async () => {
    const { provider, root, client } = harness();
    const error = new CheckoutError('worktree-occupied', 'feature is open elsewhere'); error.worktreePath = '/repo/linked';
    client.checkCheckout.mockRejectedValue(error);
    await provider.handle('history', { type: 'checkout', root, branch: 'feature', remote: false });
    expect(provider.operationFailures.get(root)).toMatchObject({ worktreePath: '/repo/linked', actions: expect.arrayContaining(['openWorktree']) });
    expect(provider.coordinator.beginWrite).not.toHaveBeenCalled();
  });
  it('associates late preflight errors with the originating worktree', async () => {
    const { provider, root, client } = harness();
    let fail!: (error: Error) => void;
    client.checkCheckout.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
    const request = provider.handle('history', { type: 'checkout', root, branch: 'feature', remote: false });
    await Promise.resolve();
    provider.selectedWorkspace = () => ({ uri: { fsPath: '/repo/new' } });
    fail(new Error('Old worktree is blocked')); await request;
    expect(provider.operationFailures.get(root)).toMatchObject({ title: 'Old worktree is blocked' });
    expect(provider.operationFailures.has('/repo/new')).toBe(false);
  });
  it('does not start a checkout if repository selection changed during preflight', async () => {
    const { provider, client } = harness();
    client.checkCheckout.mockResolvedValue(undefined);
    Object.assign(client, { snapshot: vi.fn(async () => {
      provider.selectedWorkspace = () => ({ uri: { fsPath: '/repo/new' } });
      return { changes: [] };
    }) });
    provider.operation = vi.fn();
    await provider.checkoutWithReview(client, 'history', 'feature', false);
    expect(provider.operation).not.toHaveBeenCalled();
  });
  it('rejects a checkout posted by an old repository before inspecting or writing the new one', async () => {
    const { provider, client } = harness(); provider.refresh = vi.fn().mockResolvedValue(undefined);
    await provider.handle('history', { type: 'checkout', root: '/repo/previous', branch: 'main', remote: false });
    expect(client.checkCheckout).not.toHaveBeenCalled();
    expect(provider.coordinator.beginWrite).not.toHaveBeenCalled();
    expect(provider.postToView).toHaveBeenCalledWith('history', expect.objectContaining({ type: 'notice', phase: 'error' }));
  });
  it('rejects stale or foreign recovery messages and clears the exact dismissed failure', async () => {
    const { provider, root, client } = harness(); await provider.recordOperationFailure(new Error('Problem'), root, 'checkout', 5);
    await provider.recoverOperation(client, 'history', { root: '/repo/other', id: 5, action: 'copy' });
    await provider.recoverOperation(client, 'history', { root, id: 4, action: 'copy' });
    expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();
    await provider.recoverOperation(client, 'history', { root, id: 5, action: 'copy' });
    expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('Problem'));
    await provider.recoverOperation(client, 'history', { root, id: 5, action: 'dismiss' });
    expect(provider.operationFailures.has(root)).toBe(false);
  });
  it('revalidates registered worktrees before opening a new window', async () => {
    const { provider, client } = harness(); const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kivo-open-worktree-')); roots.push(dir);
    client.getWorktrees.mockResolvedValue([{ path: dir, branch: 'feature' }]);
    await provider.openRegisteredWorktree(client, dir);
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('vscode.openFolder', { fsPath: dir }, true);
    vi.mocked(vscode.commands.executeCommand).mockClear(); client.getWorktrees.mockResolvedValue([]);
    await expect(provider.openRegisteredWorktree(client, dir)).rejects.toThrow('no longer registered');
    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
  });
});
