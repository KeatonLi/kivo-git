import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compareWorktreeReviewTarget, readWorktreeReviewData, readWorktreeReviewDelivery, readWorktreeReviewInventory,
  readWorktreeReviewPage, readWorktreeReviewTargets } from '../src/git/WorktreeReviewGit';

const exec = promisify(execFile);
const parents: string[] = [];

async function git(root: string, ...args: string[]): Promise<string> {
  return (await exec('git', args, { cwd: root, encoding: 'utf8' })).stdout.trim();
}

async function repository(objectFormat?: string) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'kivo-review-worktree-'));
  parents.push(parent);
  const root = path.join(parent, 'primary');
  const target = path.join(parent, 'linked 分支');
  await fs.mkdir(root);
  await git(root, 'init', '-b', 'main', ...(objectFormat ? [`--object-format=${objectFormat}`] : []));
  await git(root, 'config', 'core.autocrlf', 'false');
  await git(root, 'config', 'user.name', 'Kivo Review');
  await git(root, 'config', 'user.email', 'review@example.test');
  await fs.writeFile(path.join(root, 'tracked.txt'), 'base\n');
  await git(root, 'add', '--', 'tracked.txt');
  await git(root, 'commit', '-m', 'initial');
  await git(root, 'worktree', 'add', '-b', 'linked', '--', target);
  return { parent, root, target, base: await git(root, 'rev-parse', 'HEAD') };
}

afterEach(async () => {
  await Promise.all(parents.splice(0).map(parent => fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
});

describe('read-only Worktree Review Git data', { timeout: 45_000 }, () => {
  it('shares a canonical repository and stable registration IDs across worktrees, branch/HEAD changes, and registered moves', async () => {
    const { parent, root, target, base } = await repository();
    const fromPrimary = await readWorktreeReviewInventory(root);
    const fromLinked = await readWorktreeReviewInventory(target);
    const main = fromPrimary.entries.find(entry => entry.branch === 'main')!;
    const linked = fromPrimary.entries.find(entry => entry.branch === 'linked')!;
    expect(fromLinked.commonDir).toBe(fromPrimary.commonDir);
    expect(fromLinked.repositoryId).toBe(fromPrimary.repositoryId);
    expect(main).toMatchObject({ head: base, isCurrent: true });
    expect(linked).toMatchObject({ head: base, isCurrent: false });
    expect(fromLinked.entries.find(entry => entry.id === main.id)?.isCurrent).toBe(false);
    expect(fromLinked.entries.find(entry => entry.id === linked.id)?.isCurrent).toBe(true);
    const folder = path.join(target, 'nested');
    await fs.mkdir(folder);
    expect((await readWorktreeReviewInventory(folder)).entries.find(entry => entry.id === linked.id)?.isCurrent).toBe(true);
    await git(target, 'switch', '--detach');
    await git(target, 'commit', '--allow-empty', '-m', 'detached');
    const moved = path.join(parent, 'moved linked');
    await git(root, 'worktree', 'move', '--', target, moved);
    const movedEntry = (await readWorktreeReviewInventory(root)).entries.find(entry => entry.id === linked.id)!;
    expect(movedEntry).toMatchObject({ detached: true, head: await git(moved, 'rev-parse', 'HEAD') });
    expect(path.basename(movedEntry.path)).toBe(path.basename(moved));
    await git(root, 'worktree', 'lock', '--', moved);
    expect((await readWorktreeReviewInventory(root)).entries.find(entry => entry.id === linked.id)?.locked).toBe('');
  });

  it('compares pinned OIDs with bounded windows and distinguishes invisible history from rewritten history', async () => {
    const { root, target, base } = await repository();
    await git(target, 'commit', '--allow-empty', '-m', 'addition');
    const addition = await git(target, 'rev-parse', 'HEAD');
    await git(target, 'commit', '--allow-empty', '-m', 'sibling 变更');
    const inv = await readWorktreeReviewInventory(root);
    const entry = inv.entries.find(item => item.branch === 'linked')!;
    await git(target, 'commit', '--allow-empty', '-m', 'moved after inventory');
    const stale = await readWorktreeReviewData(root, inv, entry, base, 1);
    expect(stale).toMatchObject({ mode: 'since', hasMore: true, commits: [{ hash: entry.head, subject: 'sibling 变更', author: 'Kivo Review' }], statusError: expect.stringContaining('HEAD changed') });
    expect(stale.changes).toBeUndefined();
    const recent = await readWorktreeReviewData(root, inv, entry, undefined, 3);
    expect(recent.mode).toBe('recent');
    expect(recent.range).toEqual({ tip: entry.head });
    expect(recent.commits.map(commit => commit.hash)).toEqual([entry.head, addition, base]);
    expect(recent.hasMore).toBe(false);
    const same = await readWorktreeReviewData(root, inv, entry, entry.head);
    expect(same).toMatchObject({ mode: 'since', commits: [], hasMore: false });
    expect(same.range).toBeUndefined();
    const unavailable = await readWorktreeReviewData(root, inv, entry, 'f'.repeat(40), 1);
    expect(unavailable).toMatchObject({ mode: 'baseline-unavailable', commits: [{ hash: entry.head }] });
    expect(unavailable.range).toEqual({ tip: entry.head });
    await git(root, 'commit', '--allow-empty', '-m', 'parallel main');
    const main = await git(root, 'rev-parse', 'HEAD');
    const rewritten = await readWorktreeReviewData(root, inv, entry, main, 1);
    expect(rewritten).toMatchObject({ mode: 'rewritten', commits: [{ hash: entry.head }] });
    expect(rewritten.range).toEqual({ tip: entry.head });
    const tip = await compareWorktreeReviewTarget(root, inv, entry, main, 1);
    expect(tip).toMatchObject({ ahead: { commits: [{ hash: entry.head }], hasMore: true }, behind: { commits: [{ hash: main }], hasMore: false } });
    await expect(compareWorktreeReviewTarget(root, inv, entry, '--all')).rejects.toThrow('target is no longer available');
  });

  it('pages the original commit range after the branch moves and the linked registration is removed', async () => {
    const { root, target, base } = await repository();
    const count = 111;
    const history = Array.from({ length: count }, (_, index) => {
      const subject = `paged commit ${index + 1}`;
      return `commit refs/heads/linked\ncommitter Kivo Review <review@example.test> 1700000000 +0000\ndata ${subject.length}\n${subject}\n${index === 0 ? `from ${base}\n` : ''}\n`;
    }).join('');
    await new Promise<void>((resolve, reject) => {
      const child = execFile('git', ['fast-import', '--quiet'], { cwd: root }, error => error ? reject(error) : resolve());
      child.stdin!.end(history);
    });
    const inventory = await readWorktreeReviewInventory(root);
    const entry = inventory.entries.find(item => item.branch === 'linked')!;
    const initial = await readWorktreeReviewData(root, inventory, entry, base);
    const range = initial.range!;
    expect(range).toEqual({ tip: entry.head, exclude: base });
    expect(Object.isFrozen(range)).toBe(true);
    expect(initial.hasMore).toBe(true);
    const expected = (await git(root, 'rev-list', '--topo-order', entry.head!, `^${base}`)).split(/\r?\n/);
    expect(initial.commits.map(commit => commit.hash)).toEqual(expected.slice(0, 20));

    await git(root, 'update-ref', 'refs/heads/linked', base, entry.head!);
    await git(root, 'worktree', 'remove', '--', target);
    const second = await readWorktreeReviewPage(root, inventory, range, initial.commits.length);
    expect(second.hasMore).toBe(true);
    expect(second.commits.map(commit => commit.hash)).toEqual(expected.slice(20, 40));
    const bounded = await readWorktreeReviewPage(root, inventory, range, 0, Number.MAX_SAFE_INTEGER);
    expect(bounded.hasMore).toBe(true);
    expect(bounded.commits.map(commit => commit.hash)).toEqual(expected.slice(0, 100));
    const final = await readWorktreeReviewPage(root, inventory, range, 100);
    expect(final.hasMore).toBe(false);
    expect(final.commits.map(commit => commit.hash)).toEqual(expected.slice(100));
    expect(await readWorktreeReviewPage(root, inventory, range, count)).toEqual({ commits: [], hasMore: false });
    await expect(readWorktreeReviewPage(root, inventory, range, -1)).rejects.toThrow('Invalid Worktree Review page offset');
    await expect(readWorktreeReviewPage(root, inventory, { ...range, exclude: '--all' }, 0)).rejects.toThrow('Invalid Worktree Review history range');
    const other = await repository();
    await expect(readWorktreeReviewPage(other.root, inventory, range, 20)).rejects.toThrow('repository changed');
  });

  it('lists exact branch targets and diffs the unique merge base to captured HEAD, not either live ref or working tree', async () => {
    const { root, target } = await repository();
    const oldPath = 'rename source.txt';
    const newPath = 'renamed 分支.txt';
    const added = ' added.txt';
    const deleted = 'remove.txt';
    await fs.writeFile(path.join(root, oldPath), 'only the renamed file\n');
    await fs.writeFile(path.join(root, deleted), 'only the deleted file\n');
    await git(root, 'add', '--', oldPath, deleted);
    await git(root, 'commit', '-m', 'shared fixtures');
    const base = await git(root, 'rev-parse', 'HEAD');
    await git(target, 'merge', '--ff-only', base);

    await fs.writeFile(path.join(root, 'target-only.txt'), 'do not report this file\n');
    await fs.writeFile(path.join(root, 'tracked.txt'), 'changed only on the target\n');
    await git(root, 'add', '--', 'target-only.txt', 'tracked.txt');
    await git(root, 'commit', '-m', 'target diverges');
    const targetOid = await git(root, 'rev-parse', 'HEAD');
    const remoteRef = 'refs/remotes/origin/main';
    await git(root, 'update-ref', remoteRef, targetOid);
    await git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', remoteRef);
    await git(root, 'branch', 'origin/main', base);
    await git(root, 'tag', 'not-a-branch', base);
    await git(root, 'config', 'diff.renames', 'false');

    await git(target, 'mv', '--', oldPath, newPath);
    await git(target, 'rm', '--', deleted);
    await fs.writeFile(path.join(target, added), 'only the added file\n');
    await git(target, 'add', '--', added);
    await git(target, 'commit', '-m', 'reviewed changes');
    const inventory = await readWorktreeReviewInventory(root);
    const entry = inventory.entries.find(item => item.branch === 'linked')!;
    const targets = await readWorktreeReviewTargets(target, inventory);
    expect(targets).toEqual([
      { ref: 'refs/heads/linked', label: 'linked', oid: entry.head },
      { ref: 'refs/heads/main', label: 'main', oid: targetOid },
      { ref: 'refs/heads/origin/main', label: 'refs/heads/origin/main', oid: base },
      { ref: remoteRef, label: remoteRef, oid: targetOid }
    ]);
    const chosen = targets.find(item => item.ref === remoteRef)!;
    await git(root, 'update-ref', remoteRef, entry.head!);
    await fs.writeFile(path.join(target, 'new-head.txt'), 'not in captured HEAD\n');
    await git(target, 'add', '--', 'new-head.txt');
    await git(target, 'commit', '-m', 'ref moved after inventory');
    await fs.writeFile(path.join(target, 'untracked.txt'), 'uncommitted\n');

    const delivery = await readWorktreeReviewDelivery(root, inventory, entry, chosen);
    expect(delivery).toMatchObject({ target: chosen, base, head: entry.head });
    const revisions = { oldRevision: base, newRevision: entry.head };
    expect(delivery.files).toHaveLength(3);
    expect(delivery.files).toEqual(expect.arrayContaining([
      { path: added, status: 'A', ...revisions },
      { path: deleted, status: 'D', ...revisions },
      { path: newPath, originalPath: oldPath, status: 'R', ...revisions }
    ]));
    await expect(readWorktreeReviewDelivery(root, inventory, entry, { ...chosen, oid: 'origin/main' })).rejects.toThrow('target is no longer available');
  });

  it('rejects unrelated and criss-cross merge bases instead of guessing a delivery diff', async () => {
    const { root, base } = await repository();
    const tree = await git(root, 'rev-parse', 'HEAD^{tree}');
    const unrelated = await git(root, 'commit-tree', tree, '-m', 'unrelated history');
    const a = await git(root, 'commit-tree', tree, '-p', base, '-m', 'first parent');
    const b = await git(root, 'commit-tree', tree, '-p', base, '-m', 'second parent');
    const left = await git(root, 'commit-tree', tree, '-p', a, '-p', b, '-m', 'left tip');
    const right = await git(root, 'commit-tree', tree, '-p', b, '-p', a, '-m', 'right tip');
    await git(root, 'update-ref', 'refs/heads/linked', left);
    await git(root, 'branch', 'unrelated', unrelated);
    await git(root, 'branch', 'right', right);
    const inventory = await readWorktreeReviewInventory(root);
    const entry = inventory.entries.find(item => item.branch === 'linked')!;
    const targets = await readWorktreeReviewTargets(root, inventory);
    await expect(readWorktreeReviewDelivery(root, inventory, entry, targets.find(item => item.ref === 'refs/heads/unrelated')!))
      .rejects.toThrow('no common merge base');
    await expect(readWorktreeReviewDelivery(root, inventory, entry, targets.find(item => item.ref === 'refs/heads/right')!))
      .rejects.toThrow('multiple merge bases');
  });

  it('loads staged, unstaged, and untracked changes only in the exact worktree without updating either index, HEAD, or refs', async () => {
    const { root, target, base } = await repository();
    await fs.writeFile(path.join(root, 'primary-only.txt'), 'primary only');
    await fs.writeFile(path.join(target, 'tracked.txt'), 'staged\n');
    await git(target, 'add', '--', 'tracked.txt');
    await fs.appendFile(path.join(target, 'tracked.txt'), 'unstaged\n');
    await fs.writeFile(path.join(target, 'linked-only.txt'), 'linked only');
    const inv = await readWorktreeReviewInventory(root);
    const linked = inv.entries.find(entry => entry.branch === 'linked')!;
    const [mainGit, linkedGit] = await Promise.all([git(root, 'rev-parse', '--absolute-git-dir'), git(target, 'rev-parse', '--absolute-git-dir')]);
    const watched = [path.join(mainGit, 'index'), path.join(mainGit, 'HEAD'), path.join(mainGit, 'refs', 'heads', 'main'),
      path.join(linkedGit, 'index'), path.join(linkedGit, 'HEAD'), path.join(mainGit, 'refs', 'heads', 'linked')];
    const capture = () => Promise.all(watched.map(async file => ({ contents: await fs.readFile(file), modified: (await fs.stat(file)).mtimeMs })));
    const before = await capture();
    vi.stubEnv('GIT_DIR', mainGit);
    vi.stubEnv('GIT_WORK_TREE', root);
    vi.stubEnv('GIT_INDEX_FILE', path.join(mainGit, 'index'));
    vi.stubEnv('GIT_OPTIONAL_LOCKS', '1');
    const data = await readWorktreeReviewData(root, inv, linked, base).finally(() => vi.unstubAllEnvs());
    expect(data.statusError).toBeUndefined();
    expect(data.commits).toEqual([]);
    expect(data.changes).toEqual([
      { path: 'tracked.txt', kind: 'modified', indexStatus: 'M', workingTreeStatus: 'M', staged: true },
      { path: 'linked-only.txt', kind: 'untracked', indexStatus: '?', workingTreeStatus: '?', staged: false }
    ]);
    const primary = await readWorktreeReviewData(target, inv, inv.entries.find(entry => entry.branch === 'main')!, base);
    expect(primary.changes?.map(change => change.path)).toEqual(['primary-only.txt']);
    expect(await capture()).toEqual(before);
  });

  it('refuses nonregistered paths, stale branches, spoofed git pointers, and a different shared repository', async () => {
    const { parent, root, target, base } = await repository();
    const sibling = path.join(parent, 'sibling');
    await git(root, 'worktree', 'add', '-b', 'sibling', '--', sibling);
    const inv = await readWorktreeReviewInventory(root);
    const linked = inv.entries.find(entry => entry.branch === 'linked')!;
    const forgedPath = await readWorktreeReviewData(root, inv, { ...linked, path: sibling }, base);
    expect(forgedPath).toMatchObject({ statusError: expect.any(String) });
    expect(forgedPath.changes).toBeUndefined();
    await git(target, 'switch', '--detach');
    const staleBranch = await readWorktreeReviewData(root, inv, linked, base);
    expect(staleBranch).toMatchObject({ statusError: expect.stringContaining('HEAD changed') });
    await git(target, 'switch', 'linked');
    await fs.copyFile(path.join(sibling, '.git'), path.join(target, '.git'));
    const spoofed = await readWorktreeReviewData(root, inv, linked, base);
    expect(spoofed).toMatchObject({ statusError: expect.any(String) });
    expect(spoofed.changes).toBeUndefined();
    const other = await repository();
    await expect(readWorktreeReviewData(other.root, inv, linked, base)).rejects.toThrow('repository changed');
  });

  it('preserves captured history for prunable and removed registrations without reading replacement worktrees', async () => {
    const { parent, root, target, base } = await repository();
    await git(target, 'commit', '--allow-empty', '-m', 'captured before removal');
    const inv = await readWorktreeReviewInventory(root);
    const linked = inv.entries.find(entry => entry.branch === 'linked')!;
    const missing = path.join(parent, 'temporarily moved outside Git');
    await fs.rename(target, missing);
    const prunable = (await readWorktreeReviewInventory(root)).entries.find(entry => entry.id === linked.id);
    expect(prunable?.prunable).toBeDefined();
    expect(await readWorktreeReviewData(root, inv, linked, base)).toMatchObject({
      mode: 'since', commits: [{ hash: linked.head }], statusError: expect.any(String)
    });
    await fs.rename(missing, target);
    await git(root, 'worktree', 'remove', '--', target);
    expect((await readWorktreeReviewInventory(root)).entries.some(entry => entry.id === linked.id)).toBe(false);
    await git(root, 'worktree', 'add', '--', target, 'linked');
    const replacement = (await readWorktreeReviewInventory(root)).entries.find(entry => entry.branch === 'linked')!;
    expect(replacement.id).not.toBe(linked.id);
    const removed = await readWorktreeReviewData(root, inv, linked, base);
    expect(removed).toMatchObject({ commits: [{ hash: linked.head }], statusError: expect.any(String) });
    expect(removed.changes).toBeUndefined();
  });

  it('returns available working changes even when the current branch has no commits yet', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kivo-review-unborn-'));
    parents.push(root);
    await git(root, 'init', '-b', 'main');
    await fs.writeFile(path.join(root, 'first.txt'), 'untracked');
    const inv = await readWorktreeReviewInventory(root);
    expect(inv.entries).toHaveLength(1);
    const entry = inv.entries[0]!;
    expect(entry).toMatchObject({ branch: 'main', head: undefined, isCurrent: true });
    expect(await readWorktreeReviewData(root, inv, entry)).toMatchObject({
      mode: 'recent', commits: [], hasMore: false, changes: [{ path: 'first.txt' }]
    });
  });

  it('supports SHA-256 histories and detached status', async () => {
    const { root, target, base } = await repository('sha256');
    await git(target, 'switch', '--detach');
    await git(target, 'commit', '--allow-empty', '-m', 'SHA-256 commit');
    const inv = await readWorktreeReviewInventory(root);
    const entry = inv.entries.find(item => item.detached)!;
    expect(entry.head).toHaveLength(64);
    const details = await readWorktreeReviewData(root, inv, entry, base);
    expect(details).toMatchObject({ mode: 'since', range: { tip: entry.head, exclude: base }, commits: [{ hash: entry.head }], changes: [] });
    expect(await readWorktreeReviewPage(root, inv, details.range!, 0)).toEqual({ commits: details.commits, hasMore: false });
    const main = (await readWorktreeReviewTargets(root, inv)).find(item => item.ref === 'refs/heads/main')!;
    expect(await readWorktreeReviewDelivery(root, inv, entry, main)).toEqual({ target: main, head: entry.head, base, files: [] });
  });
});
