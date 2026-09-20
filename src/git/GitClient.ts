import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { ChangelistStore } from './ChangelistStore';
import { parsePorcelainV2 } from './statusParser';
import type { BranchSummary, CommitDetails, CommitFile, CommitSummary, GitRef, PullStrategy, RepositorySnapshot } from './types';

const execFileAsync = promisify(execFile);

export function pullArgs(strategy: PullStrategy): string[] {
  if (strategy === 'merge') return ['pull', '--no-rebase'];
  if (strategy === 'rebase') return ['pull', '--rebase'];
  return ['pull', '--ff-only'];
}

export class GitClient {
  private store?: ChangelistStore;

  constructor(readonly workspaceRoot: string) {}

  private async run(
    args: string[],
    maxBuffer = 8 * 1024 * 1024,
    options: { timeout?: number; env?: NodeJS.ProcessEnv } = {}
  ): Promise<string> {
    try {
      const result = await execFileAsync('git', args, {
        cwd: this.workspaceRoot,
        encoding: 'utf8',
        maxBuffer,
        timeout: options.timeout,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...options.env }
      });
      return result.stdout;
    } catch (error) {
      const detail = error as Error & { stderr?: string };
      throw new Error(detail.stderr?.trim() || detail.message);
    }
  }

  async initialize(): Promise<void> {
    await this.run(['rev-parse', '--show-toplevel']);
    const rawGitDir = (await this.run(['rev-parse', '--git-dir'])).trim();
    const gitDirectory = path.isAbsolute(rawGitDir) ? rawGitDir : path.join(this.workspaceRoot, rawGitDir);
    this.store = new ChangelistStore(gitDirectory);
  }

  async snapshot(commitLimit = 80): Promise<RepositorySnapshot> {
    if (!this.store) await this.initialize();
    const [statusOutput, branches, tags, topLevel] = await Promise.all([
      this.run(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']),
      this.getBranches(),
      this.getTags(),
      this.run(['rev-parse', '--show-toplevel'])
    ]);
    const parsed = parsePorcelainV2(statusOutput);
    const root = topLevel.trim();
    const currentBranch = branches.find((branch) => branch.current && !branch.remote)?.name;
    const commitWindow = await this.getCommits(currentBranch, commitLimit);
    return {
      repositoryName: path.basename(root),
      root,
      ...parsed,
      changelists: await this.store!.group(parsed.changes),
      branches,
      tags,
      commits: commitWindow.commits,
      commitsHasMore: commitWindow.hasMore
    };
  }

  private async getBranches(): Promise<BranchSummary[]> {
    const output = await this.run([
      'for-each-ref',
      '--format=%(refname)\t%(refname:short)\t%(HEAD)\t%(upstream:short)\t%(upstream:trackshort)',
      'refs/heads',
      'refs/remotes'
    ]);
    return output.split('\n').filter(Boolean).map((line) => {
      const [refname = '', name = '', head = '', upstream = '', tracking = ''] = line.split('\t');
      return {
        name,
        current: head === '*',
        remote: refname.startsWith('refs/remotes/'),
        upstream: upstream || undefined,
        tracking: tracking || undefined
      };
    }).filter((branch) => !branch.name.endsWith('/HEAD'));
  }

  private async getTags(): Promise<GitRef[]> {
    try {
      const output = await this.run(['for-each-ref', '--format=%(refname:short)', 'refs/tags']);
      return output.split('\n').filter(Boolean).map((name) => ({ name, kind: 'tag' as const }));
    } catch {
      return [];
    }
  }

  private async getCommits(currentBranch?: string, limit = 80): Promise<{ commits: CommitSummary[]; hasMore: boolean }> {
    try {
      const refs = await this.getRefs(currentBranch);
      const safeLimit = Math.max(1, Math.floor(limit));
      const output = await this.run(['log', '--all', '--topo-order', '-n', String(safeLimit + 1), '--date=iso-strict', '--name-only', '-z', '--pretty=format:%H%x1f%h%x1f%P%x1f%an%x1f%aI%x1f%s%x1e']);
      const recordPattern = /([0-9a-f]{40})\x1f([0-9a-f]{7,40})\x1f([^\x1f]*)\x1f([^\x1f]*)\x1f([^\x1f]*)\x1f([^\x1e]*)\x1e/g;
      const matches = [...output.matchAll(recordPattern)];
      const commits = matches.map((match, index) => {
        const hash = match[1] ?? '';
        const shortHash = match[2] ?? '';
        const parentText = match[3] ?? '';
        const author = match[4] ?? '';
        const date = match[5] ?? '';
        const subject = match[6] ?? '';
        const start = (match.index ?? 0) + match[0].length;
        const end = matches[index + 1]?.index ?? output.length;
        const paths = output.slice(start, end)
          .replace(/^\n+/, '')
          .split('\0')
          .map((filePath) => filePath.trim())
          .filter(Boolean);
        return {
          hash,
          shortHash,
          author,
          date,
          subject,
          parents: parentText ? parentText.split(' ').filter(Boolean) : [],
          paths,
          refs: refs.get(hash) ?? [],
          lane: 0,
          incomingLanes: [],
          parentLanes: []
        };
      });
      return { commits: this.layoutCommits(commits.slice(0, safeLimit)), hasMore: commits.length > safeLimit };
    } catch {
      return { commits: [], hasMore: false };
    }
  }

  private async getRefs(currentBranch?: string): Promise<Map<string, GitRef[]>> {
    const refs = new Map<string, GitRef[]>();
    const add = (hash: string, ref: GitRef): void => {
      if (!hash) return;
      const current = refs.get(hash) ?? [];
      if (!current.some((candidate) => candidate.name === ref.name && candidate.kind === ref.kind)) current.push(ref);
      refs.set(hash, current);
    };
    const branches = await this.run(['for-each-ref', '--format=%(objectname)%09%(refname)%09%(refname:short)', 'refs/heads', 'refs/remotes']);
    for (const line of branches.split('\n').filter(Boolean)) {
      const [hash = '', fullName = '', shortName = ''] = line.split('\t');
      if (shortName.endsWith('/HEAD')) continue;
      add(hash, {
        name: shortName,
        kind: fullName.startsWith('refs/remotes/') ? 'remote' : 'local',
        current: fullName === `refs/heads/${currentBranch}`
      });
    }
    try {
      const tags = await this.run(['show-ref', '--dereference', 'refs/tags']);
      for (const line of tags.split('\n').filter(Boolean)) {
        const [hash = '', rawName = ''] = line.split(' ');
        if (!rawName.startsWith('refs/tags/')) continue;
        const shortName = rawName.slice('refs/tags/'.length).replace(/\^\{\}$/, '');
        add(hash, { name: shortName, kind: 'tag' });
      }
    } catch {
      // Repositories without tags should still render their branch graph.
    }
    return refs;
  }

  private layoutCommits(commits: CommitSummary[]): CommitSummary[] {
    const active: string[] = [];
    return commits.map((commit) => {
      const activeBefore = [...active];
      const incomingLanes = activeBefore.map((_hash, index) => index);
      let lane = active.indexOf(commit.hash);
      const hasIncoming = lane >= 0;
      if (lane < 0) {
        lane = 0;
        active.splice(lane, 0, commit.hash);
      }
      active.splice(lane, 1);
      const parentLanes: number[] = [];
      for (const [index, parent] of commit.parents.entries()) {
        let parentLane = active.indexOf(parent);
        if (parentLane < 0) {
          parentLane = Math.min(lane + index, active.length);
          active.splice(parentLane, 0, parent);
        }
        parentLanes.push(parentLane);
      }
      const laneTransitions = [
        ...activeBefore.flatMap((hash, from) => {
          if (hash === commit.hash) return [];
          const to = active.indexOf(hash);
          return to >= 0 ? [{ from, to, kind: 'through' as const }] : [];
        }),
        ...parentLanes.map((to) => ({ from: lane, to, kind: 'parent' as const }))
      ];
      return { ...commit, lane, incomingLanes, parentLanes, hasIncoming, laneTransitions };
    });
  }

  async commitDetails(hash: string): Promise<CommitDetails> {
    if (!/^[0-9a-f]{7,40}$/i.test(hash)) throw new Error('Invalid commit hash.');
    if (!this.store) await this.initialize();
    const [metadata, body, parents, files, branches] = await Promise.all([
      this.run(['show', '-s', '--format=%H%x1f%an%x1f%aI%x1f%s', hash]),
      this.run(['show', '-s', '--format=%B', hash]),
      this.run(['rev-list', '--parents', '-n', '1', hash]),
      this.run(['diff-tree', '--root', '--no-commit-id', '--name-status', '-r', '-M', '-z', hash]),
      this.getBranches()
    ]);
    const [fullHash = hash, author = '', date = '', subject = ''] = metadata.trim().split('\x1f');
    const parentHashes = parents.trim().split(' ').slice(1).filter(Boolean);
    const fileTokens = files.split('\0').filter(Boolean);
    const changedFiles: CommitFile[] = [];
    for (let index = 0; index < fileTokens.length;) {
      const status = fileTokens[index++] ?? '';
      const originalPath = status.startsWith('R') || status.startsWith('C') ? fileTokens[index++] : undefined;
      const filePath = fileTokens[index++];
      if (filePath) changedFiles.push({ path: filePath, status: status.slice(0, 1), originalPath });
    }
    const refMap = await this.getRefs(branches.find((branch) => branch.current && !branch.remote)?.name);
    return {
      hash: fullHash,
      subject,
      body: body.trim(),
      author,
      date,
      parents: parentHashes,
      refs: refMap.get(fullHash) ?? [],
      files: changedFiles
    };
  }

  async createChangelist(name: string): Promise<void> {
    if (!this.store) await this.initialize();
    await this.store!.create(name);
  }

  async renameChangelist(id: string, name: string): Promise<void> {
    if (!this.store) await this.initialize();
    await this.store!.rename(id, name);
  }

  async deleteChangelist(id: string): Promise<void> {
    if (!this.store) await this.initialize();
    await this.store!.delete(id);
  }

  async setActiveChangelist(id: string): Promise<void> {
    if (!this.store) await this.initialize();
    await this.store!.setActive(id);
  }

  async moveToChangelist(paths: string[], listId: string): Promise<void> {
    if (!this.store) await this.initialize();
    await this.store!.move(paths, listId);
  }

  async commit(message: string, paths: string[]): Promise<void> {
    const trimmed = message.trim();
    if (!trimmed) throw new Error('Write a commit message first.');
    if (!paths.length) throw new Error('Select at least one changed file.');
    const untracked = parsePorcelainV2(await this.run(['status', '--porcelain=v2', '-z', '--untracked-files=all']))
      .changes.filter((change) => change.kind === 'untracked' && paths.includes(change.path)).map((change) => change.path);
    if (untracked.length) await this.run(['add', '--', ...untracked]);
    await this.run(['commit', '--only', '-m', trimmed, '--', ...paths]);
  }

  async checkout(branchName: string, remote: boolean): Promise<void> {
    if (!remote) {
      await this.run(['switch', branchName]);
      return;
    }
    const slash = branchName.indexOf('/');
    const localName = slash >= 0 ? branchName.slice(slash + 1) : branchName;
    await this.run(['switch', '--track', '-c', localName, branchName]);
  }

  /**
   * Create a local branch at the selected local or remote ref, then make it
   * current. This is deliberately not a tracking-branch operation: "New
   * Branch from…" should preserve the selected ref as the start point without
   * silently inheriting an upstream.
   */
  async createBranch(branchName: string, startPoint: string): Promise<void> {
    const name = branchName.trim();
    if (!name) throw new Error('Enter a branch name.');
    if (!startPoint) throw new Error('Choose a branch or tag to start from.');
    await this.run(['check-ref-format', '--branch', name]);
    await this.run(['rev-parse', '--verify', '--quiet', `${startPoint}^{commit}`]);
    await this.run(['switch', '-c', name, startPoint]);
  }

  async fetch(background = false): Promise<void> {
    await this.run(['fetch', '--all', '--prune'], 8 * 1024 * 1024, background
      ? { timeout: 30000, env: { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' } }
      : {});
  }
  async pull(strategy: PullStrategy = 'ff-only'): Promise<void> { await this.run(pullArgs(strategy)); }
  async push(): Promise<void> { await this.run(['push']); }

  async showHeadFile(filePath: string): Promise<string> {
    try {
      return await this.run(['show', `HEAD:${filePath}`]);
    } catch {
      return '';
    }
  }

  async showFileAtRevision(revision: string, filePath: string): Promise<string> {
    if (!/^[0-9a-f]{7,40}$/i.test(revision)) return '';
    try {
      return await this.run(['show', `${revision}:${filePath}`]);
    } catch {
      return '';
    }
  }
}
