import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitClient } from '../src/git/GitClient';
import { CheckoutError, GitCommandError, parseWorktrees } from '../src/git/checkout';

const execute = promisify(execFile), roots: string[] = [];
async function git(root: string, ...args: string[]) {
  return (await execute('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_EDITOR: 'true' } })).stdout.trim();
}
async function repository() {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'kivo-checkout-')); roots.push(parent);
  const root = path.join(parent, 'main'); await fs.mkdir(root);
  await git(root, 'init', '-b', 'main'); await git(root, 'config', 'core.autocrlf', 'false');
  await git(root, 'config', 'user.name', 'Kivo Test'); await git(root, 'config', 'user.email', 'test@example.test');
  await fs.writeFile(path.join(root, 'file.txt'), 'base\n'); await git(root, 'add', '.'); await git(root, 'commit', '-m', 'initial');
  return { parent, root, client: new GitClient(root) };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))); });

describe('checkout and linked worktree recovery', { timeout: 15000 }, () => {
  it('rejects occupied branches before stashing and preserves both indexes and working files', async () => {
    const { root, parent, client } = await repository(), linked = path.join(parent, '分支 worktree');
    await git(root, 'worktree', 'add', '-b', 'feature', linked);
    await fs.writeFile(path.join(root, 'file.txt'), 'staged\n'); await git(root, 'add', 'file.txt');
    await fs.appendFile(path.join(root, 'file.txt'), 'unstaged\n'); await fs.writeFile(path.join(root, 'new.txt'), 'untracked');
    const index = await git(root, 'show', ':file.txt');
    const error = await client.stashAndCheckout('feature', false).catch(error => error);
    expect(error).toBeInstanceOf(CheckoutError); expect(error.code).toBe('worktree-occupied');
    expect(await fs.realpath(error.worktreePath)).toBe(await fs.realpath(linked));
    expect(await git(root, 'branch', '--show-current')).toBe('main'); expect(await client.workflows.stashes()).toEqual([]);
    expect(await git(root, 'show', ':file.txt')).toBe(index); expect(await fs.readFile(path.join(root, 'file.txt'), 'utf8')).toBe('staged\nunstaged\n');
    expect(await fs.readFile(path.join(root, 'new.txt'), 'utf8')).toBe('untracked');
    expect(await fs.realpath((await client.snapshot(5)).branches.find(branch => branch.name === 'feature')!.worktreePath!)).toBe(await fs.realpath(linked));
    const other = new GitClient(linked);
    expect(await fs.realpath((await other.snapshot(5)).branches.find(branch => branch.name === 'main')!.worktreePath!)).toBe(await fs.realpath(root));
    const reverseError = await other.checkout('main', false).catch(error => error);
    expect(reverseError).toMatchObject({ code: 'worktree-occupied' });
    expect(await fs.realpath(reverseError.worktreePath)).toBe(await fs.realpath(root));
  });

  it('checks the local branch backing a remote checkout before touching changes', async () => {
    const { root, parent, client } = await repository();
    await git(root, 'remote', 'add', 'origin', 'https://example.test/repo');
    await git(root, 'update-ref', 'refs/remotes/origin/feature', 'HEAD');
    await git(root, 'worktree', 'add', '-b', 'feature', path.join(parent, 'linked'));
    await git(root, 'branch', '--set-upstream-to=origin/feature', 'feature');
    await fs.writeFile(path.join(root, 'new.txt'), 'keep');
    await expect(client.stashAndCheckout('origin/feature', true)).rejects.toMatchObject({ code: 'worktree-occupied' });
    expect(await client.workflows.stashes()).toEqual([]); expect(await fs.readFile(path.join(root, 'new.txt'), 'utf8')).toBe('keep');
  });

  it('retains an exact stash identity when another process occupies the branch after preflight', async () => {
    const { root, parent, client } = await repository(); await git(root, 'branch', 'feature');
    await fs.writeFile(path.join(root, 'new.txt'), 'recover me');
    const save = client.workflows.saveStash.bind(client.workflows);
    vi.spyOn(client.workflows, 'saveStash').mockImplementation(async message => {
      const hash = await save(message); await git(root, 'worktree', 'add', path.join(parent, 'racing worktree'), 'feature'); return hash;
    });
    const error = await client.stashAndCheckout('feature', false).catch(error => error);
    expect(error).toBeInstanceOf(CheckoutError); expect(error.code).toBe('worktree-occupied');
    expect(error.stashHash).toBe((await client.workflows.stashes())[0]?.hash); expect(error.actualBranch).toBe('main');
    expect((await client.workflows.stashDetails(error.stashHash)).files.map(file => file.path)).toContain('new.txt');
    await client.workflows.applyStash(error.stashHash);
    expect(await fs.readFile(path.join(root, 'new.txt'), 'utf8')).toBe('recover me');
    expect((await client.workflows.stashes())[0]?.hash).toBe(error.stashHash);
  });

  it.each(['branch', 'create', 'revision'] as const)('reports the real checkout after a failing post-checkout hook: %s', async mode => {
    const { root, client } = await repository(); const oid = await git(root, 'rev-parse', 'HEAD'); await git(root, 'branch', 'feature');
    await fs.writeFile(path.join(root, '.git/hooks/post-checkout'), '#!/bin/sh\necho "post-checkout failed" >&2\nexit 1\n', { mode: 0o755 });
    const run = mode === 'branch' ? client.checkout('feature', false) : mode === 'create' ? client.createBranch('created', 'HEAD') : client.checkoutRevision(oid);
    await expect(run).rejects.toMatchObject({ code: 'checkout-completed-with-error', actualBranch: mode === 'revision' ? 'Detached HEAD' : mode === 'create' ? 'created' : 'feature' });
    expect(await git(root, 'rev-parse', 'HEAD')).toBe(oid);
    expect(await git(root, 'branch', '--show-current')).toBe(mode === 'revision' ? '' : mode === 'create' ? 'created' : 'feature');
  });

  it('protects local files when switching would overwrite them', async () => {
    const { root, client } = await repository(); await git(root, 'switch', '-c', 'feature');
    await fs.writeFile(path.join(root, 'file.txt'), 'feature\n'); await git(root, 'commit', '-am', 'feature'); await git(root, 'switch', 'main');
    await fs.writeFile(path.join(root, 'file.txt'), 'unfinished\n');
    await expect(client.checkout('feature', false)).rejects.toMatchObject({ code: 'changes-blocked', actualBranch: 'main' });
    expect(await fs.readFile(path.join(root, 'file.txt'), 'utf8')).toBe('unfinished\n'); expect(await client.workflows.stashes()).toEqual([]);
  });

  it('rejects existing branch creation without treating the current HEAD as partial success', async () => {
    const { root, client } = await repository();
    await expect(client.createBranch('main', 'HEAD')).rejects.toMatchObject({ code: 'tracking-conflict' });
    expect(await git(root, 'branch', '--show-current')).toBe('main');
  });

  it('switches clean branches and retains command diagnostics for invalid operations', async () => {
    const { root, client } = await repository(); await git(root, 'branch', 'feature'); await client.checkout('feature', false);
    expect(await git(root, 'branch', '--show-current')).toBe('feature');
    const error = await client.createBranch('--bad-name', 'HEAD').catch(error => error);
    expect(error).toBeInstanceOf(GitCommandError); expect(error.exitCode).toBeTypeOf('number'); expect(error.stderr).not.toBe(''); expect(error.root).toBe(root);
  });
});

describe('worktree porcelain parsing', () => {
  it('preserves unusual paths and empty lock reasons along with detached, bare and prunable states', () => {
    expect(parseWorktrees('worktree /repo/中文\nline\0HEAD abc\0branch refs/heads/feature/a\0locked\0\0worktree /repo/gone\0HEAD def\0detached\0prunable gitdir missing\0\0worktree /bare\0bare\0\0')).toEqual([
      { path: '/repo/中文\nline', head: 'abc', branch: 'feature/a', locked: '' },
      { path: '/repo/gone', head: 'def', detached: true, prunable: 'gitdir missing' }, { path: '/bare', bare: true }
    ]);
  });
});
