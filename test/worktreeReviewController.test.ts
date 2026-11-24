import { describe, expect, it, vi } from 'vitest';
import type { Memento } from 'vscode';
import { WorktreeReviewController } from '../src/WorktreeReviewController';
import type { WorktreeReviewInventory } from '../src/git/WorktreeReviewGit';

const git = vi.hoisted(() => ({ inventory: vi.fn(), data: vi.fn(), details: vi.fn() }));
vi.mock('vscode', () => ({}));
vi.mock('../src/git/WorktreeReviewGit', () => ({ readWorktreeReviewInventory: git.inventory, readWorktreeReviewData: git.data }));
vi.mock('../src/git/GitClient', () => ({ GitClient: class { commitDetails = git.details; } }));

const root = '/repo';
const oid = 'a'.repeat(40);
const nextOid = 'b'.repeat(40);

function fixture() {
  const inventory: WorktreeReviewInventory = {
    commonDir: '/repo/.git', repositoryId: 'same-common-dir', entries: [
      { id: 'primary', path: '/repo', head: oid, branch: 'main', isCurrent: true },
      { id: 'linked', path: '/other/task', head: oid, branch: 'task', isCurrent: false }
    ]
  };
  git.inventory.mockReset().mockImplementation(async () => structuredClone(inventory));
  git.data.mockReset().mockImplementation(async (_root, _scope, entry) => ({ commits: [{ hash: entry.head }], mode: 'recent', hasMore: false }));
  git.details.mockReset().mockImplementation(async hash => ({ hash, files: [{ path: 'src/test.js', status: 'M' }], parents: [] }));
  const saved = new Map();
  const storage: Memento = { keys: () => [...saved.keys()], get: (key: string, fallback?: unknown) => saved.get(key) ?? fallback, update: async (key: string, data: unknown) => { saved.set(key, data); } };
  const post = vi.fn(async (_surface: unknown, _message: Record<string, unknown>) => true);
  const focus = vi.fn(async () => {});
  const diff = vi.fn(async () => {});
  const controller = new WorktreeReviewController(storage, () => root, () => false, post, focus, diff);
  const result = (type: string) => post.mock.calls.filter(([, message]) => message.type === type).at(-1)?.[1];
  async function list() {
    await controller.handle('history', { root, type: 'worktreeReviewList', requestId: 1 });
    return result('worktreeReviewListResult')?.entries as Array<{ id: string; version: number; pending: boolean }>;
  }
  return { inventory, saved, post, diff, controller, focus, result, list };
}

describe('agentic worktree review host', () => {
  it('publishes pending work without opening History, and keeps the last good state on inspection failure', async () => {
    const f = fixture();
    await f.controller.refresh(root);
    expect(f.result('worktreeReviewStatus')).toMatchObject({ count: 2, pending: 1, stale: false });
    expect(f.focus).not.toHaveBeenCalled();
    git.inventory.mockRejectedValueOnce(new Error('read failed'));
    const entries = await f.list();
    expect(f.result('worktreeReviewStatus')).toMatchObject({ count: 2, pending: 1, stale: true });
    expect(entries.find(entry => entry.id === 'linked')?.pending).toBe(true);
    await f.controller.handle('changes', { root, type: 'worktreeReviewOpen' });
    expect(f.focus).toHaveBeenCalledOnce();
    expect(f.result('worktreeReviewShown')).toMatchObject({ root });
    f.controller.dispose();
  });

  it('requires a pinned commit and exact file, leaving a moved head pending', async () => {
    const f = fixture();
    const { id, version } = (await f.list()).find(entry => entry.id === 'linked')!;
    await f.controller.handle('history', { root, type: 'worktreeReviewDetails', requestId: 2, id, version });
    await f.controller.handle('history', { root, type: 'worktreeReviewCommit', requestId: 3, id, version, hash: nextOid });
    expect(git.details).not.toHaveBeenCalled();
    await f.controller.handle('history', { root, type: 'worktreeReviewCommit', requestId: 4, id, version, hash: oid });
    for (const path of ['unlisted.txt', 'src/test.js']) await f.controller.handle('history', { root, type: 'worktreeReviewDiff', id, version, hash: oid, path });
    expect(f.diff).toHaveBeenCalledExactlyOnceWith(expect.anything(), oid, 'src/test.js', undefined, 'M', expect.objectContaining({ hash: oid }));
    f.inventory.entries[1]!.head = nextOid;
    await f.controller.handle('history', { root, type: 'worktreeReviewMark', requestId: 5, id, version });
    expect(f.result('worktreeReviewMarkResult')).toMatchObject({ error: expect.stringContaining('changed') });
    expect((await f.list()).find(entry => entry.id === id)).toMatchObject({ pending: true });
    f.controller.dispose();
  });

  it('stores the exact reviewed HEAD and still permits inspecting its pinned diff', async () => {
    const f = fixture();
    const { id, version } = (await f.list()).find(entry => entry.id === 'linked')!;
    await f.controller.handle('history', { root, type: 'worktreeReviewDetails', requestId: 2, id, version });
    await f.controller.handle('history', { root, type: 'worktreeReviewMark', requestId: 3, id, version });
    expect(f.result('worktreeReviewMarkResult')).toMatchObject({ ok: true });
    expect(f.result('worktreeReviewStatus')).toMatchObject({ pending: 0 });
    expect(f.saved.get('kivo.worktreeReview.v1:same-common-dir').entries).toContainEqual(expect.objectContaining({ id, previousReviewHead: oid, pending: false }));
    await f.controller.handle('history', { root, type: 'worktreeReviewCommit', requestId: 4, id, version, hash: oid });
    expect(f.result('worktreeReviewCommitResult')).toMatchObject({ hash: oid, payload: expect.anything() });
    f.controller.dispose();
  });
});
