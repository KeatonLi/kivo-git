import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { GitClient } from '../src/git/GitClient';

const execute = promisify(execFile), roots: string[] = [];
async function git(root: string, ...args: string[]) {
  return (await execute('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_EDITOR: 'true' } })).stdout.trim();
}
async function repository() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kivo-cherry-pick-')); roots.push(root);
  await git(root, 'init', '-b', 'main');
  await git(root, 'config', 'core.autocrlf', 'false');
  await git(root, 'config', 'user.name', 'Kivo Test'); await git(root, 'config', 'user.email', 'test@example.test');
  await fs.writeFile(path.join(root, 'alpha.txt'), 'base\n');
  await git(root, 'add', '.'); await git(root, 'commit', '-m', 'initial');
  return root;
}
async function commit(root: string, file: string, contents: string, subject: string) {
  await fs.writeFile(path.join(root, file), contents); await git(root, 'add', '--', file); await git(root, 'commit', '-m', subject);
  return git(root, 'rev-parse', 'HEAD');
}
async function conflictingBatch(root: string) {
  await git(root, 'switch', '-c', 'source');
  const first = await commit(root, 'first.txt', 'first\n', 'first clean commit');
  const second = await commit(root, 'alpha.txt', 'source\n', 'second conflicts');
  const third = await commit(root, 'third.txt', 'third\n', 'third clean commit');
  await git(root, 'switch', 'main'); await commit(root, 'alpha.txt', 'target\n', 'target edit');
  return { first, second, third, before: await git(root, 'rev-parse', 'HEAD') };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { force: true, recursive: true, maxRetries: 5, retryDelay: 100 }))); });

describe('Cherry-pick selected History commits', { timeout: 15_000 }, () => {
  it('applies only selected commits in ancestry order, excluding an unselected commit between them', async () => {
    const root = await repository(), client = new GitClient(root);
    await git(root, 'switch', '-c', 'source');
    const first = await commit(root, 'first.txt', 'one\n', 'first');
    await commit(root, 'unselected.txt', 'leave out\n', 'unselected');
    const last = await commit(root, 'last.txt', 'three\n', 'last');
    await git(root, 'switch', 'main');
    const preview = await client.workflows.cherryPickPreview([last, first]);
    expect(preview.branch).toBe('main'); expect(preview.commits.map(commit => commit.hash)).toEqual([first, last]);
    expect(await git(root, 'log', '--format=%s')).toBe('initial');
    await client.workflows.cherryPick(preview);
    expect(await git(root, 'log', '--format=%s')).toBe('last\nfirst\ninitial');
    await expect(fs.access(path.join(root, 'unselected.txt'))).rejects.toThrow();
    expect(await git(root, 'status', '--porcelain')).toBe('');
    expect(await client.workflows.operationState()).toBeUndefined();
  });

  it('rejects dirty work, detached HEAD, invalid objects, already-applied commits and overlarge batches before writing', async () => {
    const root = await repository(), client = new GitClient(root), initial = await git(root, 'rev-parse', 'HEAD');
    await git(root, 'switch', '-c', 'source'); const selected = await commit(root, 'new.txt', 'new\n', 'new'); await git(root, 'switch', 'main');
    for (const invalid of [[], ['--help'], ['HEAD'], [await git(root, 'rev-parse', 'HEAD^{tree}')], Array(201).fill(selected)]) await expect(client.workflows.cherryPickPreview(invalid)).rejects.toThrow();
    await expect(client.workflows.cherryPickPreview([initial])).rejects.toThrow('already in');
    await fs.writeFile(path.join(root, 'untracked.txt'), 'keep');
    await expect(client.workflows.cherryPickPreview([selected])).rejects.toThrow('current changes');
    expect(await fs.readFile(path.join(root, 'untracked.txt'), 'utf8')).toBe('keep'); await fs.rm(path.join(root, 'untracked.txt'));
    await git(root, 'switch', '--detach'); await expect(client.workflows.cherryPickPreview([selected])).rejects.toThrow('local branch');
    expect(await git(root, 'rev-parse', 'HEAD')).toBe(initial);
  });

  it('revalidates the reviewed checkout and HEAD before executing a batch', async () => {
    const root = await repository(), client = new GitClient(root);
    await git(root, 'switch', '-c', 'source'); const selected = await commit(root, 'new.txt', 'new\n', 'new'); await git(root, 'switch', 'main');
    const preview = await client.workflows.cherryPickPreview([selected]);
    await git(root, 'switch', '-c', 'other');
    await expect(client.workflows.cherryPick(preview)).rejects.toThrow('changed');
    await git(root, 'switch', 'main'); await commit(root, 'local.txt', 'local\n', 'local change');
    const before = await git(root, 'rev-parse', 'HEAD');
    await expect(client.workflows.cherryPick(preview)).rejects.toThrow('changed');
    expect(await git(root, 'rev-parse', 'HEAD')).toBe(before);
    await expect(fs.access(path.join(root, 'new.txt'))).rejects.toThrow();
  });

  it('rejects every selected merge before applying an earlier ordinary commit', async () => {
    const root = await repository(), client = new GitClient(root), before = await git(root, 'rev-parse', 'HEAD');
    await git(root, 'switch', '-c', 'source'); const selected = await commit(root, 'source.txt', 'source\n', 'source');
    await git(root, 'switch', '-c', 'side', 'main'); await commit(root, 'side.txt', 'side\n', 'side');
    await git(root, 'switch', 'source'); await git(root, 'merge', '--no-ff', 'side', '-m', 'merge side'); const merge = await git(root, 'rev-parse', 'HEAD');
    await git(root, 'switch', 'main');
    await expect(client.workflows.cherryPickPreview([selected, merge])).rejects.toThrow('mainline parent');
    expect(await git(root, 'rev-parse', 'HEAD')).toBe(before);
    await expect(fs.access(path.join(root, 'source.txt'))).rejects.toThrow();
  });

  it('continues through the remaining selected commits after resolving a conflict', async () => {
    const root = await repository(), client = new GitClient(root), batch = await conflictingBatch(root);
    await expect(client.workflows.cherryPick(await client.workflows.cherryPickPreview([batch.third, batch.second, batch.first]))).rejects.toThrow();
    const state = (await client.workflows.operationState())!;
    expect(state.kind).toBe('cherry-pick'); expect(state.files).toEqual(['alpha.txt']);
    await expect(client.workflows.cherryPickPreview([batch.third])).rejects.toThrow('current Git operation');
    await expect(client.workflows.finishOperation(state.token, 'skip')).rejects.toThrow('empty cherry-pick');
    await expect(client.workflows.finishOperation(state.token, 'continue')).rejects.toThrow('Resolve');
    await fs.writeFile(path.join(root, 'alpha.txt'), 'resolved\n'); await client.workflows.resolveConflict('alpha.txt');
    await expect(client.workflows.finishOperation(state.token, 'skip')).rejects.toThrow('empty cherry-pick');
    await client.workflows.finishOperation(state.token, 'continue');
    expect(await fs.readFile(path.join(root, 'third.txt'), 'utf8')).toBe('third\n');
    expect(await client.workflows.operationState()).toBeUndefined();
    expect(await git(root, 'status', '--porcelain')).toBe('');
  });

  it('aborts the whole batch, including successful commits before the conflict', async () => {
    const root = await repository(), client = new GitClient(root), batch = await conflictingBatch(root);
    await expect(client.workflows.cherryPick(await client.workflows.cherryPickPreview([batch.third, batch.second, batch.first]))).rejects.toThrow();
    expect(await fs.readFile(path.join(root, 'first.txt'), 'utf8')).toBe('first\n');
    await client.workflows.finishOperation((await client.workflows.operationState())!.token, 'abort');
    expect(await git(root, 'rev-parse', 'HEAD')).toBe(batch.before);
    expect(await fs.readFile(path.join(root, 'alpha.txt'), 'utf8')).toBe('target\n');
    await expect(fs.access(path.join(root, 'first.txt'))).rejects.toThrow();
    expect(await client.workflows.operationState()).toBeUndefined();
  });

  it('skips an empty selected commit and applies the rest of the same batch', async () => {
    const root = await repository(), client = new GitClient(root);
    await git(root, 'switch', '-c', 'source'); await git(root, 'commit', '--allow-empty', '-m', 'empty'); const empty = await git(root, 'rev-parse', 'HEAD');
    const next = await commit(root, 'next.txt', 'next\n', 'next'); await git(root, 'switch', 'main');
    await expect(client.workflows.cherryPick(await client.workflows.cherryPickPreview([next, empty]))).rejects.toThrow();
    const state = (await client.workflows.operationState())!;
    expect(state.canSkip).toBe(true); expect(state.files).toEqual([]);
    await client.workflows.finishOperation(state.token, 'skip');
    expect(await git(root, 'log', '--format=%s')).toBe('next\ninitial');
    expect(await client.workflows.operationState()).toBeUndefined();
  });
});
