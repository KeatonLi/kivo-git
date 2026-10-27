import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitClient } from '../src/git/GitClient';

const execute = promisify(execFile);
const roots: string[] = [];
const environment = { ...process.env, GIT_DEFAULT_HASH: 'sha1', GIT_EDITOR: 'true' };

async function git(root: string, ...args: string[]): Promise<string> {
  return (await execute('git', args, { cwd: root, encoding: 'utf8', env: environment })).stdout.trim();
}

// Older Git installations cannot create SHA-256 repositories. Skip only that
// unsupported format: SHA-1 and the rest of the integration suite still run.
function supportsSha256(): boolean {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kivo-sha256-probe-'));
  try {
    execFileSync('git', ['init', '--bare', '--object-format=sha256', root], { stdio: 'pipe', env: environment });
    return true;
  } catch (error) {
    const detail = error as { stderr?: Buffer; message?: string };
    const message = `${detail.stderr || ''} ${detail.message || ''}`;
    if (/unknown option.*object-format|unknown hash algorithm|unsupported.*(?:hash|object.format)/i.test(message)) return false;
    throw error;
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function repository(format: 'sha1' | 'sha256'): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kivo-object-format-'));
  roots.push(root);
  await git(root, 'init', '-b', 'main', ...(format === 'sha256' ? ['--object-format=sha256'] : []));
  await git(root, 'config', 'core.autocrlf', 'false');
  await git(root, 'config', 'core.abbrev', '4');
  await git(root, 'config', 'user.name', 'Kivo Test');
  await git(root, 'config', 'user.email', 'test@example.test');
  await fs.writeFile(path.join(root, 'file.txt'), 'initial\n');
  await git(root, 'add', 'file.txt');
  await git(root, 'commit', '-m', 'initial');
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

for (const format of ['sha1', 'sha256'] as const) {
  describe.skipIf(format === 'sha256' && !supportsSha256())(`real Git ${format} object IDs`, { timeout: 30_000 }, () => {
    it('preserves full IDs and short abbreviations across history, details, search, blame and checkout', async () => {
      const root = await repository(format);
      const client = new GitClient(root);
      const initial = await git(root, 'rev-parse', 'HEAD');
      await fs.appendFile(path.join(root, 'file.txt'), 'second\n');
      await git(root, 'add', 'file.txt');
      await git(root, 'commit', '-m', 'second');
      const head = await git(root, 'rev-parse', 'HEAD');
      const short = await git(root, 'rev-parse', '--short=4', 'HEAD');
      expect(head).toHaveLength(format === 'sha256' ? 64 : 40);

      const snapshot = await client.snapshot();
      expect(snapshot.headOid).toBe(head);
      expect(snapshot.commits.map(commit => commit.hash)).toEqual([head, initial]);
      expect(snapshot.recentCommits?.map(commit => commit.hash)).toEqual([head, initial]);
      expect(snapshot.commits[0]!.shortHash).toBe(short);
      expect(snapshot.commits[0]!.parents).toEqual([initial]);
      expect(snapshot.commits[0]!.refs).toContainEqual(expect.objectContaining({ name: 'main', current: true }));
      expect((await client.commitDetails(head)).hash).toBe(head);
      expect((await client.commitDetails(short)).hash).toBe(head);
      expect((await client.searchCommits({ query: head })).commits.map(commit => commit.hash)).toEqual([head]);
      expect((await client.searchCommits({ query: short })).commits.map(commit => commit.hash)).toEqual([head]);
      expect((await client.recentCommitMessages()).map(commit => commit.hash)).toEqual([head, initial]);
      expect((await client.blameLine('file.txt', 2)).hash).toBe(head);
      expect(await client.showFileAtRevision(head, 'file.txt')).toBe('initial\nsecond\n');
      await client.createTag('verified', head);
      expect(await git(root, 'rev-parse', 'refs/tags/verified')).toBe(head);
      await client.checkoutRevision(initial);
      expect(await git(root, 'rev-parse', 'HEAD')).toBe(initial);
      expect(await git(root, 'symbolic-ref', '-q', '--short', 'HEAD').catch(() => '')).toBe('');
    });

    it('saves work before checkout and allows exact stash preview, restore and deletion', async () => {
      const root = await repository(format);
      const client = new GitClient(root);
      await git(root, 'branch', 'feature');
      await fs.writeFile(path.join(root, 'file.txt'), 'staged\n');
      await git(root, 'add', 'file.txt');
      await fs.appendFile(path.join(root, 'file.txt'), 'unstaged\n');
      await fs.writeFile(path.join(root, 'untracked.txt'), 'untracked\n');
      await client.stashAndCheckout('feature', false);
      expect(await git(root, 'branch', '--show-current')).toBe('feature');
      const stash = (await client.workflows.stashes())[0]!;
      expect(stash.hash).toHaveLength(format === 'sha256' ? 64 : 40);
      const details = await client.workflows.stashDetails(stash.hash);
      expect(details.files.map(file => file.path).sort()).toEqual(['file.txt', 'untracked.txt']);
      const untracked = details.files.find(file => file.path === 'untracked.txt')!;
      expect(await client.showFileAtRevision(untracked.newRevision, untracked.path)).toBe('untracked\n');
      await client.workflows.applyStash(stash.hash);
      expect(await git(root, 'show', ':file.txt')).toBe('staged');
      expect(await fs.readFile(path.join(root, 'file.txt'), 'utf8')).toBe('staged\nunstaged\n');
      expect(await fs.readFile(path.join(root, 'untracked.txt'), 'utf8')).toBe('untracked\n');
      await client.workflows.dropStash(stash.hash);
      expect(await client.workflows.stashes()).toEqual([]);
    });

    it('preserves the exact saved stash if another worktree occupies the branch after preflight', async () => {
      const root = await repository(format);
      const linked = await fs.mkdtemp(path.join(os.tmpdir(), 'kivo-object-worktree-'));
      roots.push(linked);
      const client = new GitClient(root);
      await git(root, 'branch', 'feature');
      await fs.writeFile(path.join(root, 'file.txt'), 'recover me\n');
      const save = client.workflows.saveStash.bind(client.workflows);
      let saved = '';
      vi.spyOn(client.workflows, 'saveStash').mockImplementation(async message => {
        saved = await save(message);
        await git(root, 'worktree', 'add', linked, 'feature');
        return saved;
      });
      const failure = await client.stashAndCheckout('feature', false).then(() => undefined, error => error);
      expect(saved).toHaveLength(format === 'sha256' ? 64 : 40);
      expect(failure).toMatchObject({ code: 'worktree-occupied', actualBranch: 'main', stashHash: saved });
      expect((await client.workflows.stashDetails(saved)).files.map(file => file.path)).toContain('file.txt');
      await client.workflows.applyStash(saved);
      expect(await fs.readFile(path.join(root, 'file.txt'), 'utf8')).toBe('recover me\n');
    });

    it('previews and cherry-picks a commit using its complete object ID', async () => {
      const root = await repository(format);
      const client = new GitClient(root);
      await git(root, 'switch', '-c', 'feature');
      await fs.writeFile(path.join(root, 'new.txt'), 'feature\n');
      await git(root, 'add', 'new.txt');
      await git(root, 'commit', '-m', 'feature change');
      const selected = await git(root, 'rev-parse', 'HEAD');
      await git(root, 'switch', 'main');
      const preview = await client.workflows.cherryPickPreview([selected]);
      expect(preview.commits.map(commit => commit.hash)).toEqual([selected]);
      await client.workflows.cherryPick(preview);
      expect(await fs.readFile(path.join(root, 'new.txt'), 'utf8')).toBe('feature\n');
      expect(await git(root, 'log', '-1', '--format=%s')).toBe('feature change');
    });
  });
}
