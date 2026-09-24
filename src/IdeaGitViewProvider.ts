import * as vscode from 'vscode';
import path from 'node:path';
import { FileIconThemeResolver, type WebviewFileIcon } from './FileIconThemeResolver';
import { GitClient } from './git/GitClient';
import type { PullStrategy, RepositorySnapshot } from './git/types';
import { SnapshotCoordinator } from './SnapshotCoordinator';
import { isMessageAllowedOnSurface, KivoViewTypes, type KivoSurface, surfaceForViewType } from './viewLayout';

type WebviewMessage =
  | { type: 'ready'; historyRef?: string }
  | { type: 'refresh' | 'fetch' | 'push' | 'loadMoreCommits' | 'showLog' | 'showChanges' | 'openSettings' }
  | { type: 'setHistoryRef'; branch: string }
  | { type: 'pull'; strategy: PullStrategy }
  | { type: 'commitDetails'; hash: string }
  | { type: 'openDiff'; path: string; originalPath?: string; kind?: string; preview?: boolean }
  | { type: 'openFile'; path: string }
  | { type: 'copyPath'; path: string }
  | { type: 'moveFileToChangelist'; path: string }
  | { type: 'showFileHistory'; path: string }
  | { type: 'showBranchHistory'; branch: string }
  | { type: 'revealInExplorer'; path: string }
  | { type: 'openCommitDiff'; hash: string; path: string; originalPath?: string; kind?: string }
  | { type: 'commit'; message: string; paths: string[] }
  | { type: 'commitAndPush'; message: string; paths: string[] }
  | { type: 'checkout'; branch: string; remote: boolean }
  | { type: 'createBranch'; startPoint: string }
  | { type: 'mergeBranch'; branch: string }
  | { type: 'renameBranch'; branch: string }
  | { type: 'deleteBranch'; branch: string; remote: boolean }
  | { type: 'copyBranchName'; branch: string }
  | { type: 'createTag'; hash: string }
  | { type: 'checkoutRevision'; hash: string }
  | { type: 'copyCommitHash'; hash: string }
  | { type: 'copyCommitSubject'; hash: string }
  | { type: 'createChangelist' }
  | { type: 'renameChangelist'; id: string; name: string }
  | { type: 'deleteChangelist'; id: string; name: string }
  | { type: 'setActiveChangelist'; id: string }
  | { type: 'moveFiles'; paths: string[]; listId: string };
type OperationKind = 'commit' | 'checkout' | 'branch' | 'tag' | 'changelist' | 'move' | 'fetch' | 'pull' | 'push';
type WebviewRepositorySnapshot = RepositorySnapshot & { fileIcons: Record<string, WebviewFileIcon> };
const HISTORY_PAGE_SIZE = 80;

export class IdeaGitViewProvider implements vscode.WebviewViewProvider, vscode.TextDocumentContentProvider, vscode.Disposable {
  static readonly changesViewType = KivoViewTypes.changes;
  static readonly historyViewType = KivoViewTypes.history;
  static readonly revisionScheme = 'ideagit';
  static readonly productName = 'Kivo Git';
  private readonly views = new Map<KivoSurface, vscode.WebviewView>();
  private readonly readyViews = new Set<KivoSurface>();
  private client?: GitClient;
  private refreshTimer?: NodeJS.Timeout;
  private autoFetchTimer?: NodeJS.Timeout;
  private autoFetchPromise?: Promise<void>;
  private debounceTimer?: NodeJS.Timeout;
  private watcher?: vscode.FileSystemWatcher;
  private watchedRoot?: string;
  private operationId = 0;
  private operationRunning = false;
  private lastFetchAttemptAt = 0;
  private lastFetchedAt?: number;
  private syncError?: string;
  private syncGeneration = 0;
  private commitLimit = HISTORY_PAGE_SIZE;
  private historyRef?: string;
  private lastSnapshot?: RepositorySnapshot;
  private pendingHistoryPathFilter?: string;
  private pendingHistoryBranchFilter?: string;
  private pendingChangesReveal?: string;
  private readonly fileIconTheme = new FileIconThemeResolver();
  private fileIconThemeRefresh?: Promise<void>;
  private readonly coordinator = new SnapshotCoordinator(
    () => this.getClient().then((client) => client.snapshot(this.commitLimit, this.historyRef)),
    async (snapshot) => {
      this.lastSnapshot = snapshot;
      this.updateViewTitles(snapshot);
      await this.postSnapshotToReadyViews(snapshot);
    },
    (error) => { void this.showEmpty(error); }
  );
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.context.subscriptions.push(
      vscode.workspace.onDidSaveTextDocument(() => this.scheduleRefresh()),
      vscode.workspace.onDidCreateFiles(() => this.scheduleRefresh()),
      vscode.workspace.onDidDeleteFiles(() => this.scheduleRefresh()),
      vscode.workspace.onDidRenameFiles(() => this.scheduleRefresh()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('ideaGit')) this.configurePolling();
        if (event.affectsConfiguration('workbench.iconTheme')) void this.refreshFileIconTheme();
      }),
      vscode.window.onDidChangeActiveColorTheme(() => void this.refreshFileIconTheme()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.client = undefined;
        this.watchedRoot = undefined;
        this.lastFetchAttemptAt = 0;
        this.lastFetchedAt = undefined;
        this.syncError = undefined;
        this.syncGeneration += 1;
        this.commitLimit = HISTORY_PAGE_SIZE;
        this.historyRef = undefined;
        this.lastSnapshot = undefined;
        this.watcher?.dispose();
        this.coordinator.reset();
        this.configurePolling();
      })
    );
  }

  async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
    const surface = surfaceForViewType(view.viewType);
    if (!surface) throw new Error(`Unsupported Kivo Git view type: ${view.viewType}`);
    this.views.set(surface, view);
    view.title = surface === 'changes' ? 'Commit' : 'History';
    this.readyViews.delete(surface);
    await this.refreshFileIconTheme();
    this.configureWebviewResources(view);
    view.webview.html = this.html(view.webview, surface);
    view.webview.onDidReceiveMessage((message: WebviewMessage) => void this.handle(surface, message));
    view.onDidChangeVisibility(() => this.configurePolling());
    view.onDidDispose(() => {
      if (this.views.get(surface) === view) {
        this.views.delete(surface);
        this.readyViews.delete(surface);
      }
      this.configurePolling();
    });
    this.configurePolling();
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    if (uri.query === 'empty=1') return '';
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) return '';
    const client = await this.getClient();
    const revision = new URLSearchParams(uri.query).get('commit');
    return revision
      ? client.showFileAtRevision(revision, uri.path.replace(/^\//, ''))
      : client.showHeadFile(uri.path.replace(/^\//, ''));
  }

  async refresh(silent = false): Promise<void> {
    if (!this.hasVisibleView()) return;
    this.coordinator.request();
    if (!silent && !vscode.workspace.workspaceFolders?.length) void vscode.window.showInformationMessage(`${IdeaGitViewProvider.productName}: Open a Git repository to start.`);
  }

  async showChanges(): Promise<void> {
    await vscode.commands.executeCommand(`${IdeaGitViewProvider.changesViewType}.focus`);
  }

  async showLog(): Promise<void> {
    await vscode.commands.executeCommand(`${IdeaGitViewProvider.historyViewType}.focus`);
  }

  async openResourceDiff(uri?: vscode.Uri): Promise<void> {
    try {
      const filePath = this.workspaceRelativePath(uri);
      const client = await this.getClient();
      const snapshot = await client.snapshot(this.commitLimit);
      const change = snapshot.changes.find((candidate) => candidate.path === filePath);
      if (!change) {
        void vscode.window.showInformationMessage(`${IdeaGitViewProvider.productName}: ${filePath} has no working tree changes.`);
        return;
      }
      await this.openDiff(change.path, change.originalPath, change.kind, false);
    } catch (error) {
      void vscode.window.showErrorMessage(`${IdeaGitViewProvider.productName}: ${this.errorText(error)}`);
    }
  }

  async showFileHistory(uri?: vscode.Uri): Promise<void> {
    try {
      const filePath = this.workspaceRelativePath(uri);
      this.historyRef = undefined;
      this.pendingHistoryBranchFilter = undefined;
      this.pendingHistoryPathFilter = filePath;
      await this.showLog();
      await this.deliverPendingNavigation('history');
    } catch (error) {
      void vscode.window.showErrorMessage(`${IdeaGitViewProvider.productName}: ${this.errorText(error)}`);
    }
  }

  async showResourceInChanges(uri?: vscode.Uri): Promise<void> {
    try {
      const filePath = this.workspaceRelativePath(uri);
      const snapshot = await (await this.getClient()).snapshot(this.commitLimit);
      if (!snapshot.changes.some((change) => change.path === filePath)) {
        void vscode.window.showInformationMessage(`${IdeaGitViewProvider.productName}: ${filePath} has no working tree changes.`);
        return;
      }
      this.pendingChangesReveal = filePath;
      await this.showChanges();
      await this.deliverPendingNavigation('changes');
    } catch (error) {
      void vscode.window.showErrorMessage(`${IdeaGitViewProvider.productName}: ${this.errorText(error)}`);
    }
  }

  async moveResourceToChangelist(uri?: vscode.Uri): Promise<void> {
    try {
      const filePath = this.workspaceRelativePath(uri);
      await this.moveFileToChangelist(await this.getClient(), filePath);
    } catch (error) {
      void vscode.window.showErrorMessage(`${IdeaGitViewProvider.productName}: ${this.errorText(error)}`);
    }
  }

  private workspaceRelativePath(uri?: vscode.Uri): string {
    const resource = uri ?? vscode.window.activeTextEditor?.document.uri;
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) throw new Error('Open a folder containing a Git repository.');
    if (!resource || resource.scheme !== 'file') throw new Error('Choose a file in the current workspace.');
    const root = path.resolve(workspace.uri.fsPath);
    const resolved = path.resolve(resource.fsPath);
    if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) throw new Error('The selected file is outside the current workspace.');
    return path.relative(root, resolved).split(path.sep).join('/');
  }

  private async deliverPendingNavigation(surface: KivoSurface): Promise<void> {
    if (!this.readyViews.has(surface)) return;
    if (surface === 'history' && this.pendingHistoryPathFilter) {
      const filePath = this.pendingHistoryPathFilter;
      this.pendingHistoryPathFilter = undefined;
      await this.postToView(surface, { type: 'applyPathFilter', path: filePath });
    }
    if (surface === 'history' && this.pendingHistoryBranchFilter !== undefined) {
      const branch = this.pendingHistoryBranchFilter;
      this.pendingHistoryBranchFilter = undefined;
      await this.postToView(surface, { type: 'applyBranchFilter', branch });
    }
    if (surface === 'changes' && this.pendingChangesReveal) {
      const filePath = this.pendingChangesReveal;
      this.pendingChangesReveal = undefined;
      await this.postToView(surface, { type: 'revealFile', path: filePath });
    }
  }

  private async showEmpty(error: unknown): Promise<void> {
    this.client = undefined;
    this.lastSnapshot = undefined;
    this.coordinator.reset();
    await this.postToReadyViews({ type: 'empty', message: this.errorText(error) });
  }

  private hasVisibleView(): boolean {
    return [...this.views.values()].some((view) => view.visible);
  }

  private async postToReadyViews(message: Record<string, unknown>): Promise<void> {
    await Promise.all([...this.readyViews].map(async (surface) => {
      const view = this.views.get(surface);
      if (view) await view.webview.postMessage(message);
    }));
  }

  private async postToView(surface: KivoSurface, message: Record<string, unknown>): Promise<void> {
    if (!this.readyViews.has(surface)) return;
    await this.views.get(surface)?.webview.postMessage(message);
  }

  private async postSnapshotToReadyViews(snapshot: RepositorySnapshot): Promise<void> {
    await Promise.all([...this.readyViews].map((surface) => this.postSnapshotToView(surface, snapshot)));
  }

  private async postSnapshotToView(surface: KivoSurface, snapshot: RepositorySnapshot): Promise<void> {
    if (!this.readyViews.has(surface)) return;
    const view = this.views.get(surface);
    if (!view) return;
    const payload: WebviewRepositorySnapshot = {
      ...snapshot,
      fileIcons: surface === 'changes'
        ? this.fileIconTheme.iconsFor(view.webview, snapshot.changes.map((change) => change.path))
        : {}
    };
    await view.webview.postMessage({ type: 'snapshot', payload });
  }

  private async getClient(): Promise<GitClient> {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) throw new Error('Open a folder containing a Git repository.');
    if (!this.client || this.client.workspaceRoot !== workspace.uri.fsPath) {
      this.client = new GitClient(workspace.uri.fsPath);
      await this.client.initialize();
    }
    if (this.watchedRoot !== workspace.uri.fsPath) this.watch(workspace);
    return this.client;
  }

  private watch(workspace: vscode.WorkspaceFolder): void {
    this.watcher?.dispose();
    this.watchedRoot = workspace.uri.fsPath;
    this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(workspace, '**/*'));
    this.watcher.onDidChange(() => this.scheduleRefresh());
    this.watcher.onDidCreate(() => this.scheduleRefresh());
    this.watcher.onDidDelete(() => this.scheduleRefresh());
  }

  private scheduleRefresh(): void {
    if (!this.hasVisibleView()) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.refresh(true), 180);
  }

  private async handle(surface: KivoSurface, message: WebviewMessage): Promise<void> {
    if (!isMessageAllowedOnSurface(surface, message.type)) {
      await this.postToView(surface, { type: 'notice', phase: 'error', message: 'This action is not available in this Git tool window.' });
      return;
    }
    if (message.type === 'ready') {
      if (surface === 'history' && this.pendingHistoryBranchFilter === undefined && !this.pendingHistoryPathFilter) {
        this.historyRef = message.historyRef || undefined;
      }
      this.readyViews.add(surface);
      await this.setSyncState(this.autoFetchPromise ? 'fetching' : this.syncError ? 'error' : 'idle', undefined, this.syncError);
      if (this.lastSnapshot) await this.postSnapshotToView(surface, this.lastSnapshot);
      await this.deliverPendingNavigation(surface);
      await this.refresh(true);
      return;
    }
    if (message.type === 'refresh') {
      await this.refresh();
      return;
    }
    if (message.type === 'showLog') {
      await this.showLog();
      return;
    }
    if (message.type === 'showChanges') {
      await this.showChanges();
      return;
    }
    if (message.type === 'openSettings') {
      await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:keatonli.idea-git');
      return;
    }
    try {
      const client = await this.getClient();
      switch (message.type) {
        case 'loadMoreCommits':
          this.commitLimit += HISTORY_PAGE_SIZE;
          await this.refresh(true);
          return;
        case 'setHistoryRef':
          this.historyRef = message.branch || undefined;
          this.commitLimit = HISTORY_PAGE_SIZE;
          // A different ref can produce byte-identical commits; still acknowledge the selection.
          this.coordinator.reset();
          await this.refresh(true);
          return;
        case 'commitDetails':
          try {
            await this.postToView(surface, { type: 'commitDetails', payload: await client.commitDetails(message.hash) });
          } catch (error) {
            await this.postToView(surface, { type: 'commitDetailsError', hash: message.hash, message: this.errorText(error) });
          }
          return;
        case 'openDiff':
          await this.openDiff(message.path, message.originalPath, message.kind, message.preview);
          return;
        case 'openFile':
          await this.openFile(message.path);
          return;
        case 'copyPath':
          await vscode.env.clipboard.writeText(message.path);
          await this.postToView(surface, { type: 'notice', phase: 'success', message: 'Relative path copied' });
          return;
        case 'moveFileToChangelist':
          await this.moveFileToChangelist(client, message.path);
          return;
        case 'showFileHistory':
          this.workspaceFileUri(message.path);
          this.historyRef = undefined;
          this.pendingHistoryBranchFilter = undefined;
          this.pendingHistoryPathFilter = message.path;
          await this.showLog();
          await this.deliverPendingNavigation('history');
          return;
        case 'showBranchHistory':
          if (!this.lastSnapshot?.branches.some((branch) => branch.name === message.branch) &&
              !this.lastSnapshot?.tags?.some((tag) => tag.name === message.branch)) {
            throw new Error('The selected branch or tag no longer exists. Refresh and try again.');
          }
          this.pendingHistoryPathFilter = undefined;
          this.historyRef = message.branch;
          this.commitLimit = HISTORY_PAGE_SIZE;
          this.pendingHistoryBranchFilter = message.branch;
          await this.showLog();
          await this.deliverPendingNavigation('history');
          return;
        case 'revealInExplorer':
          await vscode.commands.executeCommand('revealInExplorer', this.workspaceFileUri(message.path));
          return;
        case 'openCommitDiff':
          await this.openCommitDiff(client, message.hash, message.path, message.originalPath, message.kind);
          return;
        case 'commit':
          await this.operation('commit', 'Creating commit…', async () => client.commit(message.message, message.paths), 'Commit created', true);
          return;
        case 'commitAndPush':
          await this.commitAndPush(client, message.message, message.paths);
          return;
        case 'checkout':
          await this.operation('checkout', `Switching to ${message.branch}…`, async () => client.checkout(message.branch, message.remote), `Switched to ${message.branch}`);
          return;
        case 'createBranch':
          await this.createBranch(client, message.startPoint);
          return;
        case 'mergeBranch':
          await this.mergeBranch(client, message.branch);
          return;
        case 'renameBranch':
          await this.renameBranch(client, message.branch);
          return;
        case 'deleteBranch':
          await this.deleteBranch(client, message.branch, message.remote);
          return;
        case 'copyBranchName':
          await vscode.env.clipboard.writeText(message.branch);
          await this.postToView(surface, { type: 'notice', phase: 'success', message: 'Branch name copied' });
          return;
        case 'createTag':
          await this.createTag(client, message.hash);
          return;
        case 'checkoutRevision':
          await this.checkoutRevision(client, message.hash);
          return;
        case 'copyCommitHash':
          if (!/^[0-9a-f]{7,40}$/i.test(message.hash)) throw new Error('Invalid commit hash.');
          await vscode.env.clipboard.writeText(message.hash);
          await this.postToView(surface, { type: 'notice', phase: 'success', message: 'Commit hash copied' });
          return;
        case 'copyCommitSubject': {
          const details = await client.commitDetails(message.hash);
          await vscode.env.clipboard.writeText(details.subject);
          await this.postToView(surface, { type: 'notice', phase: 'success', message: 'Commit subject copied' });
          return;
        }
        case 'createChangelist':
          await this.createChangelist(client);
          return;
        case 'renameChangelist':
          await this.renameChangelist(client, message.id, message.name);
          return;
        case 'deleteChangelist':
          await this.deleteChangelist(client, message.id, message.name);
          return;
        case 'setActiveChangelist':
          await this.operation('changelist', 'Activating changelist…', () => client.setActiveChangelist(message.id), 'Active changelist updated');
          return;
        case 'moveFiles':
          await this.operation('move', 'Moving files…', () => client.moveToChangelist(message.paths, message.listId), 'Files moved');
          return;
        case 'fetch':
          await this.operation('fetch', 'Fetching…', () => client.fetch(), 'Fetch complete');
          return;
        case 'pull':
          await this.operation('pull', `Pulling with ${message.strategy === 'ff-only' ? 'fast-forward only' : message.strategy}…`, () => client.pull(message.strategy), 'Repository updated');
          return;
        case 'push':
          await this.operation('push', 'Pushing…', () => client.push(), 'Push complete');
      }
    } catch (error) {
      const detail = this.errorText(error);
      await this.postToView(surface, { type: 'notice', phase: 'error', message: detail });
      void vscode.window.showErrorMessage(`${IdeaGitViewProvider.productName}: ${detail}`);
    }
  }

  private async createChangelist(client: GitClient): Promise<void> {
    const name = await vscode.window.showInputBox({ title: 'Create Changelist', prompt: 'Changes made afterward will be assigned to this active changelist.', placeHolder: 'Changelist name', validateInput: (value) => value.trim() ? undefined : 'Enter a changelist name.' });
    if (name === undefined) return;
    await this.operation('changelist', 'Creating changelist…', () => client.createChangelist(name), `Created and activated ${name.trim()}`);
  }

  private async createBranch(client: GitClient, startPoint: string): Promise<void> {
    const name = await vscode.window.showInputBox({
      title: 'New Branch',
      prompt: `Create and checkout a new branch from ${startPoint}.`,
      placeHolder: 'feature/my-change',
      ignoreFocusOut: true,
      validateInput: (value) => value.trim() ? undefined : 'Enter a branch name.'
    });
    if (name === undefined) return;
    const branch = name.trim();
    await this.operation('branch', `Creating ${branch} from ${startPoint}…`, () => client.createBranch(branch, startPoint), `Created and switched to ${branch}`);
  }

  private async createTag(client: GitClient, hash: string): Promise<void> {
    const name = await vscode.window.showInputBox({
      title: 'New Tag',
      prompt: `Create a lightweight tag at ${hash.slice(0, 8)}.`,
      placeHolder: 'v1.0.0',
      ignoreFocusOut: true,
      validateInput: (value) => value.trim() ? undefined : 'Enter a tag name.'
    });
    if (name === undefined) return;
    const tag = name.trim();
    await this.operation('tag', `Creating tag ${tag}…`, () => client.createTag(tag, hash), `Created tag ${tag}`);
  }

  private async checkoutRevision(client: GitClient, hash: string): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
      `Checkout commit ${hash.slice(0, 8)} in detached HEAD mode?`,
      { modal: true, detail: 'You can inspect the repository at this revision. Create a branch before committing new work.' },
      'Checkout Revision'
    );
    if (choice !== 'Checkout Revision') return;
    await this.operation('checkout', `Checking out ${hash.slice(0, 8)}…`, () => client.checkoutRevision(hash), `Checked out ${hash.slice(0, 8)}`);
  }

  private async mergeBranch(client: GitClient, branch: string): Promise<void> {
    const current = this.lastSnapshot?.branch || 'the current branch';
    const choice = await vscode.window.showWarningMessage(
      `Merge “${branch}” into “${current}”?`,
      { modal: true, detail: 'Git may stop for conflict resolution if the branches cannot be merged automatically.' },
      'Merge'
    );
    if (choice !== 'Merge') return;
    await this.operation('branch', `Merging ${branch} into ${current}…`, () => client.mergeBranch(branch), `Merged ${branch} into ${current}`);
  }

  private async renameBranch(client: GitClient, currentName: string): Promise<void> {
    const name = await vscode.window.showInputBox({
      title: 'Rename Branch',
      value: currentName,
      valueSelection: [0, currentName.length],
      ignoreFocusOut: true,
      validateInput: (value) => value.trim() ? undefined : 'Enter a branch name.'
    });
    if (name === undefined || name.trim() === currentName) return;
    const nextName = name.trim();
    if (await this.operation('branch', `Renaming ${currentName}…`, () => client.renameBranch(currentName, nextName), `Renamed ${currentName} to ${nextName}`)) {
      await this.retargetHistoryRef(currentName, nextName);
    }
  }

  private async deleteBranch(client: GitClient, branch: string, remote: boolean): Promise<void> {
    const target = remote ? 'remote branch' : 'local branch';
    const detail = remote
      ? 'This deletes the branch from the remote repository for everyone.'
      : 'Only fully merged local branches are deleted. Unmerged work is protected.';
    const choice = await vscode.window.showWarningMessage(
      `Delete ${target} “${branch}”?`,
      { modal: true, detail },
      'Delete Branch'
    );
    if (choice !== 'Delete Branch') return;
    if (await this.operation('branch', `Deleting ${branch}…`, () => client.deleteBranch(branch, remote), `Deleted ${branch}`)) {
      await this.retargetHistoryRef(branch, '');
    }
  }

  private async retargetHistoryRef(previous: string, next: string): Promise<void> {
    if (this.historyRef !== previous) return;
    this.historyRef = next || undefined;
    this.commitLimit = HISTORY_PAGE_SIZE;
    this.coordinator.reset();
    this.pendingHistoryBranchFilter = next;
    await this.deliverPendingNavigation('history');
    await this.refresh(true);
  }

  private async renameChangelist(client: GitClient, id: string, currentName: string): Promise<void> {
    const name = await vscode.window.showInputBox({ title: 'Rename Changelist', value: currentName, valueSelection: [0, currentName.length], validateInput: (value) => value.trim() ? undefined : 'Enter a changelist name.' });
    if (name === undefined || name.trim() === currentName) return;
    await this.operation('changelist', 'Renaming changelist…', () => client.renameChangelist(id, name), `Renamed to ${name.trim()}`);
  }

  private async deleteChangelist(client: GitClient, id: string, name: string): Promise<void> {
    const choice = await vscode.window.showWarningMessage(`Delete changelist “${name}”? Its files will move to Default Changelist.`, { modal: true }, 'Delete');
    if (choice !== 'Delete') return;
    await this.operation('changelist', 'Deleting changelist…', () => client.deleteChangelist(id), 'Changelist deleted');
  }

  private async commitAndPush(client: GitClient, message: string, paths: string[]): Promise<void> {
    const committed = await this.operation('commit', 'Creating commit…', () => client.commit(message, paths), 'Commit created', true);
    if (!committed) return;
    await this.operation('push', 'Pushing new commit…', () => client.push(), 'Commit pushed');
  }

  private async moveFileToChangelist(client: GitClient, filePath: string): Promise<void> {
    const snapshot = await client.snapshot(this.commitLimit);
    const currentList = snapshot.changelists.find((list) => list.changes.some((change) => change.path === filePath));
    if (!currentList) {
      void vscode.window.showInformationMessage(`${IdeaGitViewProvider.productName}: ${filePath} has no working tree changes.`);
      return;
    }
    const options = snapshot.changelists
      .filter((list) => list.id !== currentList?.id)
      .map((list) => ({ label: list.name, description: list.active ? 'Active changelist' : undefined, id: list.id }));
    if (!options.length) {
      void vscode.window.showInformationMessage(`${IdeaGitViewProvider.productName}: Create another changelist before moving this file.`);
      return;
    }
    const target = await vscode.window.showQuickPick(options, {
      title: 'Move to Changelist',
      placeHolder: filePath,
      ignoreFocusOut: true
    });
    if (!target) return;
    await this.operation('move', `Moving ${filePath}…`, () => client.moveToChangelist([filePath], target.id), `Moved to ${target.label}`);
  }

  private async operation(kind: OperationKind, label: string, action: () => Promise<void>, success: string, clearsCommit = false): Promise<boolean> {
    if (this.operationRunning) throw new Error('Another Git operation is already running.');
    this.operationRunning = true;
    const id = ++this.operationId;
    let writeStarted = false;
    await this.postToReadyViews({ type: 'operation', id, kind, phase: 'loading', message: label });
    try {
      if (this.autoFetchPromise) await this.autoFetchPromise;
      this.coordinator.beginWrite();
      writeStarted = true;
      await vscode.window.withProgress({ location: vscode.ProgressLocation.SourceControl, title: `${IdeaGitViewProvider.productName}: ${label}` }, action);
      if (kind === 'fetch' || kind === 'pull' || kind === 'push') await this.setSyncState('idle', Date.now());
      await this.postToReadyViews({ type: 'operation', id, kind, phase: 'success', message: success, clearsCommit });
      return true;
    } catch (error) {
      this.coordinator.reset();
      if (kind === 'fetch' || kind === 'pull' || kind === 'push') await this.setSyncState('error', undefined, this.errorText(error));
      await this.postToReadyViews({ type: 'operation', id, kind, phase: 'error', message: this.errorText(error) });
      return false;
    } finally {
      this.operationRunning = false;
      if (writeStarted) this.coordinator.endWrite();
    }
  }

  private async openDiff(filePath: string, originalPath?: string, kind?: string, preview = false): Promise<void> {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) return;
    const oldUri = vscode.Uri.from({ scheme: IdeaGitViewProvider.revisionScheme, path: `/${originalPath ?? filePath}` });
    const currentUri = kind === 'deleted'
      ? vscode.Uri.from({ scheme: IdeaGitViewProvider.revisionScheme, path: `/${filePath}`, query: 'empty=1' })
      : vscode.Uri.file(path.join(workspace.uri.fsPath, filePath));
    await vscode.commands.executeCommand('vscode.diff', oldUri, currentUri, `${filePath} (HEAD ↔ Working Tree)`, { preview, preserveFocus: preview });
  }

  private async openFile(filePath: string): Promise<void> {
    const file = this.workspaceFileUri(filePath);
    const document = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
  }

  private workspaceFileUri(filePath: string): vscode.Uri {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) throw new Error('Open a folder containing a Git repository.');
    const root = path.resolve(workspace.uri.fsPath);
    const resolved = path.resolve(root, filePath);
    if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) throw new Error('The selected file is outside the workspace.');
    return vscode.Uri.file(resolved);
  }

  private async openCommitDiff(client: GitClient, hash: string, filePath: string, originalPath?: string, kind?: string): Promise<void> {
    const details = await client.commitDetails(hash);
    const parent = details.parents[0];
    const oldUri = kind === 'A' || !parent
      ? vscode.Uri.from({ scheme: IdeaGitViewProvider.revisionScheme, path: `/${originalPath ?? filePath}`, query: 'empty=1' })
      : vscode.Uri.from({ scheme: IdeaGitViewProvider.revisionScheme, path: `/${originalPath ?? filePath}`, query: `commit=${encodeURIComponent(parent)}` });
    const currentUri = kind === 'D'
      ? vscode.Uri.from({ scheme: IdeaGitViewProvider.revisionScheme, path: `/${filePath}`, query: 'empty=1' })
      : vscode.Uri.from({ scheme: IdeaGitViewProvider.revisionScheme, path: `/${filePath}`, query: `commit=${encodeURIComponent(hash)}` });
    await vscode.commands.executeCommand('vscode.diff', oldUri, currentUri, `${filePath} (${hash.slice(0, 8)} · ${details.subject})`, { preview: false });
  }

  private configurePolling(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.autoFetchTimer) clearInterval(this.autoFetchTimer);
    if (!this.hasVisibleView()) return;
    const configuration = vscode.workspace.getConfiguration('ideaGit');
    const interval = configuration.get<number>('autoRefreshInterval', 30000);
    this.refreshTimer = setInterval(() => void this.refresh(true), interval);
    if (configuration.get<boolean>('autoFetch', true)) {
      const autoFetchInterval = configuration.get<number>('autoFetchInterval', 300000);
      this.autoFetchTimer = setInterval(() => void this.autoFetchIfDue(), autoFetchInterval);
      void this.autoFetchIfDue();
    }
    void this.refresh(true);
  }

  private async autoFetchIfDue(): Promise<void> {
    if (this.autoFetchPromise || this.operationRunning || !this.hasVisibleView()) return this.autoFetchPromise;
    const interval = vscode.workspace.getConfiguration('ideaGit').get<number>('autoFetchInterval', 300000);
    if (Date.now() - this.lastFetchAttemptAt < interval) return;
    this.lastFetchAttemptAt = Date.now();
    const generation = this.syncGeneration;
    const task = (async () => {
      await this.setSyncState('fetching');
      this.coordinator.beginWrite();
      try {
        const client = await this.getClient();
        await client.fetch(true);
        if (generation !== this.syncGeneration) return;
        await this.setSyncState('idle', Date.now());
      } catch (error) {
        if (generation !== this.syncGeneration) return;
        await this.setSyncState('error', undefined, this.errorText(error));
      } finally {
        this.coordinator.endWrite();
      }
    })();
    this.autoFetchPromise = task.finally(() => { this.autoFetchPromise = undefined; });
    return this.autoFetchPromise;
  }

  private async setSyncState(phase: 'idle' | 'fetching' | 'error', fetchedAt?: number, error?: string): Promise<void> {
    if (fetchedAt !== undefined) this.lastFetchedAt = fetchedAt;
    this.syncError = error;
    await this.postToReadyViews({ type: 'syncStatus', phase, lastFetchedAt: this.lastFetchedAt, error: this.syncError });
  }

  private updateViewTitles(snapshot: RepositorySnapshot): void {
    const changes = this.views.get('changes');
    if (changes) {
      changes.title = 'Commit';
      changes.description = undefined;
    }
    const history = this.views.get('history');
    if (history) {
      history.title = 'History';
      history.description = snapshot.branch;
    }
  }

  private configureWebviewResources(view: vscode.WebviewView): void {
    const roots = [
      vscode.Uri.joinPath(this.context.extensionUri, 'media'),
      ...this.fileIconTheme.localResourceRoots
    ].filter((uri, index, values) => values.findIndex((candidate) => candidate.toString() === uri.toString()) === index);
    view.webview.options = { enableScripts: true, localResourceRoots: roots };
  }

  private async refreshFileIconTheme(): Promise<void> {
    if (this.fileIconThemeRefresh) return this.fileIconThemeRefresh;
    const refresh = (async () => {
      await this.fileIconTheme.refresh();
      for (const view of this.views.values()) this.configureWebviewResources(view);
      await Promise.all([...this.readyViews].map(async (surface) => {
        const view = this.views.get(surface);
        if (view) await this.postToView(surface, { type: 'fileIconCss', css: this.fileIconTheme.fontCss(view.webview) });
      }));
      if (this.lastSnapshot) await this.postSnapshotToReadyViews(this.lastSnapshot);
    })();
    this.fileIconThemeRefresh = refresh;
    try {
      await refresh;
    } finally {
      if (this.fileIconThemeRefresh === refresh) this.fileIconThemeRefresh = undefined;
    }
  }

  private errorText(error: unknown): string {
    return error instanceof Error ? error.message.replace(/^fatal:\s*/i, '') : String(error);
  }

  private html(webview: vscode.Webview, surface: KivoSurface): string {
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.css'));
    const codiconUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'codicons', 'codicon.css'));
    const graphLayoutUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'graph-layout.js'));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.js'));
    const nonce = Math.random().toString(36).slice(2);
    return `<!doctype html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; font-src ${webview.cspSource}; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';">
        <link rel="stylesheet" href="${codiconUri}">
        <link rel="stylesheet" href="${cssUri}">
        <style id="kivo-file-icon-fonts" nonce="${nonce}">${this.fileIconTheme.fontCss(webview)}</style>
        <title>${IdeaGitViewProvider.productName}</title>
      </head>
      <body class="parity-mode" data-surface="${surface}">
        <svg class="kivo-icon-sprite" aria-hidden="true" focusable="false">
          <symbol id="kivo-graph" viewBox="0 0 24 24"><path d="M5 5v14m0-7h5m0 0 8-6m-8 6 8 6"/><circle cx="5" cy="5" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="18" cy="18" r="2"/></symbol>
          <symbol id="kivo-changes" viewBox="0 0 24 24"><path d="M5 7.5h14M5 12h14M5 16.5h9"/><path d="M4 4.5h16v15H4z"/></symbol>
          <symbol id="kivo-sync" viewBox="0 0 24 24"><path d="M19 8a7.5 7.5 0 0 0-13.2-1.8L4 8.5M5 16a7.5 7.5 0 0 0 13.2 1.8l1.8-2.3"/><path d="M4 4.5v4h4M20 19.5v-4h-4"/></symbol>
          <symbol id="kivo-recovery" viewBox="0 0 24 24"><path d="M4 6.5h16v13H4zM7 6.5V4h10v2.5M7 11h10M7 15h6"/></symbol>
          <symbol id="kivo-conflict" viewBox="0 0 24 24"><path d="m12 4 8 15H4z"/><path d="M12 9v4m0 3h.01"/></symbol>
        </svg>
        <main id="app"></main>
        <div id="toast-region" aria-live="assertive"></div>
        <script nonce="${nonce}" src="${graphLayoutUri}"></script>
        <script nonce="${nonce}" src="${jsUri}"></script>
      </body>
      </html>`;
  }

  dispose(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.autoFetchTimer) clearInterval(this.autoFetchTimer);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.watcher?.dispose();
    this.emitter.dispose();
  }
}
