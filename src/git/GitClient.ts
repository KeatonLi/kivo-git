import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { ChangelistStore } from './ChangelistStore';
import { parsePorcelainV2 } from './statusParser';
import { GitWorkflows } from './GitWorkflows';
import { CheckoutError, GitCommandError, WorktreeCreationError, WorktreeRemovalError, parseWorktrees, sameWorktreePath,
  type WorktreeSummary, type WorktreeCreationPlan, type WorktreeDirectoryIdentity, type WorktreeRepositoryIdentity,
  type WorktreeRemovalPlan, type WorktreeRemovalResult } from './checkout';
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
      const detail = error as Error & { stderr?: string; stdout?: string; code?: string | number };
      if (detail.name === 'AbortError') throw detail;
      throw new GitCommandError(args, this.workspaceRoot, detail.code, detail.stdout || '', detail.stderr || '', detail.message);
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
    const [statusOutput, branches, tags, topLevel, identity, operation, remotes, worktrees] = await Promise.all([
      this.run(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']),
      this.getBranches(),
      this.getTags(),
      this.run(['rev-parse', '--show-toplevel']),
      this.getCommitIdentity(),
      this.workflows.operationState(),
      this.getRemotes(),
      this.getWorktrees()
    ]);
    for (const branch of branches) {
      const occupied = !branch.remote && worktrees.find(tree => tree.branch === branch.name && !sameWorktreePath(tree.path, topLevel.replace(/\r?\n$/, '')));
      if (occupied) branch.worktreePath = occupied.path;
    }
    const parsed = parsePorcelainV2(statusOutput);
    // Use the same opaque repository identity as every host request and response.
    // Git can rewrite Windows separators, drive casing and short-path aliases.
    const root = this.workspaceRoot;
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
      worktrees,
      repositoryName: path.basename(topLevel.replace(/\r?\n$/, '')),
      root,
      identity,
      operation,
      ...parsed,
      upstreamGone: headBranch?.upstreamGone,
      remotes,
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
        upstreamGone: trackCounts === '[gone]' || undefined,
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
    if (/^[0-9a-f]{4,64}$/i.test(query)) {
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
    const recordPattern = /(?<![0-9a-f])([0-9a-f]{64}|[0-9a-f]{40})\x1f([0-9a-f]{4,64})\x1f([^\x1f]*)\x1f([^\x1f]*)\x1f([^\x1f]*)\x1f([^\x1e]*)\x1e/g;
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
    if (!/^[0-9a-f]{4,64}$/i.test(hash)) throw new Error('Invalid commit hash.');
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

  async getWorktrees(): Promise<WorktreeSummary[]> {
    return parseWorktrees(await this.run(['worktree', 'list', '--porcelain', '-z']));
  }

  private async localWorktreeBranches(): Promise<Array<{ name: string; oid: string }>> {
    const output = await this.run(['for-each-ref', '--format=%(refname)%09%(objectname)', 'refs/heads']);
    return output.split('\n').filter(Boolean).map(line => {
      const [ref = '', oid = ''] = line.split('\t');
      return { name: ref.slice('refs/heads/'.length), oid };
    });
  }

  /** Offer canonical local names; porcelain branch names are also canonical. */
  async listAvailableWorktreeBranches(): Promise<Array<{ name: string; oid: string }>> {
    const [branches, trees] = await Promise.all([this.localWorktreeBranches(), this.getWorktrees()]);
    return branches.filter(branch => branch.oid && !trees.some(tree => tree.branch === branch.name))
      .map(({ name, oid }) => ({ name, oid }));
  }

  /** Resolve a target through an existing parent; never reuse an existing path. */
  private async newWorktreePath(target: string): Promise<string> {
    if (typeof target !== 'string' || !target || target.includes('\0') || !path.isAbsolute(target)) {
      throw new WorktreeCreationError('Choose an absolute path for the new worktree.');
    }
    const resolved = path.resolve(target);
    if (resolved === path.parse(resolved).root) throw new WorktreeCreationError('Choose a new directory for the worktree.');
    let parent: string;
    try {
      parent = await fs.realpath(path.dirname(resolved));
      if (!(await fs.stat(parent)).isDirectory()) throw new Error('not a directory');
    } catch {
      throw new WorktreeCreationError('The parent directory is unavailable. Choose an existing directory.');
    }
    const actual = path.join(parent, path.basename(resolved));
    try {
      await fs.lstat(actual);
      throw new WorktreeCreationError('The worktree destination already exists. Choose a new directory.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return actual;
  }

  private static async directoryIdentity(location: string): Promise<WorktreeDirectoryIdentity> {
    const canonical = await fs.realpath(location);
    const stats = await fs.stat(canonical);
    if (!stats.isDirectory()) throw new Error('Not a directory.');
    return { path: canonical, device: stats.dev, inode: stats.ino };
  }

  private static sameDirectory(left: WorktreeDirectoryIdentity, right: WorktreeDirectoryIdentity): boolean {
    return typeof right?.path === 'string' && sameWorktreePath(left.path, right.path) &&
      left.device === right.device && left.inode === right.inode;
  }

  private static containsPath(parent: string, descendant: string): boolean {
    const relative = path.relative(parent, descendant);
    return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
  }

  private async worktreeRepositoryIdentity(): Promise<WorktreeRepositoryIdentity> {
    const identity = async (args: string[]) => GitClient.directoryIdentity((await this.run(['rev-parse', ...args])).replace(/\r?\n$/, ''));
    const [source, common, sourceGitDir] = await Promise.all([
      identity(['--show-toplevel']), identity(['--path-format=absolute', '--git-common-dir']), identity(['--absolute-git-dir'])
    ]);
    return { root: this.workspaceRoot, sourceRoot: source.path, sourceDevice: source.device, sourceInode: source.inode,
      commonDir: common.path, commonDevice: common.device, commonInode: common.inode, sourceGitDir };
  }

  private static sameWorktreeRepository(left: WorktreeRepositoryIdentity, right: WorktreeRepositoryIdentity): boolean {
    return left.root === right.root && typeof right.sourceRoot === 'string' && typeof right.commonDir === 'string' &&
      sameWorktreePath(left.sourceRoot, right.sourceRoot) && left.sourceDevice === right.sourceDevice && left.sourceInode === right.sourceInode &&
      sameWorktreePath(left.commonDir, right.commonDir) && left.commonDevice === right.commonDevice && left.commonInode === right.commonInode &&
      GitClient.sameDirectory(left.sourceGitDir, right.sourceGitDir);
  }

  /** Prepare a reviewable plan without creating files or changing Git state. */
  async prepareWorktree(branchName: string, targetPath: string): Promise<WorktreeCreationPlan> {
    return this.prepareWorktreeCreation('existing-branch', branchName, targetPath);
  }

  /** Review a new local branch pinned to the selected full commit object ID. */
  async prepareNewBranchWorktree(branchName: string, targetPath: string, commitOid: string): Promise<WorktreeCreationPlan> {
    return this.prepareWorktreeCreation('new-branch', branchName, targetPath, commitOid);
  }

  private async prepareWorktreeCreation(mode: WorktreeCreationPlan['mode'], branchName: string, targetPath: string, commitOid?: string): Promise<WorktreeCreationPlan> {
    if (typeof branchName !== 'string' || !branchName || branchName.includes('\0')) {
      throw new WorktreeCreationError(mode === 'new-branch' ? 'Enter a valid new branch name.' : 'Choose an existing local branch.');
    }
    const destination = await this.newWorktreePath(targetPath);
    const [branches, trees] = await Promise.all([this.localWorktreeBranches(), this.getWorktrees()]);
    if (trees.some(tree => sameWorktreePath(tree.path, destination))) {
      throw new WorktreeCreationError('A worktree is already registered at this path. Choose a different destination.');
    }
    const occupied = trees.find(tree => tree.branch === branchName);
    if (occupied) throw new WorktreeCreationError(`${branchName} is already used by a worktree at ${occupied.path}.`);

    let head: string;
    if (mode === 'new-branch') {
      const validatedName = await this.run(['check-ref-format', '--branch', branchName]).catch(() => '');
      // `--branch` also expands @{-n}; only accept the literal name reviewed.
      if (validatedName.replace(/\r?\n$/, '') !== branchName) throw new WorktreeCreationError('Enter a valid new branch name.');
      // Git's ref storage also rejects a branch prefix/file collision. Catch it at review time.
      const compare = (name: string) => process.platform === 'win32' ? name.toLowerCase() : name;
      const requested = compare(branchName);
      if (branches.some(({ name }) => compare(name) === requested || compare(name).startsWith(`${requested}/`) || requested.startsWith(`${compare(name)}/`))) {
        throw new WorktreeCreationError(`A local branch already exists or conflicts with ${branchName}. Choose a different name.`);
      }
      if (typeof commitOid !== 'string' || !/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(commitOid)) {
        throw new WorktreeCreationError('Choose a commit from the history to start the new branch.');
      }
      head = (await this.run(['rev-parse', '--verify', '--end-of-options', `${commitOid}^{commit}`]).catch(() => '')).trim();
      if (head !== commitOid.toLowerCase()) throw new WorktreeCreationError('The reviewed commit is no longer available. Choose a commit again.');
    } else {
      const branch = branches.find(item => item.name === branchName);
      if (!branch?.oid) throw new WorktreeCreationError('The selected local branch no longer exists. Refresh and try again.');
      head = branch.oid;
    }

    const [parent, repository] = await Promise.all([fs.stat(path.dirname(destination)), this.worktreeRepositoryIdentity()]);
    if (GitClient.containsPath(repository.commonDir, destination) || GitClient.containsPath(repository.sourceGitDir.path, destination)) {
      throw new WorktreeCreationError('Choose a destination outside Git’s internal directory.');
    }
    return { ...repository, mode, branch: branchName, path: destination, head, parentDevice: parent.dev, parentInode: parent.ino };
  }

  /** Revalidate the reviewed plan, then check Git's actual state even on failure. */
  async createWorktree(plan: WorktreeCreationPlan): Promise<WorktreeSummary> {
    if (!plan || plan.root !== this.workspaceRoot || (plan.mode !== 'existing-branch' && plan.mode !== 'new-branch')) {
      throw new WorktreeCreationError('The repository changed. Review the worktree again.');
    }
    const current = await this.prepareWorktreeCreation(plan.mode, plan.branch, plan.path, plan.head);
    if (!GitClient.sameWorktreeRepository(current, plan) || !sameWorktreePath(current.path, plan.path) || current.head !== plan.head ||
        current.parentDevice !== plan.parentDevice || current.parentInode !== plan.parentInode || await GitClient.worktreePathExists(current.path)) {
      throw new WorktreeCreationError('The repository, branch or destination changed. Review the worktree again.');
    }
    let failure: unknown;
    try {
      // Existing branches must use their short local name to stay attached. New
      // branches are atomically refused by `-b` if the name is taken, never reset.
      // Pass the reviewed commit as an OID, not a ref that can advance.
      await this.run(current.mode === 'new-branch'
        ? ['worktree', 'add', '--no-track', '-b', current.branch, '--', current.path, current.head]
        : ['worktree', 'add', '--', current.path, current.branch]);
    } catch (error) { failure = error; }
    const repository = await this.worktreeRepositoryIdentity().catch(() => undefined);
    if (!repository || !GitClient.sameWorktreeRepository(repository, current)) {
      throw new WorktreeCreationError('The repository changed after Git ran. Check Git worktree list and the destination before retrying.');
    }
    const [trees, branches, destination] = await Promise.allSettled([
      this.getWorktrees(), current.mode === 'new-branch' ? this.localWorktreeBranches() : Promise.resolve([]),
      GitClient.worktreePathExists(current.path)
    ]);
    const created = trees.status === 'fulfilled' ? trees.value.find(tree => sameWorktreePath(tree.path, current.path)) : undefined;
    const actualBranch = branches.status === 'fulfilled' ? branches.value.find(branch => branch.name === current.branch) : undefined;
    const pathExists = destination.status === 'fulfilled' ? destination.value : undefined;
    const details = failure instanceof Error ? failure.message : 'Git finished but the registered worktree did not match the reviewed branch and commit.';
    if (trees.status === 'rejected' || branches.status === 'rejected' || pathExists === undefined) {
      throw new WorktreeCreationError('Could not verify the worktree or branch after Git ran. Inspect both before retrying.', created, details, actualBranch, pathExists);
    }
    if (!failure && pathExists && created?.branch === current.branch && created.head === current.head && !created.detached &&
        created.prunable === undefined && (current.mode === 'existing-branch' || actualBranch?.oid === current.head)) return created;
    if (created) {
      throw new WorktreeCreationError('A worktree is registered at the selected path, but creation did not complete as reviewed. Inspect it before retrying.', created, details, actualBranch, pathExists);
    }
    throw new WorktreeCreationError(actualBranch
      ? 'The branch exists, but no worktree is registered at the selected path. Inspect it before retrying.'
      : 'Could not create the worktree. Check the destination and Git worktree list before retrying.', undefined, details, actualBranch, pathExists);
  }

  private async removalWorktree(targetPath: string, sourceRoot: string): Promise<WorktreeSummary> {
    const [primary, ...linked] = await this.getWorktrees();
    if (sameWorktreePath(targetPath, sourceRoot)) throw new WorktreeRemovalError('The current worktree cannot be removed.');
    if (primary && sameWorktreePath(primary.path, targetPath)) throw new WorktreeRemovalError('The primary worktree cannot be removed.');
    const worktree = linked.find(tree => sameWorktreePath(tree.path, targetPath));
    if (!worktree?.head || worktree.bare || worktree.prunable !== undefined) {
      throw new WorktreeRemovalError('This worktree is unavailable. Refresh Worktrees before trying again.');
    }
    if (worktree.locked !== undefined) throw new WorktreeRemovalError('This worktree is locked and cannot be removed.');
    const otherTrees = (primary ? [primary, ...linked] : linked).filter(tree => tree !== worktree);
    const nested = await Promise.all(otherTrees.map(async tree =>
      GitClient.containsPath(worktree.path, tree.path) ||
      GitClient.containsPath(worktree.path, await fs.realpath(tree.path).catch(() => tree.path))));
    if (nested.some(Boolean)) throw new WorktreeRemovalError('This worktree contains another registered worktree and cannot be removed.');
    return worktree;
  }

  private static async verifyWorktreePointers(directory: WorktreeDirectoryIdentity, gitDir: WorktreeDirectoryIdentity): Promise<void> {
    const forward = path.join(directory.path, '.git');
    const backward = path.join(gitDir.path, 'gitdir');
    if (!(await fs.lstat(forward)).isFile() || !(await fs.lstat(backward)).isFile()) {
      throw new WorktreeRemovalError('The worktree registration does not match its directory.');
    }
    const [gitFile, backpointer] = await Promise.all([fs.readFile(forward, 'utf8'), fs.readFile(backward, 'utf8')]);
    if (!gitFile.startsWith('gitdir: ') || !backpointer ||
        !sameWorktreePath(await fs.realpath(path.resolve(directory.path, gitFile.slice(8).replace(/\r?\n$/, ''))), gitDir.path) ||
        !sameWorktreePath(await fs.realpath(path.resolve(gitDir.path, backpointer.replace(/\r?\n$/, ''))), forward)) {
      throw new WorktreeRemovalError('The worktree registration does not match its directory.');
    }
  }

  /** Refuse to remove anything whose clean state or linked-worktree identity cannot be verified. */
  async prepareWorktreeRemoval(targetPath: string): Promise<WorktreeRemovalPlan> {
    if (typeof targetPath !== 'string' || !targetPath || targetPath.includes('\0') || !path.isAbsolute(targetPath)) {
      throw new WorktreeRemovalError('Choose a registered worktree to remove.');
    }
    try {
      const repository = await this.worktreeRepositoryIdentity();
      // Normalize caller paths (e.g. Windows short names) without substituting a symlink at the worktree itself.
      const parent = await fs.realpath(path.dirname(targetPath)).catch(() => path.dirname(targetPath));
      const worktree = await this.removalWorktree(path.join(parent, path.basename(targetPath)), repository.sourceRoot);
      const directory = await GitClient.directoryIdentity(worktree.path);
      if (!sameWorktreePath(directory.path, worktree.path) || !(await fs.lstat(path.join(directory.path, '.git'))).isFile()) {
        throw new WorktreeRemovalError('This worktree cannot be verified at its registered location.');
      }
      const target = new GitClient(directory.path);
      const [targetRepository, head] = await Promise.all([
        target.worktreeRepositoryIdentity(), target.run(['rev-parse', '--verify', 'HEAD'])
      ]);
      const gitDir = targetRepository.sourceGitDir;
      if (!sameWorktreePath(targetRepository.sourceRoot, directory.path) ||
          !sameWorktreePath(targetRepository.commonDir, repository.commonDir) || targetRepository.commonDevice !== repository.commonDevice ||
          targetRepository.commonInode !== repository.commonInode ||
          !sameWorktreePath(path.dirname(gitDir.path), path.join(repository.commonDir, 'worktrees')) ||
          head.trim() !== worktree.head || (!worktree.branch && !worktree.detached)) {
        throw new WorktreeRemovalError('This worktree or its HEAD changed. Refresh Worktrees before trying again.');
      }
      await GitClient.verifyWorktreePointers(directory, gitDir);
      if (worktree.detached && !(await target.run(['for-each-ref', `--contains=${worktree.head}`, '--format=%(refname)', 'refs/heads', 'refs/tags'])).trim()) {
        throw new WorktreeRemovalError('The detached HEAD is not reachable from any local branch or tag. Create a branch for it before removing this worktree.');
      }
      const markerNames = ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'sequencer', 'BISECT_START'];
      const [status, indexed, operation] = await Promise.all([
        target.run(['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=traditional', '--ignore-submodules=none']),
        target.run(['ls-files', '-v', '-z']),
        Promise.all(markerNames.map(marker => GitClient.worktreePathExists(path.join(gitDir.path, marker)))).then(markers => markers.some(Boolean))
      ]);
      if (operation) throw new WorktreeRemovalError('Finish the Git operation in this worktree before removing it.');
      if (status) throw new WorktreeRemovalError('This worktree has staged, unstaged, untracked or ignored files. Review its changes before removing it.');
      // Status intentionally hides these entries. Refuse rather than risk deleting local content.
      if (indexed.split('\0').some(entry => /^[a-zS] /.test(entry))) {
        throw new WorktreeRemovalError('This worktree has index entries whose working files Git may not check. It cannot be safely removed here.');
      }
      return { ...repository, worktree, directory, gitDir };
    } catch (error) {
      if (error instanceof WorktreeRemovalError) throw error;
      throw new WorktreeRemovalError('Could not verify that the worktree is available and clean. It was not removed.', error instanceof Error ? error.message : undefined);
    }
  }

  private static async worktreePathExists(location: string): Promise<boolean> {
    try { await fs.lstat(location); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  /** Only Git removes worktrees. Never force, prune, delete a branch, or retry automatically. */
  async removeWorktree(plan: WorktreeRemovalPlan): Promise<WorktreeRemovalResult> {
    if (!plan?.worktree || plan.root !== this.workspaceRoot) throw new WorktreeRemovalError('The repository changed. Review the worktree again.');
    const current = await this.prepareWorktreeRemoval(plan.worktree.path);
    const matchesWorktree = (worktree: WorktreeSummary) => sameWorktreePath(worktree.path, plan.worktree.path) &&
      worktree.head === plan.worktree.head && worktree.branch === plan.worktree.branch && worktree.detached === plan.worktree.detached;
    const [repository, worktree, directory, gitDir] = await Promise.all([
      this.worktreeRepositoryIdentity(), this.removalWorktree(current.worktree.path, current.sourceRoot),
      GitClient.directoryIdentity(current.directory.path), GitClient.directoryIdentity(current.gitDir.path),
      GitClient.verifyWorktreePointers(current.directory, current.gitDir)
    ]).catch((error: unknown) => {
      if (error instanceof WorktreeRemovalError) throw error;
      throw new WorktreeRemovalError('Could not revalidate the worktree or repository. Nothing was removed.', error instanceof Error ? error.message : undefined);
    });
    if (!GitClient.sameWorktreeRepository(current, plan) || !GitClient.sameWorktreeRepository(repository, plan) ||
        !matchesWorktree(current.worktree) || !matchesWorktree(worktree) ||
        !GitClient.sameDirectory(current.directory, plan.directory) || !GitClient.sameDirectory(directory, plan.directory) ||
        !GitClient.sameDirectory(current.gitDir, plan.gitDir) || !GitClient.sameDirectory(gitDir, plan.gitDir)) {
      throw new WorktreeRemovalError('The repository, worktree or HEAD changed. Review the worktree again.');
    }
    let failure: unknown;
    try { await this.run(['worktree', 'remove', '--', worktree.path]); }
    catch (error) { failure = error; }
    const afterRepository = await this.worktreeRepositoryIdentity().catch(() => undefined);
    if (!afterRepository || !GitClient.sameWorktreeRepository(afterRepository, current)) {
      throw new WorktreeRemovalError('The repository changed after Git ran. Check Git worktree list and the destination before retrying.');
    }
    let actual: WorktreeRemovalResult;
    try {
      const [trees, pathExists] = await Promise.all([this.getWorktrees(), GitClient.worktreePathExists(worktree.path)]);
      const registered = trees.find(tree => sameWorktreePath(tree.path, worktree.path));
      actual = { removed: !registered && !pathExists, worktree: registered, pathExists };
    } catch (error) {
      throw new WorktreeRemovalError('Could not verify the worktree after Git ran. Check Git worktree list and the destination before retrying.', error instanceof Error ? error.message : undefined);
    }
    if (!failure && actual.removed) return actual;
    const message = actual.removed ? 'The worktree is gone, but Git reported an error.' : actual.worktree
      ? 'The worktree is still registered. Inspect its state before retrying.'
      : 'The worktree is no longer registered, but its directory still exists. Inspect it before retrying.';
    throw new WorktreeRemovalError(message, failure instanceof Error ? failure.message : undefined, actual);
  }

  private async checkSwitchState(): Promise<void> {
    const operation = await this.workflows.operationState();
    if (operation) throw new CheckoutError('operation-in-progress', `Finish the current ${operation.kind} before switching branches.`,
      `The current ${operation.kind} is unfinished. Open Changes to resolve conflicts and continue or abort it.\n${operation.files.join('\n')}`);
  }

  private async checkoutPlan(branchName: string, remote: boolean): Promise<{ args: string[]; branch: string; oid: string }> {
    await this.checkSwitchState();
    const branches = await this.getBranches();
    const target = branches.find(branch => branch.name === branchName && branch.remote === remote);
    if (!target) throw new CheckoutError('branch-missing', 'This branch no longer exists. Refresh and try again.');
    const localName = remote ? branchName.slice(branchName.indexOf('/') + 1) : branchName;
    const local = branches.find(branch => !branch.remote && branch.name === localName);
    if (remote && local && local.upstream !== branchName) throw new CheckoutError('tracking-conflict', `${localName} already exists and tracks a different branch. Choose its local branch explicitly.`);
    const [worktrees, currentRoot] = await Promise.all([this.getWorktrees(), this.run(['rev-parse', '--show-toplevel'])]);
    const occupied = worktrees.find(tree => tree.branch === localName && !sameWorktreePath(tree.path, currentRoot.replace(/\r?\n$/, '')));
    if (occupied) {
      const error = new CheckoutError('worktree-occupied', `${localName} is already open in another worktree.`,
        `${localName} is used by worktree at:\n${occupied.path}\nOpen that worktree to work on this branch. No changes were stashed.`);
      error.worktreePath = occupied.path;
      throw error;
    }
    return { branch: localName, oid: (local || target).oid!, args: remote && !local
      ? ['switch', '--track', '-c', localName, branchName] : ['switch', localName] };
  }

  async checkCheckout(branchName: string, remote: boolean): Promise<void> {
    await this.checkoutPlan(branchName, remote);
  }

  private async switchAndVerify(args: string[], expectedBranch: string | undefined, expectedOid: string, stashHash?: string): Promise<void> {
    let commandError: unknown;
    try { await this.run(args); } catch (error) { commandError = error; }
    const [branch, oid] = await Promise.all([
      this.run(['symbolic-ref', '--short', '-q', 'HEAD']).then(value => value.trim()).catch(() => ''),
      this.run(['rev-parse', '--verify', 'HEAD']).then(value => value.trim()).catch(() => '')
    ]);
    const reachedTarget = branch === (expectedBranch || '') && oid === expectedOid;
    if (!commandError && reachedTarget) return;
    let error: CheckoutError;
    const detail = commandError instanceof GitCommandError
      ? `git ${commandError.args.join(' ')}\nExit: ${commandError.exitCode ?? 'unknown'}\n${commandError.stderr}\n${commandError.stdout}`
      : commandError instanceof Error ? commandError.message : String(commandError || 'The checkout changed while it was running.');
    if (reachedTarget) {
      error = new CheckoutError('checkout-completed-with-error', `Now on ${expectedBranch || expectedOid.slice(0, 8)}, but Git reported a checkout error.`,
        `The target was reached. A post-checkout hook or another checkout step reported an error. Review the details before retrying.\n${detail}`);
    } else {
      const [operation, worktrees, currentRoot] = await Promise.all([this.workflows.operationState().catch(() => undefined), this.getWorktrees().catch(() => []), this.run(['rev-parse', '--show-toplevel']).catch(() => this.workspaceRoot)]);
      const occupied = expectedBranch && worktrees.find(tree => tree.branch === expectedBranch && !sameWorktreePath(tree.path, currentRoot.replace(/\r?\n$/, '')));
      const changesBlocked = commandError instanceof GitCommandError && /would be overwritten|local changes|untracked working tree files/i.test(commandError.stderr);
      error = new CheckoutError(occupied ? 'worktree-occupied' : operation ? 'operation-in-progress' : changesBlocked ? 'changes-blocked' : commandError ? 'git-error' : 'checkout-incomplete',
        occupied ? `${expectedBranch} is already open in another worktree.` : operation ? `Finish the current ${operation.kind} before switching branches.` : changesBlocked ? 'Local files prevent switching branches. Review or save your changes.' : `Could not switch to ${expectedBranch || expectedOid.slice(0, 8)}.`, detail);
      if (occupied) error.worktreePath = occupied.path;
    }
    error.actualBranch = branch || (oid ? 'Detached HEAD' : 'Unknown (unable to read HEAD)');
    if (stashHash) {
      error.stashHash = stashHash;
      error.message += ` Your changes remain saved in stash ${stashHash.slice(0, 8)}.`;
    }
    throw error;
  }

  async checkout(branchName: string, remote: boolean): Promise<void> {
    const plan = await this.checkoutPlan(branchName, remote);
    await this.switchAndVerify(plan.args, plan.branch, plan.oid);
  }

  async stashAndCheckout(branchName: string, remote: boolean): Promise<void> {
    const plan = await this.checkoutPlan(branchName, remote);
    const saved = await this.workflows.saveStash(`Kivo Git: before switching to ${branchName}`);
    await this.switchAndVerify(plan.args, plan.branch, plan.oid, saved);
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
    if ((await this.getBranches()).some(branch => !branch.remote && branch.name === name)) throw new CheckoutError('tracking-conflict', `${name} already exists. Choose another branch name.`);
    await this.checkSwitchState();
    const oid = (await this.run(['rev-parse', '--verify', `${startPoint}^{commit}`])).trim();
    await this.switchAndVerify(['switch', '-c', name, startPoint], name, oid);
  }

  async createTag(tagName: string, revision: string): Promise<void> {
    const name = tagName.trim();
    if (!name) throw new Error('Enter a tag name.');
    if (!/^[0-9a-f]{4,64}$/i.test(revision)) throw new Error('Invalid commit hash.');
    await this.run(['check-ref-format', `refs/tags/${name}`]);
    await this.run(['rev-parse', '--verify', '--quiet', `${revision}^{commit}`]);
    await this.run(['tag', name, revision]);
  }

  async checkoutRevision(revision: string): Promise<void> {
    if (!/^[0-9a-f]{4,64}$/i.test(revision)) throw new Error('Invalid commit hash.');
    await this.run(['rev-parse', '--verify', '--quiet', `${revision}^{commit}`]);
    await this.checkSwitchState();
    const oid = (await this.run(['rev-parse', '--verify', `${revision}^{commit}`])).trim();
    await this.switchAndVerify(['switch', '--detach', revision], undefined, oid);
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
  private async getRemotes(): Promise<string[]> {
    return (await this.run(['remote'])).split('\n').filter(Boolean);
  }

  async pushTarget(branch?: string): Promise<{ branch: string; remote?: string; targetBranch: string; remotes: string[]; setUpstream: boolean }> {
    branch ||= (await this.run(['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')).trim();
    if (!branch) throw new Error('Create or switch to a branch before pushing from detached HEAD.');
    if (!branch || branch.startsWith('-') || /[\r\n]/.test(branch)) throw new Error('Choose a valid local branch.');
    const ref = `refs/heads/${branch}`;
    if (!(await this.run(['show-ref', '--verify', '--hash', ref]).catch(() => '')).trim()) throw new Error(`Local branch ${branch} no longer exists.`);
    const [remote, mergeRef, remotes] = await Promise.all([
      this.run(['config', '--get', `branch.${branch}.remote`]).catch(() => ''),
      this.run(['config', '--get', `branch.${branch}.merge`]).catch(() => ''),
      this.getRemotes()
    ]);
    if (!remotes.length) throw new Error('No Git remote is configured. Add a remote before publishing this branch.');
    if (remote.trim() === '.') throw new Error('This branch tracks another local branch. Choose a remote tracking branch before pushing.');
    const configured = Boolean(remote.trim() && mergeRef.trim().startsWith('refs/heads/'));
    if (configured && !remotes.includes(remote.trim())) throw new Error(`The configured remote ${remote.trim()} no longer exists. Set a new tracking branch before pushing.`);
    return {
      branch, remotes, remote: configured ? remote.trim() : remotes.length === 1 ? remotes[0] : undefined,
      targetBranch: configured ? mergeRef.trim().slice('refs/heads/'.length) : branch,
      setUpstream: !configured
    };
  }

  async pushPreview(remote?: string): Promise<PushPreview> {
    const target = await this.pushTarget();
    return this.pushBranchPreview(target.branch, remote);
  }

  async pushBranchPreview(branch: string, selectedRemote?: string): Promise<PushPreview> {
    const target = await this.pushTarget(branch);
    const remoteName = selectedRemote || target.remote;
    if (!remoteName) throw new Error('Choose a remote to publish this branch.');
    if (!target.remotes.includes(remoteName) || remoteName.startsWith('-')) throw new Error('The selected remote no longer exists. Reopen Push and choose a remote.');
    if (!target.setUpstream && remoteName !== target.remote) throw new Error('The tracking destination changed during push review. Open the preview again.');
    const ref = `refs/heads/${branch}`;
    const upstreamExpression = `${branch}@{upstream}`;
    const targetRef = `refs/heads/${target.targetBranch}`;
    const [headOutput, upstreamOutput, cachedOid, pushUrls, fetchUrl] = await Promise.all([
      this.run(['rev-parse', '--verify', ref]),
      this.run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', upstreamExpression]).catch(() => ''),
      this.run(['rev-parse', '--verify', `${upstreamExpression}^{commit}`]).catch(() => ''),
      this.run(['remote', 'get-url', '--push', '--all', remoteName]),
      this.run(['remote', 'get-url', remoteName])
    ]);
    const urls = pushUrls.trim().split('\n').filter(Boolean);
    if (urls.length !== 1) throw new Error('This remote has multiple push URLs. Choose a remote with a single push destination.');
    const head = headOutput.trim();
    const destinationId = createHash('sha256').update(urls[0]!).digest('hex');
    let upstreamOid = cachedOid.trim();
    if (target.setUpstream || !upstreamOid) {
      // Inspect the push URL: a same-name server branch can exist even without
      // a local tracking ref. Fetch its objects without setting local tracking.
      const remoteRef = await this.run(['ls-remote', '--heads', '--', urls[0]!, targetRef]);
      upstreamOid = remoteRef.split('\n').find((line) => line.split('\t')[1] === targetRef)?.split('\t')[0] || '';
      if (upstreamOid && !(await this.run(['cat-file', '-e', `${upstreamOid}^{commit}`]).then(() => true).catch(() => false))) {
        await this.run(['fetch', '--no-tags', '--no-write-fetch-head', '--', urls[0]!, targetRef]);
        await this.run(['cat-file', '-e', `${upstreamOid}^{commit}`]);
      }
    }
    const publish = !upstreamOid;
    // Cached fetch refs describe this server only when fetch and push URLs agree.
    const range = publish ? [head, ...(fetchUrl.trim() === urls[0] ? ['--not', `--remotes=${remoteName}`] : [])] : [`${upstreamOid}..${head}`];
    const [counts, commitsOutput, filesOutput] = await Promise.all([
      this.run(publish ? ['rev-list', '--count', ...range] : ['rev-list', '--left-right', '--count', `${head}...${upstreamOid}`]),
      this.run(['log', ...range, '-n', '12', '--format=%H%x1f%s']),
      this.run(publish ? ['ls-tree', '-r', '--name-only', '-z', head] : ['diff', '--name-only', '-z', `${upstreamOid}..${head}`])
    ]);
    const [ahead = 0, behind = 0] = counts.trim().split(/\s+/).map(Number);
    return {
      branch, upstream: upstreamOutput.trim() || `${remoteName}/${target.targetBranch}`, upstreamOid,
      remote: remoteName, targetBranch: target.targetBranch, head, publish,
      setUpstream: target.setUpstream || publish || !cachedOid.trim(), destinationId,
      ahead, behind,
      commits: commitsOutput.split('\n').filter(Boolean).map((entry) => {
        const [hash = '', subject = ''] = entry.split('\x1f');
        return { hash, subject };
      }),
      fileCount: filesOutput.split('\0').filter(Boolean).length
    };
  }

  async push(expected?: PushPreview): Promise<void> {
    const current = await this.pushPreview(expected?.remote);
    await this.performPush(current, expected);
  }

  async pushBranch(branch: string, expected?: PushPreview): Promise<void> {
    if (expected && expected.branch !== branch) throw new Error('The selected branch changed during push review.');
    const current = await this.pushBranchPreview(branch, expected?.remote);
    await this.performPush(current, expected);
  }

  private async performPush(current: PushPreview, expected?: PushPreview): Promise<void> {
    if (expected && (current.branch !== expected.branch || current.head !== expected.head || current.upstreamOid !== expected.upstreamOid || current.remote !== expected.remote || current.targetBranch !== expected.targetBranch || current.ahead !== expected.ahead || current.behind !== expected.behind || Boolean(current.publish) !== Boolean(expected.publish) || Boolean(current.setUpstream) !== Boolean(expected.setUpstream) || current.destinationId !== expected.destinationId)) {
      throw new Error('The branch or outgoing commits changed during push review. Open the preview again.');
    }
    if (!current.ahead && !current.publish && !current.setUpstream) throw new Error('There are no outgoing commits to push.');
    if (current.behind) throw new Error('The branch is behind its upstream. Fetch and review before pushing.');
    const targetRef = `refs/heads/${current.targetBranch}`;
    // An empty expected OID allows creation only. A branch created on the server
    // after review must never turn this publication into an unreviewed update.
    await this.run(['push', '--porcelain', ...(current.setUpstream ? ['--set-upstream'] : []),
      ...(current.publish ? [`--force-with-lease=${targetRef}:`] : []), '--', current.remote, `refs/heads/${current.branch}:${targetRef}`]);
  }

  async showHeadFile(filePath: string): Promise<string> {
    return this.readDiffFile(`HEAD:${filePath}`, filePath);
  }

  private async readDiffFile(object: string, filePath: string): Promise<string> {
    try {
      return await this.run(['show', object]);
    } catch (error) {
      if (error instanceof GitCommandError && error.exitCode === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        throw new Error(`Cannot open the Git version of ${filePath}: it exceeds Kivo Git's 8 MiB diff limit. Use Git or another diff tool to review this file.`);
      }
      // stdout can contain a partial file on failure. Never use it as the error
      // message or an empty diff: it may contain private source code.
      throw new Error(`Cannot read the Git version of ${filePath}. The file or repository may have changed; refresh and try again.`);
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
    }).filter((entry) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(entry.hash));
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
    return this.readDiffFile(`:${filePath}`, filePath);
  }

  async showFileAtRevision(revision: string, filePath: string): Promise<string> {
    if (!/^[0-9a-f]{4,64}$/i.test(revision)) throw new Error('Invalid commit hash. Refresh and try again.');
    return this.readDiffFile(`${revision}:${filePath}`, filePath);
  }
}
