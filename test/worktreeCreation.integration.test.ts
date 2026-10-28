import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitClient } from '../src/git/GitClient';

const exec = promisify(execFile);
const parents: string[] = [];
async function git(root: string, ...args: string[]) {
  return (await exec('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_EDITOR: 'true' } })).stdout.trim();
}
async function repository() {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'kivo-create-worktree-'));
  parents.push(parent);
  const root = path.join(parent, 'main');
  await fs.mkdir(root);
  await git(root, 'init', '-b', 'main');
  await git(root, 'config', 'core.autocrlf', 'false');
  await git(root, 'config', 'user.name', 'Kivo Test');
  await git(root, 'config', 'user.email', 'test@example.test');
  await fs.writeFile(path.join(root, 'file.txt'), 'base\n');
  await git(root, 'add', 'file.txt');
  await git(root, 'commit', '-m', 'initial');
  await git(root, 'branch', 'feature');
  return { parent, root, client: new GitClient(root) };
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(parents.splice(0).map(root => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
});

describe('safe worktree creation', { timeout: 30000 }, () => {
  it('creates an attached worktree in a Unicode path without changing the current index or files', async () => {
    const { root, parent, client } = await repository();
    const target = path.join(parent, '分支 worktree');
    await fs.writeFile(path.join(root, 'file.txt'), 'staged\n');
    await git(root, 'add', 'file.txt');
    await fs.appendFile(path.join(root, 'file.txt'), 'unstaged\n');
    await fs.writeFile(path.join(root, 'new.txt'), 'untracked');
    const status = await git(root, 'status', '--porcelain=v1');
    const index = await git(root, 'show', ':file.txt');
    const head = await git(root, 'rev-parse', 'feature');
    const plan = await client.prepareWorktree('feature', target);
    expect(plan).toMatchObject({ branch: 'feature', head });
    const created = await client.createWorktree(plan);
    expect(await fs.realpath(created.path)).toBe(await fs.realpath(target));
    expect(created.branch).toBe('feature');
    expect(created.detached).not.toBe(true);
    expect(await git(target, 'branch', '--show-current')).toBe('feature');
    expect(await git(target, 'rev-parse', 'HEAD')).toBe(head);
    expect(await git(root, 'branch', '--show-current')).toBe('main');
    expect(await git(root, 'status', '--porcelain=v1')).toBe(status);
    expect(await git(root, 'show', ':file.txt')).toBe(index);
    expect(await fs.readFile(path.join(root, 'file.txt'), 'utf8')).toBe('staged\nunstaged\n');
    expect(await fs.readFile(path.join(root, 'new.txt'), 'utf8')).toBe('untracked');
  });

  it('refuses branches already in use, missing branches and existing directories without changing data', async () => {
    const { root, parent, client } = await repository();
    const target = path.join(parent, 'target');
    await expect(client.prepareWorktree('main', target)).rejects.toThrow();
    await expect(client.prepareWorktree('missing', target)).rejects.toThrow();
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, 'keep.txt'), 'keep');
    await expect(client.prepareWorktree('feature', target)).rejects.toThrow();
    expect(await fs.readFile(path.join(target, 'keep.txt'), 'utf8')).toBe('keep');
    expect((await client.getWorktrees()).map(tree => tree.branch)).toEqual(['main']);
  });

  it('offers only unoccupied canonical branch names even when a tag makes Git shorten names differently', async () => {
    const { root, parent, client } = await repository();
    await git(root, 'tag', 'feature');
    expect((await client.listAvailableWorktreeBranches()).map(branch => branch.name)).toEqual(['feature']);
    await git(root, 'worktree', 'add', path.join(parent, 'existing'), 'feature');
    expect(await client.listAvailableWorktreeBranches()).toEqual([]);
  });

  it('rechecks a branch changed after preview and preserves the original directory', async () => {
    const { root, parent, client } = await repository();
    const target = path.join(parent, 'target');
    const plan = await client.prepareWorktree('feature', target);
    await fs.writeFile(path.join(root, 'other.txt'), 'new commit');
    await git(root, 'add', 'other.txt');
    await git(root, 'commit', '-m', 'new commit');
    await git(root, 'branch', '-f', 'feature', 'HEAD');
    await expect(client.createWorktree(plan)).rejects.toThrow();
    await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await client.getWorktrees()).map(tree => tree.branch)).toEqual(['main']);
  });

  it('rechecks if another worktree occupies the branch after preview', async () => {
    const { root, parent, client } = await repository();
    const target = path.join(parent, 'target');
    const competing = path.join(parent, 'other');
    const plan = await client.prepareWorktree('feature', target);
    await git(root, 'worktree', 'add', competing, 'feature');
    await expect(client.createWorktree(plan)).rejects.toThrow();
    expect(await git(competing, 'branch', '--show-current')).toBe('feature');
    await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves the competing worktree and current changes when a branch becomes occupied during creation', async () => {
    const { root, parent, client } = await repository();
    const target = path.join(parent, 'target');
    const competing = path.join(parent, 'competing');
    const plan = await client.prepareWorktree('feature', target);
    await fs.writeFile(path.join(root, 'file.txt'), 'unsaved work\n');
    const run = (client as any).run.bind(client);
    let raced = false;
    vi.spyOn(client as any, 'run').mockImplementation(async (args: unknown, ...rest: unknown[]) => {
      if (!raced && Array.isArray(args) && args[0] === 'worktree' && args[1] === 'add') {
        raced = true;
        await git(root, 'worktree', 'add', competing, 'feature');
      }
      return run(args, ...rest);
    });
    await expect(client.createWorktree(plan)).rejects.toThrow();
    expect(raced).toBe(true);
    expect(await git(competing, 'symbolic-ref', 'HEAD')).toBe('refs/heads/feature');
    expect(await fs.readFile(path.join(competing, 'file.txt'), 'utf8')).toBe('base\n');
    expect(await fs.readFile(path.join(root, 'file.txt'), 'utf8')).toBe('unsaved work\n');
    expect((await client.getWorktrees()).find(tree => tree.branch === 'feature')?.path).toBeTruthy();
    await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not overwrite or remove a directory created after preview', async () => {
    const { parent, client } = await repository();
    const target = path.join(parent, 'target');
    const plan = await client.prepareWorktree('feature', target);
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, 'keep.txt'), 'created after preview');
    await expect(client.createWorktree(plan)).rejects.toThrow();
    expect(await fs.readFile(path.join(target, 'keep.txt'), 'utf8')).toBe('created after preview');
    expect((await client.getWorktrees()).map(tree => tree.branch)).toEqual(['main']);
  });

  it('rejects relative paths', async () => {
    const { client } = await repository();
    await expect(client.prepareWorktree('feature', 'relative/worktree')).rejects.toThrow();
  });

  it('refuses a target inside the Git internal directory', async () => {
    const { root, client } = await repository();
    const target = path.join(root, '.git', 'new-worktree');
    await expect(client.prepareWorktree('feature', target)).rejects.toThrow();
    await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('creates an attached branch when a tag has the same short name', async () => {
    const { root, parent, client } = await repository();
    await git(root, 'tag', 'feature');
    await fs.writeFile(path.join(root, 'next.txt'), 'branch revision');
    await git(root, 'add', 'next.txt');
    await git(root, 'commit', '-m', 'branch revision');
    await git(root, 'branch', '-f', 'feature', 'HEAD');
    const plan = await client.prepareWorktree('feature', path.join(parent, 'target'));
    const created = await client.createWorktree(plan);
    expect(created.branch).toBe('feature');
    expect(created.detached).not.toBe(true);
    expect(await git(created.path, 'symbolic-ref', 'HEAD')).toBe('refs/heads/feature');
    expect(await git(created.path, 'rev-parse', 'HEAD')).toBe(await git(root, 'rev-parse', 'refs/heads/feature'));
  });

  it.skipIf(process.platform === 'win32')('does not replace a dangling symlink at the destination', async () => {
    const { parent, client } = await repository();
    const target = path.join(parent, 'target');
    await fs.symlink(path.join(parent, 'missing'), target);
    await expect(client.prepareWorktree('feature', target)).rejects.toThrow();
    expect((await fs.lstat(target)).isSymbolicLink()).toBe(true);
  });

  it('rechecks if the target parent is replaced after review', async () => {
    const { parent, client } = await repository();
    const destinationParent = path.join(parent, 'destination');
    await fs.mkdir(destinationParent);
    const target = path.join(destinationParent, 'worktree');
    const plan = await client.prepareWorktree('feature', target);
    await fs.rename(destinationParent, path.join(parent, 'destination-old'));
    await fs.mkdir(destinationParent);
    await expect(client.createWorktree(plan)).rejects.toThrow();
    await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.skipIf(process.platform === 'win32')('reports a failed checkout hook with the actual registered worktree and never deletes it', async () => {
    const { root, parent, client } = await repository();
    const target = path.join(parent, 'target');
    const plan = await client.prepareWorktree('feature', target);
    await fs.writeFile(path.join(root, '.git', 'hooks', 'post-checkout'), '#!/bin/sh\necho "post-checkout failed" >&2\nexit 1\n', { mode: 0o755 });
    const error = await client.createWorktree(plan).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(error.created).toMatchObject({ branch: 'feature' });
    expect(await fs.realpath(error.created.path)).toBe(await fs.realpath(target));
    expect(await git(target, 'branch', '--show-current')).toBe('feature');
    expect(await fs.readFile(path.join(target, 'file.txt'), 'utf8')).toBe('base\n');
    expect((await client.getWorktrees()).some(tree => tree.branch === 'feature')).toBe(true);
  });
});
