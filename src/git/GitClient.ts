import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { ChangelistStore } from './ChangelistStore';
import { parsePorcelainV2 } from './statusParser';
import type { BranchSummary, CommitSummary, RepositorySnapshot } from './types';

const execFileAsync = promisify(execFile);

export class GitClient {
  private store?: ChangelistStore;

  constructor(readonly workspaceRoot: string) {}

  private async run(args: string[], maxBuffer = 8 * 1024 * 1024): Promise<string> {
    try {
      const result = await execFileAsync('git', args, {
        cwd: this.workspaceRoot,
        encoding: 'utf8',
        maxBuffer,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
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

  async snapshot(): Promise<RepositorySnapshot> {
    if (!this.store) await this.initialize();
    const [statusOutput, branches, commits, topLevel] = await Promise.all([
      this.run(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']),
      this.getBranches(),
      this.getCommits(),
      this.run(['rev-parse', '--show-toplevel'])
    ]);
    const parsed = parsePorcelainV2(statusOutput);
    const root = topLevel.trim();
    return {
      repositoryName: path.basename(root),
      root,
      ...parsed,
      changelists: await this.store!.group(parsed.changes),
      branches,
      commits
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

  private async getCommits(): Promise<CommitSummary[]> {
    try {
      const output = await this.run(['log', '-n', '40', '--date=iso-strict', '--pretty=format:%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1e']);
      return output.split('\x1e').filter(Boolean).map((record) => {
        const [hash = '', shortHash = '', author = '', date = '', subject = ''] = record.trim().split('\x1f');
        return { hash, shortHash, author, date, subject };
      });
    } catch {
      return [];
    }
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

  async fetch(): Promise<void> { await this.run(['fetch', '--all', '--prune']); }
  async pull(): Promise<void> { await this.run(['pull', '--ff-only']); }
  async push(): Promise<void> { await this.run(['push']); }

  async showHeadFile(filePath: string): Promise<string> {
    try {
      return await this.run(['show', `HEAD:${filePath}`]);
    } catch {
      return '';
    }
  }
}
