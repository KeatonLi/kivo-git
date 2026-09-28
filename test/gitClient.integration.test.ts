import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitClient, pullArgs } from '../src/git/GitClient';

const execFileAsync = promisify(execFile);
const temporaryRepositories: string[] = [];

async function git(root: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, { cwd: root, encoding: 'utf8' });
  return result.stdout.trim();
}

async function createRepository(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ideagit-test-'));
  temporaryRepositories.push(root);
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'user.name', 'IdeaGit Test']);
  await git(root, ['config', 'user.email', 'ideagit@example.test']);
  await fs.writeFile(path.join(root, 'alpha.txt'), 'alpha\n');
  await fs.writeFile(path.join(root, 'beta.txt'), 'beta\n');
  await git(root, ['add', '.']);
  await git(root, ['commit', '-m', 'initial']);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRepositories.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('GitClient integration', () => {
  it('restores newly staged files after a hook failure without disturbing unrelated staged content', async () => {
    const root = await createRepository();
    await fs.appendFile(path.join(root, 'beta.txt'), 'staged elsewhere\n');
    await git(root, ['add', 'beta.txt']);
    const before = await git(root, ['ls-files', '--stage']);
    await fs.writeFile(path.join(root, 'new.txt'), 'keep this file\n');
    await fs.writeFile(path.join(root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    await expect(new GitClient(root).commit('fails', ['new.txt'])).rejects.toThrow();
    expect(await git(root, ['ls-files', '--stage'])).toBe(before);
    expect(await fs.readFile(path.join(root, 'new.txt'), 'utf8')).toBe('keep this file\n');
  });

  it('commits literal wildcard filenames without including matching unrelated files', async () => {
    const root = await createRepository();
    await fs.writeFile(path.join(root, 'file*.txt'), 'selected\n');
    await fs.writeFile(path.join(root, 'file-other.txt'), 'not selected\n');
    await git(root, ['add', 'file-other.txt']);
    await new GitClient(root).commit('literal path', ['file*.txt']);
    expect(await git(root, ['show', '--format=', '--name-only', 'HEAD'])).toBe('file*.txt');
    expect(await git(root, ['diff', '--cached', '--name-only'])).toBe('file-other.txt');
  });

  it('commits both sides of a selected staged rename and rejects stale selections', async () => {
    const root = await createRepository();
    await git(root, ['mv', 'alpha.txt', 'renamed.txt']);
    const client = new GitClient(root);
    await client.commit('rename', ['renamed.txt']);
    expect(await git(root, ['status', '--porcelain'])).toBe('');
    expect(await git(root, ['ls-tree', '--name-only', 'HEAD'])).not.toContain('alpha.txt');
    await expect(client.commit('stale', ['beta.txt'])).rejects.toThrow('no longer changed');
  });

  it('round-trips repository identity and recent commit messages', async () => {
    const root = await createRepository();
    const client = new GitClient(root);
    await client.setLocalCommitIdentity('New Author', 'new@example.test');
    expect((await client.snapshot()).identity).toMatchObject({ name: 'New Author', email: 'new@example.test', ready: true });
    const recent = await client.recentCommitMessages();
    expect(recent[0]?.subject).toBe('initial');
    expect(recent[0]?.hash).toBe(await git(root, ['rev-parse', 'HEAD']));
  });

  it('maps pull intent to explicit, predictable Git strategies', () => {
    expect(pullArgs('ff-only')).toEqual(['pull', '--ff-only']);
    expect(pullArgs('rebase')).toEqual(['pull', '--rebase']);
    expect(pullArgs('merge')).toEqual(['pull', '--no-rebase']);
  });

  it('reports when the graph history window has more commits to load', async () => {
    const root = await createRepository();
    for (let index = 0; index < 4; index += 1) {
      await fs.appendFile(path.join(root, 'alpha.txt'), `${index}\n`);
      await git(root, ['add', 'alpha.txt']);
      await git(root, ['commit', '-m', `history ${index}`]);
    }
    const client = new GitClient(root);
    await client.initialize();
    const first = await client.snapshot(3);
    expect(first.commits).toHaveLength(3);
    expect(first.commitsHasMore).toBe(true);
    const complete = await client.snapshot(20);
    expect(complete.commitsHasMore).toBe(false);
    expect(complete.commits.length).toBeGreaterThan(first.commits.length);
  });

  it('attributes a line to its commit and identifies worktree-only edits', async () => {
    const root = await createRepository();
    const client = new GitClient(root);
    await client.initialize();

    const committed = await client.blameLine('alpha.txt', 1);
    expect(committed.author).toBe('IdeaGit Test');
    expect(committed.summary).toBe('initial');
    expect(committed.uncommitted).toBe(false);

    await fs.writeFile(path.join(root, 'alpha.txt'), 'edited in working tree\n');
    const edited = await client.blameLine('alpha.txt', 1);
    expect(edited.uncommitted).toBe(true);
    expect(edited.author).toBe('Not Committed Yet');
  });

  it('keeps committed attribution beside staged and unstaged lines', async () => {
    const root = await createRepository();
    const client = new GitClient(root);
    await client.initialize();
    await fs.writeFile(path.join(root, 'alpha.txt'), 'alpha\nstaged line\n');
    await git(root, ['add', 'alpha.txt']);
    await fs.writeFile(path.join(root, 'alpha.txt'), 'alpha\nstaged line\nworking line\n');

    const committed = await client.blameLine('alpha.txt', 1);
    const staged = await client.blameLine('alpha.txt', 2);
    const working = await client.blameLine('alpha.txt', 3);
    expect(committed.summary).toBe('initial');
    expect(committed.uncommitted).toBe(false);
    expect(staged.uncommitted).toBe(true);
    expect(working.uncommitted).toBe(true);
    expect(staged.content).toBe('staged line');
    expect(working.content).toBe('working line');
  });

  it('can cancel a background blame lookup when the cursor moves away', async () => {
    const root = await createRepository();
    const controller = new AbortController();
    controller.abort();
    await expect(new GitClient(root).blameLine('alpha.txt', 1, { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
  });

  it('opens an older branch even when its tip is outside the all-branches history window', async () => {
    const root = await createRepository();
    const initial = await git(root, ['rev-parse', 'HEAD']);
    await git(root, ['branch', 'master']);
    for (let index = 0; index < 8; index += 1) {
      await git(root, ['commit', '--allow-empty', '-m', `later ${index}`]);
    }
    const client = new GitClient(root);
    await client.initialize();
    const recent = await client.snapshot(5);
    expect(recent.commits.some((commit) => commit.hash === initial)).toBe(false);
    const master = await client.snapshot(5, 'master');
    expect(master.commits.map((commit) => commit.hash)).toEqual([initial]);
    expect(master.commitsHasMore).toBe(false);
  });

  it('reports files introduced by a merge commit relative to its first parent', async () => {
    const root = await createRepository();
    await git(root, ['switch', '-c', 'feature/merge-files']);
    await fs.writeFile(path.join(root, 'merged.txt'), 'from feature\n');
    await git(root, ['add', 'merged.txt']);
    await git(root, ['commit', '-m', 'add feature file']);
    await git(root, ['switch', 'main']);
    await git(root, ['commit', '--allow-empty', '-m', 'advance main']);
    await git(root, ['merge', '--no-ff', '--no-edit', 'feature/merge-files']);

    const client = new GitClient(root);
    const details = await client.commitDetails(await git(root, ['rev-parse', 'HEAD']));
    expect(details.parents).toHaveLength(2);
    expect(details.files).toContainEqual({ path: 'merged.txt', status: 'A', originalPath: undefined });
    const rootDetails = await client.commitDetails(await git(root, ['rev-list', '--max-parents=0', 'HEAD']));
    expect(rootDetails.files.map((file) => file.path)).toContain('alpha.txt');
  });

  it('can return identical snapshots when switching between refs at the same tip', async () => {
    const root = await createRepository();
    await git(root, ['branch', 'same-tip']);
    const client = new GitClient(root);
    await client.initialize();
    const allRefs = await client.snapshot();
    const selectedRef = await client.snapshot(80, 'same-tip');
    expect(selectedRef.commits).toEqual(allRefs.commits);
    expect(selectedRef.commitsHasMore).toBe(allRefs.commitsHasMore);
  });

  it('keeps a detached HEAD commit visible and handles repositories without commits', async () => {
    const emptyRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ideagit-empty-'));
    temporaryRepositories.push(emptyRoot);
    await git(emptyRoot, ['init', '-b', 'main']);
    const emptyClient = new GitClient(emptyRoot);
    await emptyClient.initialize();
    expect((await emptyClient.snapshot()).commits).toEqual([]);

    const root = await createRepository();
    await git(root, ['checkout', '--detach']);
    await git(root, ['commit', '--allow-empty', '-m', 'detached revision']);
    const client = new GitClient(root);
    await client.initialize();
    expect((await client.snapshot()).commits[0]?.subject).toBe('detached revision');
  });

  it('reuses history on file changes and refreshes it when Git refs move', async () => {
    const root = await createRepository();
    const client = new GitClient(root);
    await client.initialize();
    const run = vi.spyOn(client as never, 'run');
    await client.snapshot();
    const logCalls = () => run.mock.calls.filter(([args]) => (args as string[])[0] === 'log').length;
    expect(logCalls()).toBe(1);
    await fs.appendFile(path.join(root, 'alpha.txt'), 'working tree only\n');
    expect((await client.snapshot()).changes.length).toBeGreaterThan(0);
    expect(logCalls()).toBe(1);
    await git(root, ['add', 'alpha.txt']);
    await git(root, ['commit', '-m', 'move branch tip']);
    expect((await client.snapshot()).commits[0]?.subject).toBe('move branch tip');
    expect(logCalls()).toBe(2);
  });

  it('refreshes upstream ahead and behind counts after fetching remote refs', async () => {
    const root = await createRepository();
    const remote = await fs.mkdtemp(path.join(os.tmpdir(), 'ideagit-remote-'));
    const peer = await fs.mkdtemp(path.join(os.tmpdir(), 'ideagit-peer-'));
    temporaryRepositories.push(remote, peer);
    await git(remote, ['init', '--bare']);
    await git(root, ['remote', 'add', 'origin', remote]);
    await git(root, ['push', '-u', 'origin', 'main']);

    await fs.appendFile(path.join(root, 'alpha.txt'), 'local commit\n');
    await git(root, ['add', 'alpha.txt']);
    await git(root, ['commit', '-m', 'local work']);

    await git(peer, ['clone', '--branch', 'main', remote, '.']);
    await git(peer, ['config', 'user.name', 'IdeaGit Peer']);
    await git(peer, ['config', 'user.email', 'peer@example.test']);
    await fs.writeFile(path.join(peer, 'remote.txt'), 'remote commit\n');
    await git(peer, ['add', 'remote.txt']);
    await git(peer, ['commit', '-m', 'remote work']);
    await git(peer, ['push', 'origin', 'main']);

    const client = new GitClient(root);
    await client.initialize();
    const stale = await client.snapshot();
    expect(stale).toMatchObject({ upstream: 'origin/main', ahead: 1, behind: 0 });

    await client.fetch(true);
    const current = await client.snapshot();
    expect(current).toMatchObject({ upstream: 'origin/main', ahead: 1, behind: 1 });
  });

  it('updates only a selected non-current branch from its remote without touching HEAD or the working tree', async () => {
    const root = await createRepository();
    const remote = await fs.mkdtemp(path.join(os.tmpdir(), 'ideagit-remote-'));
    const peer = await fs.mkdtemp(path.join(os.tmpdir(), 'ideagit-peer-'));
    temporaryRepositories.push(remote, peer);
    await git(remote, ['init', '--bare']);
    await git(root, ['remote', 'add', 'origin', remote]);
    await git(root, ['push', '-u', 'origin', 'main']);
    await git(root, ['switch', '-c', 'feature/selected']);
    await git(root, ['push', '-u', 'origin', 'feature/selected']);
    await git(root, ['switch', 'main']);
    await git(root, ['branch', '--track', 'feature/untouched', 'origin/main']);
    await git(peer, ['clone', '--branch', 'feature/selected', remote, '.']);
    await git(peer, ['config', 'user.name', 'IdeaGit Peer']);
    await git(peer, ['config', 'user.email', 'peer@example.test']);
    await fs.writeFile(path.join(peer, 'remote.txt'), 'upstream commit\n');
    await git(peer, ['add', '.']);
    await git(peer, ['commit', '-m', 'upstream work']);
    await git(peer, ['push', 'origin', 'feature/selected']);
    await fs.writeFile(path.join(root, 'local.txt'), 'uncommitted work\n');
    const head = await git(root, ['rev-parse', 'HEAD']);
    const untouched = await git(root, ['rev-parse', 'feature/untouched']);
    const client = new GitClient(root);
    await client.updateLocalBranch('feature/selected');
    expect(await git(root, ['rev-parse', 'feature/selected'])).toBe(await git(peer, ['rev-parse', 'HEAD']));
    expect(await git(root, ['rev-parse', 'origin/feature/selected'])).toBe(await git(peer, ['rev-parse', 'HEAD']));
    expect(await git(root, ['rev-parse', 'HEAD'])).toBe(head);
    expect(await git(root, ['rev-parse', 'feature/untouched'])).toBe(untouched);
    expect(await fs.readFile(path.join(root, 'local.txt'), 'utf8')).toBe('uncommitted work\n');
    await expect(client.updateLocalBranch('main')).rejects.toThrow('Use Pull');
    await expect(client.updateLocalBranch('missing')).rejects.toThrow('no longer exists');
  });

  it('refuses to overwrite local commits when a selected branch diverges', async () => {
    const root = await createRepository();
    const remote = await fs.mkdtemp(path.join(os.tmpdir(), 'ideagit-remote-'));
    const peer = await fs.mkdtemp(path.join(os.tmpdir(), 'ideagit-peer-'));
    temporaryRepositories.push(remote, peer);
    await git(remote, ['init', '--bare']);
    await git(root, ['remote', 'add', 'origin', remote]);
    await git(root, ['switch', '-c', 'feature/diverged']);
    await git(root, ['push', '-u', 'origin', 'feature/diverged']);
    await git(peer, ['clone', '--branch', 'feature/diverged', remote, '.']);
    await git(peer, ['config', 'user.name', 'IdeaGit Peer']);
    await git(peer, ['config', 'user.email', 'peer@example.test']);
    await fs.writeFile(path.join(peer, 'remote.txt'), 'remote\n');
    await git(peer, ['add', '.']);
    await git(peer, ['commit', '-m', 'remote work']);
    await git(peer, ['push', 'origin', 'feature/diverged']);
    await fs.writeFile(path.join(root, 'local.txt'), 'local\n');
    await git(root, ['add', '.']);
    await git(root, ['commit', '-m', 'local work']);
    await git(root, ['switch', 'main']);
    const before = await git(root, ['rev-parse', 'feature/diverged']);
    const head = await git(root, ['rev-parse', 'HEAD']);
    await expect(new GitClient(root).updateLocalBranch('feature/diverged')).rejects.toThrow('diverge');
    expect(await git(root, ['rev-parse', 'feature/diverged'])).toBe(before);
    expect(await git(root, ['rev-parse', 'HEAD'])).toBe(head);
  });

  it('builds a real multi-parent graph with branch refs and commit details', async () => {
    const root = await createRepository();
    await git(root, ['branch', 'feature/graph']);
    await git(root, ['tag', 'v1.0.0']);
    await fs.appendFile(path.join(root, 'alpha.txt'), 'main line\n');
    await git(root, ['add', 'alpha.txt']);
    await git(root, ['commit', '-m', 'main line']);
    await git(root, ['switch', 'feature/graph']);
    await fs.writeFile(path.join(root, 'feature.txt'), 'feature line\n');
    await git(root, ['add', 'feature.txt']);
    await git(root, ['commit', '-m', 'feature line']);
    await git(root, ['switch', 'main']);
    await git(root, ['merge', '--no-ff', 'feature/graph', '-m', 'Merge feature graph']);

    const client = new GitClient(root);
    await client.initialize();
    const snapshot = await client.snapshot();
    const merge = snapshot.commits.find((commit) => commit.subject === 'Merge feature graph');
    expect(merge).toMatchObject({ parents: expect.arrayContaining([expect.any(String)]) });
    expect(merge?.parents).toHaveLength(2);
    expect(merge?.parentLanes).toHaveLength(2);
    expect(merge?.laneTransitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'parent', from: merge?.lane })
    ]));
    expect(merge?.refs).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'main', kind: 'local', current: true })]));

    const feature = snapshot.commits.find((commit) => commit.subject === 'feature line');
    expect(feature?.refs).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'feature/graph', kind: 'local' })]));
    expect(feature?.paths).toContain('feature.txt');
    expect(snapshot.tags).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'v1.0.0', kind: 'tag' })]));
    const details = await client.commitDetails(feature!.hash);
    expect(details.files).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'feature.txt', status: 'A' })]));
  });

  it('creates and checks out a new branch from the selected branch ref', async () => {
    const root = await createRepository();
    await git(root, ['branch', 'release/base']);
    const selectedBranchHead = await git(root, ['rev-parse', 'release/base']);
    await fs.appendFile(path.join(root, 'alpha.txt'), 'main moved on\n');
    await git(root, ['add', 'alpha.txt']);
    await git(root, ['commit', '-m', 'main moved on']);

    const client = new GitClient(root);
    await client.initialize();
    await client.createBranch('feature/from-release', 'release/base');

    expect(await git(root, ['branch', '--show-current'])).toBe('feature/from-release');
    expect(await git(root, ['rev-parse', 'HEAD'])).toBe(selectedBranchHead);
    expect((await client.snapshot()).branch).toBe('feature/from-release');
  });

  it('creates a tag at an exact commit and safely checks out that revision', async () => {
    const root = await createRepository();
    const initial = await git(root, ['rev-parse', 'HEAD']);
    await fs.appendFile(path.join(root, 'alpha.txt'), 'new head\n');
    await git(root, ['add', 'alpha.txt']);
    await git(root, ['commit', '-m', 'new head']);

    const client = new GitClient(root);
    await client.initialize();
    await client.createTag('release/exact', initial);
    expect(await git(root, ['rev-parse', 'release/exact^{commit}'])).toBe(initial);

    await client.checkoutRevision(initial);
    expect(await git(root, ['rev-parse', 'HEAD'])).toBe(initial);
    expect(await git(root, ['branch', '--show-current'])).toBe('');
  });

  it('merges, renames, and safely deletes local branches', async () => {
    const root = await createRepository();
    await git(root, ['switch', '-c', 'feature/branch-actions']);
    await fs.writeFile(path.join(root, 'branch-action.txt'), 'branch action\n');
    await git(root, ['add', 'branch-action.txt']);
    await git(root, ['commit', '-m', 'feature branch action']);
    await git(root, ['switch', 'main']);

    const client = new GitClient(root);
    await client.initialize();
    await client.mergeBranch('feature/branch-actions');
    expect((await fs.readFile(path.join(root, 'branch-action.txt'), 'utf8')).replace(/\r\n/g, '\n')).toBe('branch action\n');

    await git(root, ['branch', 'cleanup/old-name']);
    await client.renameBranch('cleanup/old-name', 'cleanup/new-name');
    expect((await git(root, ['branch', '--list', 'cleanup/new-name'])).trim()).toContain('cleanup/new-name');
    await client.deleteBranch('cleanup/new-name', false);
    expect(await git(root, ['branch', '--list', 'cleanup/new-name'])).toBe('');

    await git(root, ['switch', '-c', 'protect/unmerged']);
    await fs.writeFile(path.join(root, 'unmerged.txt'), 'keep me\n');
    await git(root, ['add', 'unmerged.txt']);
    await git(root, ['commit', '-m', 'unmerged work']);
    await git(root, ['switch', 'main']);
    await expect(client.deleteBranch('protect/unmerged', false)).rejects.toThrow(/not fully merged/i);
  });

  it('deletes the exact selected remote branch', async () => {
    const root = await createRepository();
    const remote = await fs.mkdtemp(path.join(os.tmpdir(), 'ideagit-delete-remote-'));
    temporaryRepositories.push(remote);
    await git(remote, ['init', '--bare']);
    await git(root, ['remote', 'add', 'origin', remote]);
    await git(root, ['switch', '-c', 'feature/remove-me']);
    await git(root, ['push', '-u', 'origin', 'feature/remove-me']);

    const client = new GitClient(root);
    await client.initialize();
    await client.deleteBranch('origin/feature/remove-me', true);

    expect(await git(remote, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/feature/remove-me'])).toBe('');
  });

  it('groups changes and commits selected files without consuming unrelated staged changes', async () => {
    const root = await createRepository();
    await fs.appendFile(path.join(root, 'alpha.txt'), 'changed\n');
    await fs.appendFile(path.join(root, 'beta.txt'), 'staged elsewhere\n');
    await fs.writeFile(path.join(root, 'new file.txt'), 'new\n');
    await git(root, ['add', 'beta.txt']);

    const client = new GitClient(root);
    await client.initialize();
    await git(root, ['branch', 'feature/local']);
    await client.snapshot();
    await client.createChangelist('Feature work');
    let snapshot = await client.snapshot();
    expect(snapshot.branches.find((branch) => branch.name === 'feature/local')).toMatchObject({ remote: false });
    const featureList = snapshot.changelists.find((list) => list.name === 'Feature work');
    expect(featureList).toBeDefined();
    await client.moveToChangelist(['alpha.txt', 'new file.txt'], featureList!.id);

    snapshot = await client.snapshot();
    expect(snapshot.changelists.find((list) => list.name === 'Feature work')?.changes.map((change) => change.path).sort())
      .toEqual(['alpha.txt', 'new file.txt']);

    await client.commit('feat: selected files', ['alpha.txt', 'new file.txt']);
    expect((await git(root, ['show', '--pretty=', '--name-only', 'HEAD'])).split('\n').sort())
      .toEqual(['alpha.txt', 'new file.txt']);
    expect(await git(root, ['diff', '--cached', '--name-only'])).toBe('beta.txt');
  });

  it('can commit selected work and push that exact commit to the configured upstream', async () => {
    const root = await createRepository();
    const remote = await fs.mkdtemp(path.join(os.tmpdir(), 'ideagit-commit-push-'));
    temporaryRepositories.push(remote);
    await git(remote, ['init', '--bare']);
    await git(root, ['remote', 'add', 'origin', remote]);
    await git(root, ['push', '-u', 'origin', 'main']);

    await fs.appendFile(path.join(root, 'alpha.txt'), 'ready to ship\n');
    const client = new GitClient(root);
    await client.initialize();
    await client.commit('feat: commit and push', ['alpha.txt']);
    const localHead = await git(root, ['rev-parse', 'HEAD']);
    const preview = await client.pushPreview();
    expect(preview).toMatchObject({ branch: 'main', upstream: 'origin/main', upstreamOid: await git(remote, ['rev-parse', 'main']), remote: 'origin', targetBranch: 'main', head: localHead, ahead: 1, behind: 0, fileCount: 1 });
    expect(preview.commits[0]?.subject).toBe('feat: commit and push');
    await client.push(preview);

    expect(await git(remote, ['rev-parse', 'main'])).toBe(localHead);
  });

  it('does not push when the reviewed outgoing commits changed', async () => {
    const root = await createRepository();
    const remote = await fs.mkdtemp(path.join(os.tmpdir(), 'ideagit-reviewed-push-'));
    temporaryRepositories.push(remote);
    await git(remote, ['init', '--bare']);
    await git(root, ['remote', 'add', 'origin', remote]);
    await git(root, ['push', '-u', 'origin', 'main']);
    const originalRemoteHead = await git(remote, ['rev-parse', 'main']);
    await fs.appendFile(path.join(root, 'alpha.txt'), 'first\n');
    await git(root, ['commit', '-am', 'first']);
    const preview = await new GitClient(root).pushPreview();
    await fs.appendFile(path.join(root, 'alpha.txt'), 'second\n');
    await git(root, ['commit', '-am', 'second']);
    await expect(new GitClient(root).push(preview)).rejects.toThrow('changed during push review');
    expect(await git(remote, ['rev-parse', 'main'])).toBe(originalRemoteHead);
  });

  it('explains when a branch has no pushable upstream', async () => {
    const root = await createRepository();
    await expect(new GitClient(root).pushPreview()).rejects.toThrow('no pushable upstream');
  });

  it('tracks an active changelist and supports rename and delete lifecycle', async () => {
    const root = await createRepository();
    const client = new GitClient(root);
    await client.initialize();
    await client.snapshot();

    await client.createChangelist('Focused work');
    await fs.writeFile(path.join(root, 'focused.txt'), 'new work\n');
    let current = await client.snapshot();
    const focused = current.changelists.find((list) => list.name === 'Focused work');
    expect(focused).toMatchObject({ active: true });
    expect(focused?.changes.map((change) => change.path)).toContain('focused.txt');

    await client.renameChangelist(focused!.id, 'Renamed work');
    current = await client.snapshot();
    expect(current.changelists.find((list) => list.id === focused!.id)).toMatchObject({ name: 'Renamed work', active: true });

    await client.deleteChangelist(focused!.id);
    current = await client.snapshot();
    expect(current.changelists).toHaveLength(1);
    const defaultList = current.changelists[0];
    expect(defaultList).toMatchObject({ id: 'default', active: true });
    expect(defaultList!.changes.map((change) => change.path)).toContain('focused.txt');
  });
});
