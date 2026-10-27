import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  commands: { executeCommand: vi.fn().mockResolvedValue(undefined) },
  Uri: { file: (fsPath: string) => ({ fsPath }) }
}));
import * as vscode from 'vscode';
import { IdeaGitViewProvider } from '../src/IdeaGitViewProvider';
import { GitClient } from '../src/git/GitClient';

const exec = promisify(execFile);
const roots: string[] = [];
async function git(root: string, ...args: string[]): Promise<string> {
  return (await exec('git', args, { cwd: root, encoding: 'utf8' })).stdout.trim();
}
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

describe('Git diff content', { timeout: 30_000 }, () => {
  it('reports oversized Git blobs instead of displaying an empty or truncated diff', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kivo-diff-')); roots.push(root);
    await git(root, 'init', '-b', 'main');
    await git(root, 'config', 'user.name', 'Kivo Test');
    await git(root, 'config', 'user.email', 'kivo@example.test');
    await fs.writeFile(path.join(root, 'large.txt'), 'private content\n'.repeat(600_000));
    await fs.writeFile(path.join(root, 'small.txt'), 'small\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-m', 'initial');
    const hash = await git(root, 'rev-parse', 'HEAD');
    const client = new GitClient(root);

    expect(await client.showHeadFile('small.txt')).toBe('small\n');
    expect(await client.showIndexFile('small.txt')).toBe('small\n');
    expect(await client.showFileAtRevision(hash, 'small.txt')).toBe('small\n');
    for (const request of [
      () => client.showHeadFile('large.txt'),
      () => client.showIndexFile('large.txt'),
      () => client.showFileAtRevision(hash, 'large.txt')
    ]) {
      await expect(request()).rejects.toThrow('8 MiB diff limit');
      await expect(request()).rejects.not.toThrow('private content');
    }
    await expect(client.showHeadFile('missing.txt')).rejects.toThrow('Cannot read the Git version');
    await expect(client.showFileAtRevision('bad-revision', 'small.txt')).rejects.toThrow('Invalid commit hash');
  });

  it('uses an explicit empty HEAD for new and staged-then-edited files', async () => {
    const root = '/repo';
    const provider = Object.assign(Object.create(IdeaGitViewProvider.prototype), {
      selectedWorkspace: () => ({ uri: { fsPath: root } }),
      lastSnapshot: { root, changes: [{ path: 'staged.txt', indexStatus: 'A' }] },
      revisionUri: (file: string, query = '') => ({ file, query })
    });
    await provider.openDiff('new.txt', undefined, 'untracked');
    expect(vscode.commands.executeCommand).toHaveBeenLastCalledWith('vscode.diff',
      { file: 'new.txt', query: 'empty=1' }, expect.anything(), expect.any(String), expect.anything());
    await provider.openDiff('staged.txt', undefined, 'modified');
    expect(vscode.commands.executeCommand).toHaveBeenLastCalledWith('vscode.diff',
      { file: 'staged.txt', query: 'empty=1' }, expect.anything(), expect.any(String), expect.anything());
    await provider.openDiff('old.txt', undefined, 'modified');
    expect(vscode.commands.executeCommand).toHaveBeenLastCalledWith('vscode.diff',
      { file: 'old.txt', query: '' }, expect.anything(), expect.any(String), expect.anything());
    // Explorer entry points use a freshly-read snapshot even if no panel is open.
    provider.lastSnapshot = undefined;
    await provider.openDiff('staged.txt', undefined, 'modified', false, 'A');
    expect(vscode.commands.executeCommand).toHaveBeenLastCalledWith('vscode.diff',
      { file: 'staged.txt', query: 'empty=1' }, expect.anything(), expect.any(String), expect.anything());
  });

  it('passes Git read errors to the VS Code document provider and keeps explicit empty sides empty', async () => {
    const root = '/repo';
    const client = { showHeadFile: vi.fn().mockRejectedValue(new Error('8 MiB diff limit')) };
    const provider = Object.assign(Object.create(IdeaGitViewProvider.prototype), {
      discoverRepositories: vi.fn().mockResolvedValue(undefined),
      availableRepositories: () => [{ uri: { fsPath: root } }],
      selectedWorkspace: () => ({ uri: { fsPath: root } }),
      getClient: vi.fn().mockResolvedValue(client)
    });
    await expect(provider.provideTextDocumentContent({ path: '/big.txt', query: 'repo=%2Frepo' }))
      .rejects.toThrow('8 MiB diff limit');
    await expect(provider.provideTextDocumentContent({ path: '/new.txt', query: 'empty=1' })).resolves.toBe('');
    expect(client.showHeadFile).toHaveBeenCalledOnce();
  });
});
