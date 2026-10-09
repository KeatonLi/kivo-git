import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { parsePorcelainV2 } from './statusParser';
import type { BranchComparison, CherryPickPreview, GitOperationState, StashDetails, StashEntry, WorkflowFile } from './types';

type Runner = (args: string[], options?: { env?: NodeJS.ProcessEnv }) => Promise<string>;

export class GitWorkflows {
  constructor(private readonly root: string, private readonly run: Runner) {}

  private async changes() {
    return parsePorcelainV2(await this.run(['status', '--porcelain=v2', '-z', '--untracked-files=all'])).changes;
  }

  async resolveRef(ref: string): Promise<string> {
    const refs = (await this.run(['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes', 'refs/tags'])).split('\n');
    if (!refs.includes(ref)) throw new Error('This branch or tag no longer exists. Refresh and try again.');
    return (await this.run(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).trim();
  }

  private parseFiles(output: string, oldRevision: string, newRevision: string): WorkflowFile[] {
    const tokens = output.split('\0').filter(Boolean), files: WorkflowFile[] = [];
    for (let i = 0; i < tokens.length;) {
      const status = tokens[i++]!;
      const originalPath = /^[RC]/.test(status) ? tokens[i++] : undefined;
      const path = tokens[i++];
      if (path) files.push({ path, originalPath, status: status[0]!, oldRevision, newRevision });
    }
    return files;
  }

  async compare(ref: string): Promise<BranchComparison> {
    const [currentOid, targetOid, name] = await Promise.all([
      this.run(['rev-parse', '--verify', 'HEAD']).then(s => s.trim()),
      this.resolveRef(ref),
      this.run(['symbolic-ref', '--short', '-q', 'HEAD']).then(s => s.trim()).catch(() => 'Detached HEAD')
    ]);
    const log = async (tip: string, other: string) => {
      const [output, count] = await Promise.all([
        this.run(['log', '--topo-order', '-n', '80', '-z', '--format=%H%x1f%s', tip, `^${other}`, '--']),
        this.run(['rev-list', '--count', tip, `^${other}`, '--'])
      ]);
      return { count: Number(count.trim()), commits: output.split('\0').filter(Boolean).map(s => {
        const [hash = '', ...subject] = s.split('\x1f');
        return { hash: hash.trim(), subject: subject.join('\x1f') };
      }) };
    };
    const [current, target, diff] = await Promise.all([
      log(currentOid, targetOid), log(targetOid, currentOid),
      this.run(['diff', '--name-status', '-M', '-z', currentOid, targetOid, '--'])
    ]);
    return { currentName: name, targetName: ref.replace(/^refs\/(heads|remotes|tags)\//, ''), currentOid, targetOid,
      current, target, files: this.parseFiles(diff, currentOid, targetOid) };
  }

  async cherryPickPreview(hashes: string[]): Promise<CherryPickPreview> {
    if (!Array.isArray(hashes) || !hashes.length || hashes.length > 200 || hashes.some(hash => typeof hash !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(hash))) {
      throw new Error('Select between 1 and 200 valid commits.');
    }
    const selected = [...new Set(hashes)];
    if (await this.operationState()) throw new Error('Finish the current Git operation before cherry-picking commits.');
    if ((await this.changes()).length) throw new Error('Commit or stash your current changes before cherry-picking commits.');
    const branch = (await this.run(['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '')).trim();
    if (!branch) throw new Error('Checkout a local branch before cherry-picking commits.');
    const head = (await this.run(['rev-parse', '--verify', 'HEAD'])).trim();
    for (const hash of selected) {
      const commit = (await this.run(['rev-parse', '--verify', '--end-of-options', `${hash}^{commit}`])).trim();
      if (commit !== hash) throw new Error('Select commit objects from History.');
    }
    const output = await this.run(['log', '--no-walk=unsorted', '-z', '--format=%H%x1f%P%x1f%s', ...selected, '--']);
    const commits = output.split('\0').filter(Boolean).map(entry => {
      const [hash = '', parentString = '', ...subject] = entry.split('\x1f');
      return { hash: hash.trim(), parents: parentString.split(' ').filter(Boolean), subject: subject.join('\x1f') };
    });
    if (commits.length !== selected.length) throw new Error('Some selected commits are no longer available. Refresh History.');
    if (commits.some(commit => commit.parents.length > 1)) throw new Error('Merge commits need a mainline parent. Select ordinary commits to cherry-pick.');
    const order = (await this.run(['rev-list', '--topo-order', '--reverse', ...selected, '--not', head, '--'])).trim().split('\n').filter(hash => selected.includes(hash));
    if (order.length !== selected.length) throw new Error('Some selected commits are already in the current branch. Select commits from another branch.');
    return { branch, head, commits: order.map(hash => commits.find(commit => commit.hash === hash)!) };
  }

  async cherryPick(expected: CherryPickPreview): Promise<void> {
    const current = await this.cherryPickPreview(expected.commits.map(commit => commit.hash));
    if (current.branch !== expected.branch || current.head !== expected.head || current.commits.some((commit, index) => commit.hash !== expected.commits[index]?.hash)) {
      throw new Error('The current branch or selected commits changed. Review the cherry-pick again.');
    }
    // One sequencer operation keeps Continue, Skip and Abort valid for the entire batch.
    await this.run(['cherry-pick', '--no-walk=unsorted', ...current.commits.map(commit => commit.hash)], { env: { GIT_EDITOR: 'true' } });
  }

  async stashes(): Promise<StashEntry[]> {
    const output = await this.run(['stash', 'list', '-z', '--format=%H%x1f%gd%x1f%aI%x1f%gs']);
    return output.split('\0').filter(Boolean).map(entry => {
      const [hash = '', ref = '', date = '', ...subject] = entry.split('\x1f');
      return { hash: hash.trim(), ref, date, subject: subject.join('\x1f') };
    });
  }

  private async requireStash(hash: string): Promise<StashEntry> {
    if (!/^[0-9a-f]{40}$/.test(hash)) throw new Error('Choose a valid saved stash.');
    const stash = (await this.stashes()).find(entry => entry.hash === hash);
    if (!stash) throw new Error('This stash no longer exists. Refresh and try again.');
    return stash;
  }

  async stashDetails(hash: string): Promise<StashDetails> {
    const entry = await this.requireStash(hash);
    const base = (await this.run(['rev-parse', `${hash}^1`])).trim();
    const files = this.parseFiles(await this.run(['diff', '--name-status', '-M', '-z', base, hash, '--']), base, hash);
    const untracked = (await this.run(['rev-parse', '--verify', `${hash}^3`]).catch(() => '')).trim();
    if (untracked) {
      const paths = await this.run(['ls-tree', '-r', '--name-only', '-z', untracked]);
      files.push(...paths.split('\0').filter(Boolean).map(path => ({ path, status: 'A', oldRevision: base, newRevision: untracked })));
    }
    return { ...entry, files };
  }

  async saveStash(message: string): Promise<string> {
    if (await this.operationState()) throw new Error('Finish the current Git operation or conflicts before saving a stash.');
    if (!(await this.changes()).length) throw new Error('There are no changes to stash.');
    const before = (await this.stashes())[0]?.hash;
    await this.run(['stash', 'push', '--include-untracked', '-m', message.trim() || 'Kivo Git saved changes']);
    const saved = (await this.stashes())[0]?.hash;
    if (!saved || saved === before) throw new Error('Git did not create a new stash. Review the working tree.');
    if ((await this.changes()).length) throw new Error(`Changes remain in the working tree. Your stash ${saved.slice(0, 8)} is preserved; review the remaining files before switching.`);
    return saved;
  }

  async applyStash(hash: string): Promise<void> {
    await this.requireStash(hash);
    if (await this.operationState()) throw new Error('Finish the current Git operation or conflicts before restoring a stash.');
    if ((await this.changes()).length) throw new Error('Save or commit current changes before restoring this stash.');
    // Keep the stash even after a successful apply, and retain the original index.
    await this.run(['stash', 'apply', '--index', hash]);
  }

  async dropStash(hash: string): Promise<void> {
    const entry = await this.requireStash(hash);
    // Revalidate the reflog position immediately before dropping it.
    const current = (await this.run(['rev-parse', '--verify', entry.ref])).trim();
    if (current !== hash) throw new Error('The stash list changed. Refresh and try again.');
    await this.run(['stash', 'drop', entry.ref]);
  }

  async operationState(): Promise<GitOperationState | undefined> {
    const marker = async (name: string) => {
      const file = (await this.run(['rev-parse', '--git-path', name])).trim();
      return fs.readFile(path.resolve(this.root, file), 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return '';
        throw error;
      });
    };
    const [merge, rebaseMerge, rebaseApply, cherryPick, revert, changes, head] = await Promise.all([
      marker('MERGE_HEAD'), marker('rebase-merge/onto'), marker('rebase-apply/onto'), marker('CHERRY_PICK_HEAD'), marker('REVERT_HEAD'), this.changes(),
      this.run(['rev-parse', '--verify', 'HEAD']).catch(() => '')
    ]);
    const files = changes.filter(change => change.kind === 'conflict').map(change => change.path);
    const kind = rebaseMerge || rebaseApply ? 'rebase' : merge ? 'merge' : cherryPick ? 'cherry-pick' : revert ? 'revert' : files.length ? 'conflicts' : undefined;
    if (!kind) return undefined;
    const token = createHash('sha256').update([kind, merge, rebaseMerge, rebaseApply, cherryPick, revert, head].join('\0')).digest('hex');
    const canSkip = kind === 'cherry-pick' && !files.length && await this.run(['diff', '--cached', '--quiet']).then(() => true).catch(() => false);
    return { kind, token, files, ...(canSkip ? { canSkip: true } : {}) };
  }

  async resolveConflict(filePath: string): Promise<void> {
    if (!(await this.changes()).some(change => change.path === filePath && change.kind === 'conflict')) throw new Error('This file is no longer conflicted. Refresh and try again.');
    const contents = await fs.readFile(path.join(this.root, filePath), 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    if (/^<{7} /m.test(contents) && /^>{7} /m.test(contents)) throw new Error('Conflict markers remain in this file. Resolve them before marking it resolved.');
    await this.run(['--literal-pathspecs', 'add', '--', filePath]);
  }

  async finishOperation(token: string, action: 'continue' | 'abort' | 'skip'): Promise<void> {
    const state = await this.operationState();
    if (!state || state.token !== token || state.kind === 'conflicts') throw new Error('The Git operation changed. Refresh and review its current state.');
    if (action === 'continue' && state.files.length) throw new Error('Resolve and stage all conflicted files before continuing.');
    if (action === 'skip' && !state.canSkip) throw new Error('Only an empty cherry-pick with no staged changes can be skipped.');
    await this.run([state.kind, `--${action}`], { env: { GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' } });
  }
}
