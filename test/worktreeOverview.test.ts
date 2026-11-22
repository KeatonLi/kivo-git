import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ui = vi.hoisted(() => ({ pick: vi.fn(), info: vi.fn(), error: vi.fn() }));
vi.mock('vscode', () => ({ window: { showQuickPick: ui.pick, showInformationMessage: ui.info, showErrorMessage: ui.error } }));
import { IdeaGitViewProvider } from '../src/IdeaGitViewProvider';

const roots: string[] = [];
beforeEach(() => { ui.pick.mockReset(); ui.info.mockReset(); ui.error.mockReset(); });
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

async function harness() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kivo-worktree-overview-')); roots.push(root);
  const nested = path.join(root, 'source'); await fs.mkdir(nested);
  const linked = path.join(root, 'linked'); await fs.mkdir(linked);
  const client = { workspaceRoot: nested, getWorktrees: vi.fn().mockResolvedValue([
    { path: root, branch: 'main', head: 'a'.repeat(40) },
    { path: linked, detached: true, head: 'abcdef12'.repeat(5), locked: '' },
    { path: path.join(root, 'gone'), branch: 'missing', prunable: 'directory missing' },
    { path: path.join(root, 'bare.git'), bare: true }
  ]) };
  let selectedRoot = nested;
  const provider = Object.assign(Object.create(IdeaGitViewProvider.prototype), {
    getClient: vi.fn().mockResolvedValue(client),
    selectedWorkspace: () => ({ uri: { fsPath: selectedRoot } }),
    openRegisteredWorktree: vi.fn(), createWorktreeWithReview: vi.fn(), removeWorktreeWithReview: vi.fn(), postToView: vi.fn()
  });
  return { root, nested, linked, client, provider, select: (value: string) => { selectedRoot = value; } };
}

describe('worktree overview', () => {
  it('identifies the current worktree for a nested workspace and shows registered state and paths', async () => {
    const { root, nested, linked, provider } = await harness();
    ui.pick.mockResolvedValue(undefined);
    await provider.handle('history', { type: 'chooseWorktree', root: nested });
    const [choices, options] = ui.pick.mock.calls[0]!;
    expect(options.title).toBe('Worktrees');
    expect(choices[0].label).toContain('Create Worktree');
    const worktrees = choices.filter((item: any) => item.action === 'open');
    expect(worktrees[0]).toMatchObject({ label: 'main', detail: root, description: 'Current' });
    expect(worktrees[1]).toMatchObject({ label: 'Detached HEAD · abcdef12', detail: linked, description: 'Other · Locked' });
    expect(worktrees[2].description).toContain('Unavailable');
    expect(worktrees[3]).toMatchObject({ label: 'Bare repository', description: 'Other · Bare' });
    expect(provider.openRegisteredWorktree).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')('resolves a symlinked workspace before marking the current worktree', async () => {
    const { root, nested, client, provider, select } = await harness();
    const link = path.join(root, 'workspace-link');
    await fs.symlink(nested, link, 'dir');
    client.workspaceRoot = link; select(link);
    ui.pick.mockResolvedValue(undefined);
    await provider.handle('history', { type: 'chooseWorktree', root: link });
    const choices = ui.pick.mock.calls[0]![0];
    expect(choices.find((item: any) => item.tree?.path === root)?.description).toBe('Current');
  });

  it('opens another worktree through the revalidating host path and routes creation', async () => {
    const { nested, linked, client, provider } = await harness();
    ui.pick.mockImplementationOnce(async choices => choices.find((item: any) => item.tree?.path === linked));
    await provider.handle('history', { type: 'chooseWorktree', root: nested });
    expect(provider.openRegisteredWorktree).toHaveBeenCalledWith(client, linked);
    ui.pick.mockImplementationOnce(async choices => choices[0]);
    await provider.handle('history', { type: 'chooseWorktree', root: nested });
    expect(provider.createWorktreeWithReview).toHaveBeenCalledWith(client, 'history');
  });

  it('routes new worktrees from the current branch and from exact History commits', async () => {
    const { nested, client, provider } = await harness();
    ui.pick.mockImplementationOnce(async choices => choices.find((item: any) => item.action === 'createFromCurrent'));
    await provider.handle('history', { type: 'chooseWorktree', root: nested });
    expect(provider.createWorktreeWithReview).toHaveBeenNthCalledWith(1, client, 'history', { oid: 'a'.repeat(40), label: 'main' });
    const message = { type: 'createWorktree', root: nested, startPoint: 'b'.repeat(64) };
    await provider.handle('changes', message);
    await provider.handle('history', { ...message, root: '/other' });
    await provider.handle('history', { ...message, startPoint: 'HEAD' });
    await provider.handle('history', message);
    expect(provider.createWorktreeWithReview).toHaveBeenCalledTimes(2);
    expect(provider.createWorktreeWithReview).toHaveBeenNthCalledWith(2, client, 'history', { oid: message.startPoint, label: 'Selected commit' });
  });

  it('excludes main, current, locked, unavailable and bare worktrees from removal choices', async () => {
    const { nested, root, provider, client } = await harness();
    const removable = { path: path.join(root, 'removable'), branch: 'topic', head: 'b'.repeat(40) };
    client.getWorktrees.mockResolvedValueOnce([...(await client.getWorktrees()), removable]);
    ui.pick.mockImplementationOnce(async choices => choices.find((item: any) => item.action === 'remove'));
    await provider.handle('history', { type: 'chooseWorktree', root: nested });
    expect(provider.removeWorktreeWithReview).toHaveBeenCalledExactlyOnceWith(client, 'history', [removable]);
  });

  it('does not open or create after repository changes during the picker', async () => {
    const { nested, provider, select } = await harness();
    ui.pick.mockImplementationOnce(async choices => { select('/other'); return choices[0]; });
    await provider.handle('history', { type: 'chooseWorktree', root: nested });
    expect(provider.createWorktreeWithReview).not.toHaveBeenCalled();
    expect(provider.openRegisteredWorktree).not.toHaveBeenCalled();
  });

  it('does not open the current or unavailable worktree', async () => {
    const { root, nested, provider } = await harness();
    ui.pick.mockImplementationOnce(async choices => choices.find((item: any) => item.tree?.path === root));
    await provider.handle('history', { type: 'chooseWorktree', root: nested });
    expect(ui.info).toHaveBeenLastCalledWith(expect.stringContaining('already open'));
    ui.pick.mockImplementationOnce(async choices => choices.find((item: any) => item.tree?.prunable !== undefined));
    await provider.handle('history', { type: 'chooseWorktree', root: nested });
    expect(ui.info).toHaveBeenLastCalledWith(expect.stringContaining('cannot be opened'));
    expect(provider.openRegisteredWorktree).not.toHaveBeenCalled();
  });

  it('does not show a picker when the repository changes while loading worktrees', async () => {
    const { nested, client, provider, select } = await harness();
    client.getWorktrees.mockImplementationOnce(async () => { select('/other'); return []; });
    await provider.handle('history', { type: 'chooseWorktree', root: nested });
    expect(ui.pick).not.toHaveBeenCalled();
  });
});
