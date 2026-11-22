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
  return (await exec('git', args, { cwd: root, encoding: 'utf8' })).stdout.trim();
}
async function repository() {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'kivo-remove-worktree-'));
  parents.push(parent);
  const root = path.join(parent, 'main');
  await fs.mkdir(root);
  await git(root, 'init', '-b', 'main');
  await git(root, 'config', 'core.autocrlf', 'false');
  await git(root, 'config', 'user.name', 'Kivo Test');
  await git(root, 'config', 'user.email', 'test@example.test');
  await fs.writeFile(path.join(root, 'base.txt'), 'base\n');
  await fs.writeFile(path.join(root, '.gitignore'), 'ignored/\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '-m', 'initial');
  const target = path.join(parent, 'linked 分支');
  await git(root, 'worktree', 'add', '-b', 'linked', '--', target);
  return { parent, root, target, client: new GitClient(root) };
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(parents.splice(0).map(root => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
});

describe('safe worktree removal', { timeout: 30000 }, () => {
  it('removes only the linked registration and directory, preserving its local branch and the current changes', async () => {
    const { root, target, client } = await repository();
    await git(target, 'commit', '--allow-empty', '-m', 'linked revision');
    await fs.writeFile(path.join(root, 'base.txt'), 'keep\n');
    await git(root, 'add', 'base.txt');
    await fs.appendFile(path.join(root, 'base.txt'), 'keep this too\n');
    const status = await git(root, 'status', '--porcelain');
    const head = await git(target, 'rev-parse', 'HEAD');
    const plan = await client.prepareWorktreeRemoval(target);
    expect(plan.worktree).toMatchObject({ branch: 'linked', head });
    expect(await client.removeWorktree(plan)).toEqual({ removed: true, pathExists: false });
    await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await client.getWorktrees()).map(tree => tree.branch)).toEqual(['main']);
    expect(await git(root, 'rev-parse', 'refs/heads/linked')).toBe(head);
    expect(await git(root, 'status', '--porcelain')).toBe(status);
    expect(await fs.readFile(path.join(root, 'base.txt'), 'utf8')).toBe('keep\nkeep this too\n');
  });

  it('rejects current, primary, nested, locked, and unavailable worktrees without pruning', async () => {
    const { parent, root, target, client } = await repository();
    await expect(client.prepareWorktreeRemoval(root)).rejects.toThrow(/current/);
    await expect(new GitClient(target).prepareWorktreeRemoval(target)).rejects.toThrow(/current/);
    await expect(new GitClient(target).prepareWorktreeRemoval(root)).rejects.toThrow(/primary/);
    const nested = path.join(target, 'nested');
    await git(root, 'worktree', 'add', '-b', 'nested', '--', nested);
    await expect(client.prepareWorktreeRemoval(target)).rejects.toThrow(/another registered worktree/);
    await git(root, 'worktree', 'remove', '--', nested);
    await git(root, 'worktree', 'lock', '--', target);
    await expect(client.prepareWorktreeRemoval(target)).rejects.toThrow(/locked/);
    await git(root, 'worktree', 'unlock', '--', target);
    const moved = path.join(parent, 'moved');
    await fs.rename(target, moved);
    await expect(client.prepareWorktreeRemoval(target)).rejects.toThrow(/unavailable/);
    expect((await client.getWorktrees()).find(tree => tree.branch === 'linked')?.prunable).toBeDefined();
    expect(await fs.readFile(path.join(moved, 'base.txt'), 'utf8')).toBe('base\n');
  });

  it('refuses staged, unstaged, untracked, ignored, and assume-unchanged files', async () => {
    const { target, client } = await repository();
    const tracked = path.join(target, 'base.txt');
    await fs.writeFile(tracked, 'unstaged\n');
    await expect(client.prepareWorktreeRemoval(target)).rejects.toThrow(/staged, unstaged, untracked or ignored/);
    await git(target, 'add', 'base.txt');
    await expect(client.prepareWorktreeRemoval(target)).rejects.toThrow(/staged, unstaged, untracked or ignored/);
    await git(target, 'restore', '--source=HEAD', '--staged', '--worktree', '--', 'base.txt');
    const untracked = path.join(target, 'untracked.txt');
    await fs.writeFile(untracked, 'untracked');
    await expect(client.prepareWorktreeRemoval(target)).rejects.toThrow(/staged, unstaged, untracked or ignored/);
    await fs.unlink(untracked);
    const ignored = path.join(target, 'ignored', 'keep.txt');
    await fs.mkdir(path.dirname(ignored));
    await fs.writeFile(ignored, 'ignored');
    await expect(client.prepareWorktreeRemoval(target)).rejects.toThrow(/staged, unstaged, untracked or ignored/);
    expect(await fs.readFile(ignored, 'utf8')).toBe('ignored');
    await fs.unlink(ignored);
    await git(target, 'update-index', '--assume-unchanged', 'base.txt');
    await fs.writeFile(tracked, 'hidden changes\n');
    await expect(client.prepareWorktreeRemoval(target)).rejects.toThrow(/index entries/);
    expect(await fs.readFile(tracked, 'utf8')).toBe('hidden changes\n');
  });

  it('revalidates ignored files, HEAD, lock state and replaced directory after review', async () => {
    const { parent, root, target, client } = await repository();
    const plan = await client.prepareWorktreeRemoval(target);
    const ignored = path.join(target, 'ignored', 'keep.txt');
    await fs.mkdir(path.dirname(ignored));
    await fs.writeFile(ignored, 'created after review');
    await expect(client.removeWorktree(plan)).rejects.toThrow(/ignored/);
    expect(await fs.readFile(ignored, 'utf8')).toBe('created after review');
    await fs.unlink(ignored);
    await git(root, 'worktree', 'lock', '--', target);
    await expect(client.removeWorktree(plan)).rejects.toThrow(/locked/);
    await git(root, 'worktree', 'unlock', '--', target);
    await git(target, 'commit', '--allow-empty', '-m', 'changed HEAD');
    await expect(client.removeWorktree(plan)).rejects.toThrow(/changed/);
    const nextPlan = await client.prepareWorktreeRemoval(target);
    const moved = path.join(parent, 'moved');
    await fs.rename(target, moved);
    await fs.mkdir(target);
    await fs.copyFile(path.join(moved, '.git'), path.join(target, '.git'));
    await fs.copyFile(path.join(moved, 'base.txt'), path.join(target, 'base.txt'));
    await fs.copyFile(path.join(moved, '.gitignore'), path.join(target, '.gitignore'));
    await expect(client.removeWorktree(nextPlan)).rejects.toThrow(/changed/);
    expect(await fs.readFile(path.join(target, 'base.txt'), 'utf8')).toBe('base\n');
  });

  it('rejects a copied Git pointer to another linked worktree at the same commit', async () => {
    const { parent, root, target, client } = await repository();
    const plan = await client.prepareWorktreeRemoval(target);
    const sibling = path.join(parent, 'sibling');
    await git(root, 'worktree', 'add', '-b', 'sibling', '--', sibling);
    await fs.copyFile(path.join(sibling, '.git'), path.join(target, '.git'));
    await expect(client.removeWorktree(plan)).rejects.toThrow(/registration does not match/);
    expect(await fs.readFile(path.join(target, 'base.txt'), 'utf8')).toBe('base\n');
    expect((await client.getWorktrees()).map(tree => tree.branch)).toEqual(expect.arrayContaining(['main', 'linked', 'sibling']));
  });

  it('refuses a detached-only commit, but allows removal once a branch reaches it', async () => {
    const { root, target, client } = await repository();
    await git(target, 'switch', '--detach');
    await git(target, 'commit', '--allow-empty', '-m', 'detached revision');
    const head = await git(target, 'rev-parse', 'HEAD');
    await expect(client.prepareWorktreeRemoval(target)).rejects.toThrow(/Create a branch/);
    await git(target, 'branch', 'keep-detached');
    const plan = await client.prepareWorktreeRemoval(target);
    expect(plan.worktree.detached).toBe(true);
    expect((await client.removeWorktree(plan)).removed).toBe(true);
    expect(await git(root, 'rev-parse', 'refs/heads/keep-detached')).toBe(head);
  });

  it('reports actual state when Git refuses a racing untracked file without forcing deletion', async () => {
    const { root, target, client } = await repository();
    const plan = await client.prepareWorktreeRemoval(target);
    const original = (client as any).run.bind(client);
    vi.spyOn(client as any, 'run').mockImplementation(async (args: unknown, ...rest: unknown[]) => {
      if (Array.isArray(args) && args[0] === 'worktree' && args[1] === 'remove') {
        expect(args).toEqual(['worktree', 'remove', '--', plan.worktree.path]);
        await fs.writeFile(path.join(target, 'racing.txt'), 'keep');
      }
      return original(args, ...rest);
    });
    await expect(client.removeWorktree(plan)).rejects.toMatchObject({ actual: { removed: false, worktree: { branch: 'linked' }, pathExists: true } });
    expect(await fs.readFile(path.join(target, 'racing.txt'), 'utf8')).toBe('keep');
    expect(await git(root, 'rev-parse', 'refs/heads/linked')).toBe(plan.worktree.head);
  });

  it('reports the path is actually gone if a failure is surfaced after Git removal', async () => {
    const { root, target, client } = await repository();
    const plan = await client.prepareWorktreeRemoval(target);
    const original = (client as any).run.bind(client);
    vi.spyOn(client as any, 'run').mockImplementation(async (args: unknown, ...rest: unknown[]) => {
      const output = await original(args, ...rest);
      if (Array.isArray(args) && args[0] === 'worktree' && args[1] === 'remove') throw new Error('late error');
      return output;
    });
    await expect(client.removeWorktree(plan)).rejects.toMatchObject({ details: 'late error', actual: { removed: true, pathExists: false } });
    expect(await git(root, 'rev-parse', 'refs/heads/linked')).toBe(plan.worktree.head);
  });
});
