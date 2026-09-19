import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
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
