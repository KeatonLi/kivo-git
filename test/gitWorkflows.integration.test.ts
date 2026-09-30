import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { GitClient } from '../src/git/GitClient';

const execute = promisify(execFile), roots: string[] = [];
async function git(root: string, ...args: string[]) { return (await execute('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_EDITOR: 'true' } })).stdout.trim(); }
async function repository() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kivo-workflows-')); roots.push(root);
  await git(root, 'init', '-b', 'main');
  await git(root, 'config', 'user.name', 'Kivo Test'); await git(root, 'config', 'user.email', 'test@example.test');
  await fs.writeFile(path.join(root, 'alpha.txt'), 'base\n'); await fs.writeFile(path.join(root, 'beta.txt'), 'other\n');
  await git(root, 'add', '.'); await git(root, 'commit', '-m', 'initial');
  return root;
}
async function commit(root: string, text: string) { await fs.writeFile(path.join(root, 'alpha.txt'), `${text}\n`); await git(root, 'add', '.'); await git(root, 'commit', '-m', text); }
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { force: true, recursive: true }))); });

describe('Git workflows in real repositories', () => {
  it('compares exact branch tips, unique commits and renamed/deleted/added files without changing checkout', async () => {
    const root = await repository();
    await git(root, 'switch', '-c', 'feature'); await commit(root, 'feature edit');
    await git(root, 'mv', 'beta.txt', 'renamed beta.txt'); await fs.writeFile(path.join(root, 'new*.txt'), 'new\n');
    await git(root, 'add', '.'); await git(root, 'commit', '-m', 'rename and add');
    await git(root, 'switch', 'main'); await commit(root, 'main edit');
    const client = new GitClient(root), result = await client.workflows.compare('refs/heads/feature');
    expect(result.current.count).toBe(1); expect(result.target.count).toBe(2);
    expect(result.current.commits.map(c => c.subject)).toEqual(['main edit']);
    expect(result.target.commits.map(c => c.subject)).toEqual(['rename and add', 'feature edit']);
    expect(result.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'renamed beta.txt', status: 'R', originalPath: 'beta.txt' }),
      expect.objectContaining({ path: 'new*.txt', status: 'A' })
    ]));
    expect(await client.showFileAtRevision(result.currentOid, 'alpha.txt')).toBe('main edit\n');
    expect(await client.showFileAtRevision(result.targetOid, 'alpha.txt')).toBe('feature edit\n');
    expect(await git(root, 'branch', '--show-current')).toBe('main');
    await expect(client.workflows.compare('--help')).rejects.toThrow('no longer exists');
  });

  it('compares remote refs and detached HEAD, and reports identical branches as empty', async () => {
    const root = await repository(), client = new GitClient(root);
    await git(root, 'update-ref', 'refs/remotes/origin/feature', 'HEAD');
    const same = await client.workflows.compare('refs/remotes/origin/feature');
    expect(same.files).toEqual([]); expect(same.current.count + same.target.count).toBe(0);
    await git(root, 'switch', '--detach');
    expect((await client.workflows.compare('refs/heads/main')).currentName).toBe('Detached HEAD');
  });

  it('saves and restores staged/unstaged edits and untracked files, keeps the saved copy and excludes stash commits from History', async () => {
    const root = await repository(), client = new GitClient(root);
    await fs.writeFile(path.join(root, 'alpha.txt'), 'staged\n'); await git(root, 'add', 'alpha.txt');
    await fs.appendFile(path.join(root, 'alpha.txt'), 'unstaged\n');
    await fs.writeFile(path.join(root, 'new*.txt'), 'saved untracked\n');
    const staged = await git(root, 'show', ':alpha.txt');
    const hash = await client.workflows.saveStash('unfinished changes');
    expect(await git(root, 'status', '--porcelain')).toBe('');
    const details = await client.workflows.stashDetails(hash);
    expect(details.files.map(f => f.path).sort()).toEqual(['alpha.txt', 'new*.txt']);
    const file = details.files.find(f => f.path === 'new*.txt')!;
    expect(await client.showFileAtRevision(file.newRevision, file.path)).toBe('saved untracked\n');
    expect((await client.snapshot()).commits.map(c => c.subject)).toEqual(['initial']);
    await client.workflows.applyStash(hash);
    expect(await git(root, 'show', ':alpha.txt')).toBe(staged);
    expect(await fs.readFile(path.join(root, 'alpha.txt'), 'utf8')).toBe('staged\nunstaged\n');
    expect(await fs.readFile(path.join(root, 'new*.txt'), 'utf8')).toBe('saved untracked\n');
    expect((await client.workflows.stashes())[0]?.hash).toBe(hash);
    await expect(client.workflows.applyStash(hash)).rejects.toThrow('current changes');
  });

  it('prevalidates checkout before saving, keeps ignored files, and switches with saved work', async () => {
    const root = await repository(), client = new GitClient(root);
    await fs.writeFile(path.join(root, '.gitignore'), 'ignored.txt\n'); await git(root, 'add', '.gitignore'); await git(root, 'commit', '-m', 'ignore');
    await git(root, 'branch', 'feature');
    await fs.writeFile(path.join(root, 'ignored.txt'), 'keep ignored'); await fs.writeFile(path.join(root, 'new.txt'), 'unfinished');
    await expect(client.stashAndCheckout('missing', false)).rejects.toThrow('no longer exists');
    expect(await client.workflows.stashes()).toEqual([]);
    await client.stashAndCheckout('feature', false);
    expect(await git(root, 'branch', '--show-current')).toBe('feature');
    expect(await git(root, 'status', '--porcelain')).toBe('');
    expect(await fs.readFile(path.join(root, 'ignored.txt'), 'utf8')).toBe('keep ignored');
    expect((await client.workflows.stashDetails((await client.workflows.stashes())[0]!.hash)).files.map(f => f.path)).toContain('new.txt');
  });

  it('refuses an ambiguous remote checkout before touching local changes', async () => {
    const root = await repository(), client = new GitClient(root);
    await git(root, 'branch', 'feature'); await git(root, 'update-ref', 'refs/remotes/origin/feature', 'HEAD');
    await fs.writeFile(path.join(root, 'new.txt'), 'keep');
    await expect(client.stashAndCheckout('origin/feature', true)).rejects.toThrow('different branch');
    expect(await client.workflows.stashes()).toEqual([]);
    expect(await fs.readFile(path.join(root, 'new.txt'), 'utf8')).toBe('keep');
  });

  it('keeps a saved stash recoverable when a switch fails after saving', async () => {
    const root = await repository(), client = new GitClient(root);
    await git(root, 'branch', 'feature'); await fs.writeFile(path.join(root, 'new.txt'), 'saved');
    await fs.writeFile(path.join(root, '.git/hooks/post-checkout'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    await expect(client.stashAndCheckout('feature', false)).rejects.toThrow('remain saved');
    const saved = (await client.workflows.stashes())[0]!;
    expect((await client.workflows.stashDetails(saved.hash)).files.map(f => f.path)).toContain('new.txt');
  });

  it('uses stash hashes across reflog reordering and keeps conflict recovery available', async () => {
    const root = await repository(), client = new GitClient(root);
    await fs.writeFile(path.join(root, 'alpha.txt'), 'stash edit\n'); const hash = await client.workflows.saveStash('first');
    await fs.writeFile(path.join(root, 'beta.txt'), 'second\n'); const second = await client.workflows.saveStash('second');
    expect((await client.workflows.stashDetails(hash)).subject).toContain('first');
    await commit(root, 'conflicting commit');
    await expect(client.workflows.applyStash(hash)).rejects.toThrow();
    expect((await client.workflows.operationState())?.kind).toBe('conflicts');
    expect((await client.workflows.stashes()).map(s => s.hash)).toEqual([second, hash]);
    await expect(client.checkout('main', false)).rejects.toThrow('conflicts');
  });

  it('drops exactly a selected saved hash after another stash is inserted', async () => {
    const root = await repository(), client = new GitClient(root);
    await fs.writeFile(path.join(root, 'new.txt'), 'first'); const first = await client.workflows.saveStash('first');
    await fs.writeFile(path.join(root, 'new.txt'), 'second'); const second = await client.workflows.saveStash('second');
    await client.workflows.dropStash(first);
    expect((await client.workflows.stashes()).map(s => s.hash)).toEqual([second]);
    await expect(client.workflows.stashDetails(first)).rejects.toThrow('no longer exists');
  });

  it('detects merge conflicts, rejects stale/early continuation and remaining markers, then stages and continues', async () => {
    const root = await repository(), client = new GitClient(root);
    await git(root, 'switch', '-c', 'feature'); await commit(root, 'feature edit');
    await git(root, 'switch', 'main'); await commit(root, 'main edit');
    await expect(git(root, 'merge', 'feature')).rejects.toThrow();
    const state = (await client.workflows.operationState())!;
    expect(state.kind).toBe('merge'); expect(state.files).toEqual(['alpha.txt']);
    expect((await client.snapshot()).operation).toEqual(state);
    await expect(client.workflows.finishOperation('stale', 'continue')).rejects.toThrow('changed');
    await expect(client.workflows.finishOperation(state.token, 'continue')).rejects.toThrow('Resolve');
    await expect(client.workflows.resolveConflict('alpha.txt')).rejects.toThrow('markers remain');
    await expect(client.workflows.resolveConflict('beta.txt')).rejects.toThrow('no longer conflicted');
    await fs.writeFile(path.join(root, 'alpha.txt'), 'resolved\n'); await client.workflows.resolveConflict('alpha.txt');
    expect((await client.workflows.operationState())?.files).toEqual([]);
    await client.workflows.finishOperation(state.token, 'continue');
    expect(await client.workflows.operationState()).toBeUndefined();
    expect((await git(root, 'rev-list', '--parents', '-n', '1', 'HEAD')).split(' ')).toHaveLength(3);
  });

  it('aborts a merge to its original HEAD and retains unrelated pre-existing edits', async () => {
    const root = await repository(), client = new GitClient(root);
    await git(root, 'switch', '-c', 'feature'); await commit(root, 'feature');
    await git(root, 'switch', 'main'); await commit(root, 'main');
    const before = await git(root, 'rev-parse', 'HEAD');
    await fs.writeFile(path.join(root, 'beta.txt'), 'unrelated work');
    await expect(git(root, 'merge', 'feature')).rejects.toThrow();
    await client.workflows.finishOperation((await client.workflows.operationState())!.token, 'abort');
    expect(await git(root, 'rev-parse', 'HEAD')).toBe(before);
    expect(await fs.readFile(path.join(root, 'beta.txt'), 'utf8')).toBe('unrelated work');
    expect(await client.workflows.operationState()).toBeUndefined();
  });

  it('detects and continues a rebase inside a linked worktree', async () => {
    const root = await repository();
    await git(root, 'switch', '-c', 'feature'); await commit(root, 'feature');
    await git(root, 'switch', 'main'); await commit(root, 'main');
    const linked = path.join(root, 'linked'); await git(root, 'worktree', 'add', linked, 'feature');
    const client = new GitClient(linked);
    await expect(git(linked, 'rebase', 'main')).rejects.toThrow();
    const state = (await client.workflows.operationState())!;
    expect(state.kind).toBe('rebase');
    await fs.writeFile(path.join(linked, 'alpha.txt'), 'resolved\n'); await client.workflows.resolveConflict('alpha.txt');
    await client.workflows.finishOperation(state.token, 'continue');
    expect(await client.workflows.operationState()).toBeUndefined();
  });

  it('detects cherry-pick and revert conflicts started outside Kivo, with guarded abort', async () => {
    const root = await repository(), client = new GitClient(root);
    await git(root, 'switch', '-c', 'feature'); await commit(root, 'feature'); const selected = await git(root, 'rev-parse', 'HEAD');
    await git(root, 'switch', 'main'); await commit(root, 'main');
    await expect(git(root, 'cherry-pick', selected)).rejects.toThrow();
    let state = (await client.workflows.operationState())!; expect(state.kind).toBe('cherry-pick');
    await client.workflows.finishOperation(state.token, 'abort');
    await expect(git(root, 'revert', selected)).rejects.toThrow();
    state = (await client.workflows.operationState())!; expect(state.kind).toBe('revert');
    await client.workflows.finishOperation(state.token, 'abort');
    expect(await client.workflows.operationState()).toBeUndefined();
  });
});
