import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { ChangelistStore } from './ChangelistStore';
import { parsePorcelainV2 } from './statusParser';
import { GitWorkflows } from './GitWorkflows';
import type { BranchSummary, CommitDetails, CommitFile, CommitSummary, GitRef, LineBlame, PullStrategy, PushPreview, RepositorySnapshot } from './types';

const execFileAsync = promisify(execFile);

export function pullArgs(strategy: PullStrategy): string[] {
  if (strategy === 'merge') return ['pull', '--no-rebase'];
  if (strategy === 'rebase') return ['pull', '--rebase'];
  return ['pull', '--ff-only'];
}

export class GitClient {
  private store?: ChangelistStore;
  private historyCache?: { key: string; commits: CommitSummary[]; hasMore: boolean };
  private recentCache?: { head: string; commits: CommitSummary[] };
  private outgoingCache = new Map<string, Promise<Set<string>>>();

  readonly workflows: GitWorkflows;
  constructor(readonly workspaceRoot: string) {
    this.workflows = new GitWorkflows(workspaceRoot, (args, options) => this.run(args, undefined, options));
  }

  isChangelistStorageFile(filePath: string): boolean {
    return this.store?.isStorageFile(filePath) ?? false;
  }

  private async run(
    args: string[],
    maxBuffer = 8 * 1024 * 1024,
    options: { timeout?: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {}
  ): Promise<string> {
    try {
      const result = await execFileAsync('git', args, {
        cwd: this.workspaceRoot,
        encoding: 'utf8',
        maxBuffer,
        timeout: options.timeout,
        signal: options.signal,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...options.env }
      });
      return result.stdout;
    } catch (error) {
      const detail = error as Error & { stderr?: string };
      if (detail.name === 'AbortError') throw detail;
      throw new Error(detail.stderr?.trim() || detail.message);
    }
  }

  async initialize(): Promise<void> {
    await this.run(['rev-parse', '--show-toplevel']);
    const rawGitDir = (await this.run(['rev-parse', '--git-dir'])).trim();
    const gitDirectory = path.isAbsolute(rawGitDir) ? rawGitDir : path.join(this.workspaceRoot, rawGitDir);
    this.store = new ChangelistStore(gitDirectory);
  }

  async changedFilesCount(): Promise<number> {
    const output = await this.run(['status', '--porcelain=v2', '-z', '--untracked-files=all']);
    return parsePorcelainV2(output).changes.length;
  }

  async snapshot(commitLimit = 80, historyRef?: string): Promise<RepositorySnapshot> {
    if (!this.store) await this.initialize();
    const [statusOutput, branches, tags, topLevel, identity, operation] = await Promise.all([
      this.run(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']),
      this.getBranches(),
      this.getTags(),
      this.run(['rev-parse', '--show-toplevel']),
      this.getCommitIdentity(),
      this.workflows.operationState()
    ]);
    const parsed = parsePorcelainV2(statusOutput);
    const root = topLevel.trim();
    const currentBranch = branches.find((branch) => branch.current && !branch.remote)?.name;
    const selectedBranch = branches.find((branch) => branch.name === historyRef);
    const selectedTag = tags.find((tag) => tag.name === historyRef);
    const exactRef = selectedBranch
      ? `refs/${selectedBranch.remote ? 'remotes' : 'heads'}/${selectedBranch.name}`
      : selectedTag ? `refs/tags/${selectedTag.name}` : undefined;
    const [commitWindow, recentCommits] = await Promise.all([
      this.getCommits(currentBranch, commitLimit, exactRef),
      this.getRecentCommits(parsed.headOid)
    ]);
    const headBranch = branches.find((branch) => branch.current && !branch.remote);
    const historyBranch = historyRef ? selectedBranch?.remote ? undefined : selectedBranch : headBranch;
    const [commitsWithPushState, recentWithPushState] = await Promise.all([
      this.markOutgoingCommits(commitWindow.commits, historyBranch, branches),
      this.markOutgoingCommits(recentCommits, headBranch, branches, parsed.headOid)
    ]);
    return {
      repositoryName: path.basename(root),
      root,
      identity,
      operation,
      ...parsed,
      changelists: await this.store!.group(parsed.changes),
      branches,
      tags,
      commits: commitsWithPushState,
      recentCommits: recentWithPushState,
      commitsHasMore: commitWindow.hasMore
    };
  }

  private async markOutgoingCommits(commits: CommitSummary[], branch: BranchSummary | undefined, branches: BranchSummary[], head = branch?.oid): Promise<CommitSummary[]> {
    const upstream = branches.find((candidate) => candidate.name === branch?.upstream);
    if (!head || !branch?.upstream || !upstream?.oid || head === upstream.oid || !commits.length) return commits;
    const key = `${head}\0${upstream.oid}`;
    let query = this.outgoingCache.get(key);
    if (!query) {
      query = this.run(['rev-list', head, `^${upstream.oid}`]).then((output) => new Set(output.trim().split(/\s+/).filter(Boolean)));
      if (this.outgoingCache.size >= 8) this.outgoingCache.delete(this.outgoingCache.keys().next().value!);
      this.outgoingCache.set(key, query);
    }
    const outgoing = await query.catch((error: unknown) => { this.outgoingCache.delete(key); throw error; });
    // Keep raw history caches unchanged so moving the tracking ref clears old marks.
    return commits.map((commit) => outgoing.has(commit.hash) ? { ...commit, unpushedTo: branch.upstream } : commit);
  }

  private async getRecentCommits(head?: string): Promise<CommitSummary[]> {
    if (!head) return [];
    if (this.recentCache?.head === head) return this.recentCache.commits;
    const output = await this.run(['log', head, '--topo-order', '-n', '5', '--date=iso-strict', '-z', '--pretty=format:%H%x1f%h%x1f%P%x1f%an%x1f%aI%x1f%s%x1e']);
    const commits = this.layoutCommits(this.parseCommitLog(output, new Map()));
    this.recentCache = { head, commits };
    return commits;
  }

  private async getBranches(): Promise<BranchSummary[]> {
    const output = await this.run([
      'for-each-ref',
      '--format=%(refname)\t%(refname:short)\t%(HEAD)\t%(upstream:short)\t%(upstream:trackshort)\t%(objectname)\t%(upstream:track)',
      'refs/heads',
      'refs/remotes'
    ]);
    return output.split('\n').filter(Boolean).map((line) => {
      const [refname = '', name = '', head = '', upstream = '', tracking = '', oid = '', trackCounts = ''] = line.split('\t');
      const ahead = /\bahead (\d+)/.exec(trackCounts);
      const behind = /\bbehind (\d+)/.exec(trackCounts);
      return {
        name,
        oid,
        current: head === '*',
        remote: refname.startsWith('refs/remotes/'),
        upstream: upstream || undefined,
        tracking: tracking || undefined,
        ahead: upstream && trackCounts !== '[gone]' ? Number(ahead?.[1] || 0) : undefined,
        behind: upstream && trackCounts !== '[gone]' ? Number(behind?.[1] || 0) : undefined
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

  private async getCommits(currentBranch?: string, limit = 80, exactRef?: string): Promise<{ commits: CommitSummary[]; hasMore: boolean }> {
    const safeLimit = Math.max(1, Math.floor(limit));
    const [refState, head] = await Promise.all([
      this.run(['for-each-ref', '--format=%(refname)%09%(objectname)%09%(*objectname)']),
      this.run(['rev-parse', '--verify', 'HEAD']).catch(() => '')
    ]);
    const key = `${safeLimit}\0${currentBranch || ''}\0${exactRef || ''}\0${head}\0${refState}`;
    if (this.historyCache?.key === key) return this.historyCache;
    if (!head.trim() && !refState.trim()) {
      const empty = { key, commits: [], hasMore: false };
      this.historyCache = empty;
      return empty;
    }
    const refs = await this.getRefs(currentBranch);
    const output = await this.run(['log', ...(exactRef ? [exactRef] : head.trim() ? ['--exclude=refs/stash', '--all', 'HEAD'] : ['--exclude=refs/stash', '--all']), '--topo-order', '-n', String(safeLimit + 1), '--date=iso-strict', '--name-only', '-z', '--pretty=format:%H%x1f%h%x1f%P%x1f%an%x1f%aI%x1f%s%x1e']);
    const commits = this.parseCommitLog(output, refs);
    const result = { key, commits: this.layoutCommits(commits.slice(0, safeLimit)), hasMore: commits.length > safeLimit };
    this.historyCache = result;
    return result;
  }

  /** Search the complete ref history in Git, then page the matching results. */
  async searchCommits(filters: { query?: string; author?: string; age?: string; path?: string; ref?: string }, limit = 80): Promise<{ commits: CommitSummary[]; hasMore: boolean }> {
    const safeLimit = Math.max(1, Math.floor(limit));
    const branches = await this.getBranches();
    const tags = await this.getTags();
    const selectedBranch = branches.find((branch) => branch.name === filters.ref);
    const selectedTag = tags.find((tag) => tag.name === filters.ref);
    const exactRef = selectedBranch
      ? `refs/${selectedBranch.remote ? 'remotes' : 'heads'}/${selectedBranch.name}`
      : selectedTag ? `refs/tags/${selectedTag.name}` : undefined;
    if (filters.ref && !exactRef) return { commits: [], hasMore: false };
    const query = (filters.query || '').trim();
    const author = (filters.author || '').trim();
    const pathFilter = (filters.path || '').trim();
    const ageDays = ({ '7d': 7, '30d': 30, '90d': 90 } as Record<string, number>)[filters.age || ''] || 0;
    const head = (await this.run(['rev-parse', '--verify', 'HEAD']).catch(() => '')).trim();
    if (!head && !branches.length && !tags.length) return { commits: [], hasMore: false };
    const args = ['log', ...(exactRef ? [exactRef] : head ? ['--exclude=refs/stash', '--all', 'HEAD'] : ['--exclude=refs/stash', '--all']), '--topo-order', '-n', String(safeLimit + 1), '--date=iso-strict', '--name-only', '-z', '--pretty=format:%H%x1f%h%x1f%P%x1f%an%x1f%aI%x1f%s%x1e'];
    if (author) args.push(`--author=${author}`);
    if (ageDays) args.push(`--since=${new Date(Date.now() - ageDays * 86400000).toISOString()}`);
    let hashSearch = false;
    if (/^[0-9a-f]{7,40}$/i.test(query)) {
      const resolved = (await this.run(['rev-parse', '--verify', '--quiet', `${query}^{commit}`]).catch(() => '')).trim();
      if (resolved) {
        if (exactRef && !(await this.run(['merge-base', '--is-ancestor', resolved, exactRef]).then(() => true).catch(() => false))) {
          return { commits: [], hasMore: false };
        }
        args.splice(1, exactRef ? 1 : head ? 3 : 2, resolved);
        args.push('-1');
        hashSearch = true;
      }
    }
    if (query && !hashSearch) args.push('--regexp-ignore-case', '--fixed-strings', `--grep=${query}`);
    if (pathFilter) {
      // In the default pathspec mode, * also matches directory separators.
      const escaped = pathFilter.replace(/[\\*?\[\]]/g, (character) => `\\${character}`);
      args.push('--', `:(icase)*${escaped}*`);
    }
    const output = await this.run(args);
    const refs = await this.getRefs(branches.find((branch) => branch.current && !branch.remote)?.name);
    const matches = this.parseCommitLog(output, refs);
    const displayedBranch = filters.ref ? selectedBranch?.remote ? undefined : selectedBranch : branches.find((branch) => branch.current && !branch.remote);
    return { commits: await this.markOutgoingCommits(this.layoutCommits(matches.slice(0, safeLimit)), displayedBranch, branches), hasMore: matches.length > safeLimit };
  }

  private parseCommitLog(output: string, refs: Map<string, GitRef[]>): CommitSummary[] {
    const recordPattern = /([0-9a-f]{40})\x1f([0-9a-f]{7,40})\x1f([^\x1f]*)\x1f([^\x1f]*)\x1f([^\x1f]*)\x1f([^\x1e]*)\x1e/g;
    const matches = [...output.matchAll(recordPattern)];
    return matches.map((match, index) => {
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
        .replace(/\n+$/, '')
        .split('\0')
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
    const [metadata, body, parents, branches] = await Promise.all([
      this.run(['show', '-s', '--format=%H%x1f%an%x1f%aI%x1f%s', hash]),
      this.run(['show', '-s', '--format=%B', hash]),
      this.run(['rev-list', '--parents', '-n', '1', hash]),
      this.getBranches()
    ]);
    const [fullHash = hash, author = '', date = '', subject = ''] = metadata.trim().split('\x1f');
    const parentHashes = parents.trim().split(' ').slice(1).filter(Boolean);
    const files = await this.run(parentHashes[0]
      ? ['diff', '--name-status', '-r', '-M', '-z', parentHashes[0], fullHash, '--']
      : ['diff-tree', '--root', '--no-commit-id', '--name-status', '-r', '-M', '-z', fullHash]);
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
    if (typeof message !== 'string' || !Array.isArray(paths) || paths.some((file) => typeof file !== 'string' || !file || file.includes('\0'))) {
      throw new Error('Invalid commit selection. Refresh and select the files again.');
    }
    const trimmed = message.trim();
    if (!trimmed) throw new Error('Write a commit message first.');
    if (!paths.length) throw new Error('Select at least one changed file.');
    const changes = parsePorcelainV2(await this.run(['status', '--porcelain=v2', '-z', '--untracked-files=all'])).changes;
    const byPath = new Map(changes.map((change) => [change.path, change]));
    if (changes.some((change) => change.kind === 'conflict')) throw new Error('Resolve merge conflicts before committing.');
    const selected = [...new Set(paths)].map((file) => {
      const change = byPath.get(file);
      if (!change) throw new Error(`The selected file is no longer changed: ${file}. Refresh and try again.`);
      return change;
    });
    const untracked = selected.filter((change) => change.kind === 'untracked').map((change) => change.path);
    const commitPaths = [...new Set(selected.flatMap((change) => change.originalPath && change.indexStatus === 'R'
      ? [change.originalPath, change.path] : [change.path]))];
    let added = false;
    try {
      if (untracked.length) {
        await this.run(['--literal-pathspecs', 'add', '--', ...untracked]);
        added = true;
      }
      await this.run(['--literal-pathspecs', 'commit', '--only', '-m', trimmed, '--', ...commitPaths]);
    } catch (error) {
      // These paths were absent from the index before this operation. Remove only
      // those entries; never reset unrelated staged work or touch working files.
      if (added) {
        try {
          await this.run(['update-index', '--force-remove', '--', ...untracked]);
        } catch (restoreError) {
          throw new Error(`${error instanceof Error ? error.message : String(error)}\nCould not restore newly staged files. Review the index before retrying: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`);
        }
      }
      throw error;
    }
  }

  async restoreFilesToHead(paths: string[]): Promise<void> {
    if (!paths.length || paths.some((file) => typeof file !== 'string' || !file || file.includes('\0'))) {
      throw new Error('Select changed files to roll back.');
    }
    await this.run(['--literal-pathspecs', 'restore', '--source=HEAD', '--staged', '--worktree', '--', ...new Set(paths)]);
  }

  async unstageNewFiles(paths: string[]): Promise<void> {
    if (!paths.length || paths.some((file) => typeof file !== 'string' || !file || file.includes('\0'))) {
      throw new Error('Select new files to roll back.');
    }
    await this.run(['--literal-pathspecs', 'update-index', '--force-remove', '--', ...new Set(paths)]);
  }

  private async checkoutArgs(branchName: string, remote: boolean): Promise<string[]> {
    const branches = await this.getBranches();
    if (!branches.some(branch => branch.name === branchName && branch.remote === remote)) throw new Error('This branch no longer exists. Refresh and try again.');
    if (!remote) {
      return ['switch', branchName];
    }
    const slash = branchName.indexOf('/');
    const localName = slash >= 0 ? branchName.slice(slash + 1) : branchName;
    const local = branches.find(branch => !branch.remote && branch.name === localName);
    if (local && local.upstream !== branchName) throw new Error(`${localName} already exists and tracks a different branch. Choose its local branch explicitly.`);
    return local ? ['switch', localName] : ['switch', '--track', '-c', localName, branchName];
  }

  async checkout(branchName: string, remote: boolean): Promise<void> {
    if (await this.workflows.operationState()) throw new Error('Finish the current Git operation or conflicts before switching branches.');
    await this.run(await this.checkoutArgs(branchName, remote));
  }

  async stashAndCheckout(branchName: string, remote: boolean): Promise<void> {
    const args = await this.checkoutArgs(branchName, remote);
    const saved = await this.workflows.saveStash(`Kivo Git: before switching to ${branchName}`);
    try { await this.run(args); }
    catch (error) { throw new Error(`${error instanceof Error ? error.message : String(error)}\nYour changes remain saved in stash ${saved.slice(0, 8)}. Open Stashes to restore them.`); }
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

  async createTag(tagName: string, revision: string): Promise<void> {
    const name = tagName.trim();
    if (!name) throw new Error('Enter a tag name.');
    if (!/^[0-9a-f]{7,40}$/i.test(revision)) throw new Error('Invalid commit hash.');
    await this.run(['check-ref-format', `refs/tags/${name}`]);
    await this.run(['rev-parse', '--verify', '--quiet', `${revision}^{commit}`]);
    await this.run(['tag', name, revision]);
  }

  async checkoutRevision(revision: string): Promise<void> {
    if (!/^[0-9a-f]{7,40}$/i.test(revision)) throw new Error('Invalid commit hash.');
    await this.run(['rev-parse', '--verify', '--quiet', `${revision}^{commit}`]);
    await this.run(['switch', '--detach', revision]);
  }

  async mergeBranch(branchName: string): Promise<void> {
    const branch = branchName.trim();
    if (!branch) throw new Error('Choose a branch to merge.');
    await this.run(['rev-parse', '--verify', '--quiet', `${branch}^{commit}`]);
    await this.run(['merge', '--no-edit', branch]);
  }

  async renameBranch(currentName: string, nextName: string): Promise<void> {
    const current = currentName.trim();
    const next = nextName.trim();
    if (!current || !next) throw new Error('Enter a branch name.');
    await this.run(['check-ref-format', '--branch', next]);
    await this.run(['show-ref', '--verify', '--quiet', `refs/heads/${current}`]);
    await this.run(['branch', '--move', current, next]);
  }

  async deleteBranch(branchName: string, remote: boolean): Promise<void> {
    const branch = branchName.trim();
    if (!branch) throw new Error('Choose a branch to delete.');
    if (!remote) {
      await this.run(['branch', '--delete', branch]);
      return;
    }
    const separator = branch.indexOf('/');
    if (separator <= 0 || separator === branch.length - 1) throw new Error('The remote branch name is invalid.');
    const remoteName = branch.slice(0, separator);
    const remoteBranch = branch.slice(separator + 1);
    await this.run(['push', remoteName, '--delete', remoteBranch]);
  }

  async fetch(background = false): Promise<void> {
    await this.run(['fetch', '--all', '--prune'], 8 * 1024 * 1024, background
      ? { timeout: 30000, env: { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' } }
      : {});
  }
  async pull(strategy: PullStrategy = 'ff-only'): Promise<void> { await this.run(pullArgs(strategy)); }

  async setUpstream(remoteBranch: string): Promise<void> {
    const branch = (await this.run(['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')).trim();
    if (!branch) throw new Error('Switch to a local branch before setting an upstream.');
    const known = await this.getBranches();
    if (!known.some((candidate) => candidate.remote && candidate.name === remoteBranch)) {
      throw new Error('The selected remote branch is no longer available. Fetch and try again.');
    }
    await this.run(['branch', `--set-upstream-to=refs/remotes/${remoteBranch}`, branch]);
  }

  /** Update one non-current local branch without switching HEAD or touching the worktree. */
  async updateLocalBranch(branch: string): Promise<void> {
    const ref = `refs/heads/${branch}`;
    const oldOid = (await this.run(['show-ref', '--verify', '--hash', ref]).catch(() => '')).trim();
    if (!oldOid) throw new Error(`Local branch ${branch} no longer exists. Refresh and try again.`);
    const current = (await this.run(['symbolic-ref', '--quiet', 'HEAD']).catch(() => '')).trim();
    if (current === ref) throw new Error('Use Pull to update the checked-out branch.');
    const [remote, mergeRef, upstreamRef] = await Promise.all([
      this.run(['config', '--get', `branch.${branch}.remote`]).catch(() => ''),
      this.run(['config', '--get', `branch.${branch}.merge`]).catch(() => ''),
      this.run(['rev-parse', '--symbolic-full-name', `${branch}@{upstream}`]).catch(() => '')
    ]);
    const remoteName = remote.trim();
    const sourceRef = mergeRef.trim();
    const trackingRef = upstreamRef.trim();
    if (!remoteName || remoteName === '.' || !sourceRef.startsWith('refs/heads/') ||
        !trackingRef.startsWith('refs/remotes/')) {
      throw new Error(`Branch ${branch} has no remote upstream. Set its tracking branch first.`);
    }
    // Fetch only this upstream; other local branches and remote-tracking refs stay untouched.
    await this.run(['fetch', '--no-tags', remoteName, `+${sourceRef}:${trackingRef}`]);
    const nextOid = (await this.run(['rev-parse', '--verify', trackingRef])).trim();
    if (nextOid === oldOid) return;
    try {
      await this.run(['merge-base', '--is-ancestor', oldOid, nextOid]);
    } catch {
      throw new Error(`${branch} has local commits that diverge from ${trackingRef}. Review its history before updating.`);
    }
    if ((await this.run(['show-ref', '--verify', '--hash', ref])).trim() !== oldOid) {
      throw new Error(`${branch} changed during the update. Refresh and try again.`);
    }
    // `branch -f` refuses a branch checked out in any worktree.
    await this.run(['branch', '-f', branch, nextOid]);
  }
  async pushPreview(): Promise<PushPreview> {
    const branch = (await this.run(['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')).trim();
    if (!branch) throw new Error('Create or switch to a branch before pushing from detached HEAD.');
    return this.pushBranchPreview(branch);
  }

  async pushBranchPreview(branch: string): Promise<PushPreview> {
    if (!branch || branch.startsWith('-') || /[\r\n]/.test(branch)) throw new Error('Choose a valid local branch.');
    const ref = `refs/heads/${branch}`;
    if (!(await this.run(['show-ref', '--verify', '--hash', ref]).catch(() => '')).trim()) throw new Error(`Local branch ${branch} no longer exists.`);
    const upstreamExpression = `${branch}@{upstream}`;
    const [remote, mergeRef, upstream, head] = await Promise.all([
      this.run(['config', '--get', `branch.${branch}.remote`]).catch(() => ''),
      this.run(['config', '--get', `branch.${branch}.merge`]).catch(() => ''),
      this.run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', upstreamExpression]).catch(() => ''),
      this.run(['rev-parse', '--verify', ref])
    ]);
    const remoteName = remote.trim();
    const targetBranch = mergeRef.trim().replace(/^refs\/heads\//, '');
    if (!remoteName || remoteName === '.' || !mergeRef.trim().startsWith('refs/heads/') || !targetBranch || !upstream.trim()) {
      throw new Error('This branch has no pushable upstream. Configure its remote tracking branch before pushing.');
    }
    const [upstreamOid, counts, commitsOutput, filesOutput] = await Promise.all([
      this.run(['rev-parse', upstreamExpression]),
      this.run(['rev-list', '--left-right', '--count', `${ref}...${upstreamExpression}`]),
      this.run(['log', `${upstreamExpression}..${ref}`, '-n', '12', '--format=%H%x1f%s']),
      this.run(['diff', '--name-only', '-z', `${upstreamExpression}..${ref}`])
    ]);
    const [ahead = 0, behind = 0] = counts.trim().split(/\s+/).map(Number);
    return {
      branch, upstream: upstream.trim(), upstreamOid: upstreamOid.trim(), remote: remoteName, targetBranch, head: head.trim(),
      ahead, behind,
      commits: commitsOutput.split('\n').filter(Boolean).map((entry) => {
        const [hash = '', subject = ''] = entry.split('\x1f');
        return { hash, subject };
      }),
      fileCount: filesOutput.split('\0').filter(Boolean).length
    };
  }

  async push(expected?: PushPreview): Promise<void> {
    const current = await this.pushPreview();
    await this.performPush(current, expected);
  }

  async pushBranch(branch: string, expected?: PushPreview): Promise<void> {
    if (expected && expected.branch !== branch) throw new Error('The selected branch changed during push review.');
    const current = await this.pushBranchPreview(branch);
    await this.performPush(current, expected);
  }

  private async performPush(current: PushPreview, expected?: PushPreview): Promise<void> {
    if (expected && (current.head !== expected.head || current.upstreamOid !== expected.upstreamOid || current.remote !== expected.remote || current.targetBranch !== expected.targetBranch || current.ahead !== expected.ahead || current.behind !== expected.behind)) {
      throw new Error('The branch or outgoing commits changed during push review. Open the preview again.');
    }
    if (!current.ahead) throw new Error('There are no outgoing commits to push.');
    if (current.behind) throw new Error('The branch is behind its upstream. Fetch and review before pushing.');
    await this.run(['push', '--porcelain', current.remote, `refs/heads/${current.branch}:refs/heads/${current.targetBranch}`]);
  }

  async showHeadFile(filePath: string): Promise<string> {
    try {
      return await this.run(['show', `HEAD:${filePath}`]);
    } catch {
      return '';
    }
  }

  async trackFile(filePath: string): Promise<void> {
    const status = parsePorcelainV2(await this.run(['status', '--porcelain=v2', '-z', '--untracked-files=all']));
    if (!status.changes.some((change) => change.path === filePath && change.kind === 'untracked')) {
      throw new Error('This file is no longer untracked. Refresh and try again.');
    }
    await this.run(['add', '--', filePath]);
  }

  private async getCommitIdentity(): Promise<{ name: string; email: string; ready: boolean }> {
    const [author, committer] = await Promise.all([
      this.run(['var', 'GIT_AUTHOR_IDENT']).catch(() => ''),
      this.run(['var', 'GIT_COMMITTER_IDENT']).catch(() => '')
    ]);
    const match = author.trim().match(/^(.*) <([^<>]+)> \d+ [+-]\d{4}$/);
    return { name: match?.[1] || '', email: match?.[2] || '', ready: Boolean(match && committer.trim().match(/^(.*) <([^<>]+)> \d+ [+-]\d{4}$/)) };
  }

  async setLocalCommitIdentity(name: string, email: string): Promise<void> {
    if (!name.trim() || /[\r\n]/.test(name)) throw new Error('Enter a valid Git author name.');
    if (!/^[^\s@<>]+@[^\s@<>]+$/.test(email.trim())) throw new Error('Enter a valid Git author email.');
    await this.run(['config', '--local', 'user.name', name.trim()]);
    await this.run(['config', '--local', 'user.email', email.trim()]);
  }

  async recentCommitMessages(): Promise<Array<{ hash: string; subject: string }>> {
    const output = await this.run(['log', 'HEAD', '-n', '20', '-z', '--format=%H%x1f%s']).catch(() => '');
    return output.split('\0').filter(Boolean).map((entry) => {
      const [hash = '', subject = ''] = entry.trim().split('\x1f');
      return { hash, subject };
    }).filter((entry) => /^[0-9a-f]{40}$/.test(entry.hash));
  }

  async blameLine(filePath: string, line: number, options: { timeout?: number; signal?: AbortSignal } = {}): Promise<LineBlame> {
    if (!Number.isInteger(line) || line < 1) throw new Error('Choose a valid line in the editor.');
    const output = await this.run(['blame', '--line-porcelain', '-L', `${line},${line}`, '--', filePath], 8 * 1024 * 1024, options);
    const [header = '', ...metadata] = output.split('\n');
    const match = /^([0-9a-f]+)\s+\d+\s+\d+(?:\s+\d+)?$/.exec(header.trim());
    if (!match) throw new Error(`Git did not return blame information for ${filePath}:${line}.`);
    const fields = new Map<string, string>();
    for (const entry of metadata) {
      const separator = entry.indexOf(' ');
      if (separator > 0) fields.set(entry.slice(0, separator), entry.slice(separator + 1));
    }
    const hash = match[1]!;
    return {
      hash,
      author: fields.get('author') || 'Unknown author',
      authorTime: Number(fields.get('author-time')) || 0,
      summary: fields.get('summary') || '',
      line,
      content: metadata.find((entry) => entry.startsWith('\t'))?.slice(1) || '',
      uncommitted: /^0+$/.test(hash)
    };
  }

  async showIndexFile(filePath: string): Promise<string> {
    try {
      return await this.run(['show', `:${filePath}`]);
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
