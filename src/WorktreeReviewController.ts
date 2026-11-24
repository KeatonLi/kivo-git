import * as vscode from 'vscode';
import { GitClient } from './git/GitClient';
import { WorktreeReviewState, type WorktreeReviewEntry } from './git/WorktreeReviewState';
import { readWorktreeReviewInventory, readWorktreeReviewData, type WorktreeReviewInventory } from './git/WorktreeReviewGit';
import type { CommitDetails } from './git/types';
import type { KivoSurface } from './viewLayout';

export type WorktreeReviewMessage =
  | { type: 'worktreeReviewOpen' | 'worktreeReviewClose'; root: string }
  | { type: 'worktreeReviewList'; root: string; requestId: number }
  | { type: 'worktreeReviewMark'; root: string; requestId: number; id: string; version: number }
  | { type: 'worktreeReviewDetails'; root: string; requestId: number; id: string; version: number }
  | { type: 'worktreeReviewCommit'; root: string; requestId: number; id: string; version: number; hash: string }
  | { type: 'worktreeReviewDiff'; root: string; id: string; version: number; hash: string; path: string };

type ReviewScope = { root: string; inventory: WorktreeReviewInventory; state: WorktreeReviewState };
type ReviewSession = { scope: ReviewScope; id: string; version: number; hashes: Set<string>; details?: CommitDetails; commitRequest?: number };

export class WorktreeReviewController implements vscode.Disposable {
  private scope?: ReviewScope;
  private session?: ReviewSession;
  private stale = false;
  private revision = 0;
  private generation = 0;
  private pendingOpen?: string;
  private watcher?: vscode.FileSystemWatcher;
  private watching?: string;
  private timer?: ReturnType<typeof setTimeout>;
  private inFlight?: Promise<void>;
  private disposed = false;
  private requestEpoch = 0;

  constructor(
    private readonly storage: vscode.Memento,
    private readonly activeRoot: () => string | undefined,
    private readonly visible: () => boolean,
    private readonly post: (surface: KivoSurface | undefined, message: Record<string, unknown>) => Promise<unknown>,
    private readonly focusHistory: () => Promise<void>,
    private readonly openDiff: (client: GitClient, hash: string, path: string, originalPath: string | undefined, kind: string, details: CommitDetails) => Promise<void>
  ) {}

  reset(): void {
    this.generation++;
    this.requestEpoch++;
    this.pendingOpen = undefined;
    this.scope = undefined;
    this.session = undefined;
    this.inFlight = undefined;
    this.stale = false;
    this.stopListening();
  }

  stopListening(): void {
    this.watcher?.dispose();
    this.watcher = undefined;
    this.watching = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  dispose(): void { this.disposed = true; this.reset(); }

  closeReview(): void {
    this.session = undefined;
    this.requestEpoch++;
  }

  private isActive(root: string, generation = this.generation): boolean {
    return !this.disposed && generation === this.generation && root === this.activeRoot();
  }

  private key(repositoryId: string): string { return `kivo.worktreeReview.v1:${repositoryId}`; }

  private schedule(delay = 350): void {
    if (!this.visible() || this.timer || this.disposed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const root = this.activeRoot();
      if (root && this.visible()) void this.refresh(root);
    }, delay);
  }

  private listen(commonDir: string): void {
    if (!this.visible() || this.watching === commonDir) return;
    this.stopListening();
    this.watching = commonDir;
    this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(commonDir), '{worktrees,worktrees/*,worktrees/*/HEAD,worktrees/*/gitdir,worktrees/*/locked,HEAD,refs/heads/**,packed-refs}'));
    this.watcher.onDidCreate(() => this.schedule());
    this.watcher.onDidChange(() => this.schedule());
    this.watcher.onDidDelete(() => this.schedule());
  }

  private status(root: string) {
    const entries = this.scope?.root === root ? this.scope.state.entries() : [];
    return { type: 'worktreeReviewStatus', root, count: entries.filter(entry => entry.kind !== 'removed' && entry.prunable === undefined && !entry.bare).length,
      pending: entries.filter(entry => entry.pending).length, stale: this.stale, revision: this.revision };
  }

  async ready(surface: KivoSurface, root: string): Promise<void> {
    if (!this.isActive(root)) return;
    await this.post(surface, this.status(root));
    if (surface === 'history' && this.pendingOpen === root) {
      // If the view has not mounted, keep the request for its ready message.
      if (await this.post(surface, { type: 'worktreeReviewShown', root }) === true && this.pendingOpen === root) this.pendingOpen = undefined;
    }
  }

  refresh(root: string): Promise<void> {
    if (!this.isActive(root)) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    const generation = this.generation;
    const task = this.scan(root, generation).catch(async () => {
      if (this.isActive(root, generation) && !this.stale) {
        this.stale = true;
        await this.post(undefined, this.status(root));
      }
    });
    this.inFlight = task;
    void task.then(() => { if (this.inFlight === task) this.inFlight = undefined; }, () => { if (this.inFlight === task) this.inFlight = undefined; });
    return task;
  }

  private async scan(root: string, generation: number): Promise<void> {
    let inventory: WorktreeReviewInventory;
    try { inventory = await readWorktreeReviewInventory(root); }
    catch {
      if (this.isActive(root, generation) && !this.stale) {
        this.stale = true;
        await this.post(undefined, this.status(root));
      }
      return;
    }
    if (!this.isActive(root, generation)) return;
    const previousScope = this.scope;
    if (previousScope?.root !== root || previousScope.inventory.repositoryId !== inventory.repositoryId) {
      this.scope = { root, inventory, state: new WorktreeReviewState(this.storage.get(this.key(inventory.repositoryId))) };
      this.session = undefined;
    }
    const scope = this.scope!;
    scope.inventory = inventory;
    this.listen(inventory.commonDir);
    const changed = scope.state.observe(inventory.entries);
    const recovered = this.stale;
    this.stale = false;
    if (changed || scope !== previousScope) {
      this.revision++;
      await this.storage.update(this.key(inventory.repositoryId), scope.state.serialize()).then(undefined, () => {});
    }
    if ((changed || scope !== previousScope || recovered) && this.isActive(root, generation)) await this.post(undefined, this.status(root));
  }

  private entry(scope: ReviewScope, id: string, version: number): WorktreeReviewEntry {
    const entry = scope.state.entries().find(candidate => candidate.id === id && candidate.version === version);
    if (!entry) throw new Error('Worktree changed. Refresh the list and review the latest version.');
    return entry;
  }

  private async verifyScope(scope: ReviewScope): Promise<void> {
    const actual = await readWorktreeReviewInventory(scope.root);
    if (actual.repositoryId !== scope.inventory.repositoryId || this.scope !== scope || !this.isActive(scope.root)) {
      throw new Error('Repository changed. Reopen Worktree Review.');
    }
  }

  async handle(surface: KivoSurface, message: WorktreeReviewMessage): Promise<void> {
    const { root, type } = message;
    if (!this.isActive(root)) return;
    if (type === 'worktreeReviewOpen') {
      this.pendingOpen = root;
      await this.focusHistory();
      await this.ready('history', root);
      return;
    }
    if (surface !== 'history') return;
    if (type === 'worktreeReviewClose') {
      this.session = undefined;
      this.requestEpoch++;
      return;
    }
    if (type === 'worktreeReviewList') {
      await this.refresh(root);
      if (this.isActive(root)) await this.post(surface, { type: 'worktreeReviewListResult', root, requestId: message.requestId,
        entries: this.scope?.root === root ? this.scope.state.entries() : [], stale: this.stale });
      return;
    }
    if (!('id' in message)) return;
    const { id, version } = message;
    const reply = { type: `${type}Result`, root, id, version,
      ...('requestId' in message ? { requestId: message.requestId } : {}),
      ...('hash' in message ? { hash: message.hash } : {}), ...('path' in message ? { path: message.path } : {}) };
    const epoch = type === 'worktreeReviewDetails' ? ++this.requestEpoch : this.requestEpoch;
    const send = async (payload: Record<string, unknown>) => {
      if (epoch === this.requestEpoch && this.isActive(root)) await this.post(surface, { ...reply, ...payload });
    };
    try {
      const scope = this.scope;
      if (!scope || scope.root !== root) throw new Error('Refresh the worktree list before reviewing.');
      if (type === 'worktreeReviewDetails') {
        this.session = undefined;
        const entry = this.entry(scope, id, version);
        const data = await readWorktreeReviewData(root, scope.inventory, entry, entry.previousReviewHead);
        if (epoch !== this.requestEpoch || this.scope !== scope) return;
        this.session = { scope, id, version, hashes: new Set(data.commits.map(commit => commit.hash)) };
        await send({ payload: data });
      } else if (type === 'worktreeReviewMark') {
        const reviewed = this.session;
        const selected = this.entry(scope, id, version);
        if (selected.kind !== 'removed' && (!reviewed || reviewed.scope !== scope || reviewed.id !== id || reviewed.version !== version)) {
          throw new Error('Load the worktree details before marking it reviewed.');
        }
        // Do not use a refresh which started before this request as confirmation.
        if (this.inFlight) await this.inFlight;
        await this.refresh(root);
        if (epoch !== this.requestEpoch || this.scope !== scope) return;
        if (this.stale || !scope.state.markReviewed({ id, version })) throw new Error('Worktree changed or could not be verified. Refresh and review again.');
        this.revision++;
        await this.storage.update(this.key(scope.inventory.repositoryId), scope.state.serialize());
        await send({ ok: true });
        if (this.scope === scope) await this.post(undefined, this.status(root));
      } else {
        const session = this.session;
        if (!session || session.scope !== scope || session.id !== id || session.version !== version || !session.hashes.has(message.hash)) {
          throw new Error('Select a commit in the pinned review range.');
        }
        await this.verifyScope(scope);
        if (this.session !== session || epoch !== this.requestEpoch) return;
        const client = new GitClient(root);
        if (type === 'worktreeReviewCommit') {
          if (session.commitRequest !== undefined && message.requestId < session.commitRequest) return;
          session.commitRequest = message.requestId;
          const details = await client.commitDetails(message.hash);
          await this.verifyScope(scope);
          if (this.session !== session || session.commitRequest !== message.requestId) return;
          session.details = details;
          await send({ payload: details });
        } else if (type === 'worktreeReviewDiff') {
          const details = session.details;
          const file = details?.hash === message.hash ? details.files.find(candidate => candidate.path === message.path) : undefined;
          if (!file || !details) throw new Error('Select a changed file from the reviewed commit.');
          await this.openDiff(client, message.hash, file.path, file.originalPath, file.status, details);
          await send({});
        }
      }
    } catch (error) {
      await send({ error: error instanceof Error ? error.message : 'Unable to read worktree activity.' });
    }
  }
}
