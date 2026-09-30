import * as vscode from 'vscode';
import path from 'node:path';
import { FileIconThemeResolver, type WebviewFileIcon } from './FileIconThemeResolver';
import { GitClient } from './git/GitClient';
import type { PullStrategy, RepositorySnapshot } from './git/types';
import { SnapshotCoordinator } from './SnapshotCoordinator';
import { PushReviewSession } from './PushReviewSession';
import { isMessageAllowedOnSurface, KivoViewTypes, type KivoSurface, surfaceForViewType } from './viewLayout';

type WebviewMessage =
  | { type: 'ready'; historyRef?: string }
  | { type: 'refresh' | 'fetch' | 'push' | 'loadMoreCommits' | 'showLog' | 'showChanges' | 'openSettings' }
  | { type: 'setHistoryRef'; branch: string }
  | { type: 'searchHistory'; requestId: number; filters: { query?: string; author?: string; age?: string; path?: string; ref?: string }; limit: number }
  | { type: 'pull'; strategy: PullStrategy }
  | { type: 'respondPushReview'; id: number; root: string; choice: 'push' | 'cancel' | 'fetch' }
  | { type: 'commitDetails'; hash: string }
  | { type: 'recentCommitDetails'; hash: string; root: string; requestId: number }
  | { type: 'openRecentCommitDiff'; hash: string; root: string; path: string; originalPath?: string; kind?: string }
  | { type: 'showRecentCommit'; hash: string }
  | { type: 'openDiff'; path: string; originalPath?: string; kind?: string; preview?: boolean }
  | { type: 'openStagedDiff' | 'openUnstagedDiff'; path: string }
  | { type: 'openFile'; path: string }
  | { type: 'copyPath'; path: string }
  | { type: 'moveFileToChangelist'; path: string }
  | { type: 'moveSelectedFilesToChangelist'; paths: string[] }
  | { type: 'rollbackFiles'; paths: string[] }
  | { type: 'showFileHistory'; path: string }
  | { type: 'showBranchHistory'; branch: string }
  | { type: 'revealInExplorer'; path: string }
  | { type: 'openCommitDiff'; hash: string; path: string; originalPath?: string; kind?: string }
  | { type: 'commit'; message: string; paths: string[] }
  | { type: 'commitAndPush'; message: string; paths: string[] }
  | { type: 'reuseCommitMessage'; draft: string }
  | { type: 'configureGitIdentity' | 'configureUpstream' }
  | { type: 'chooseRepository' }
  | { type: 'checkout'; branch: string; remote: boolean }
  | { type: 'createBranch'; startPoint: string }
  | { type: 'mergeBranch'; branch: string }
  | { type: 'updateBranch'; branch: string }
  | { type: 'pushBranch'; branch: string }
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
type OperationKind = 'commit' | 'checkout' | 'branch' | 'tag' | 'changelist' | 'move' | 'rollback' | 'fetch' | 'pull' | 'push' | 'identity';
type WebviewRepositorySnapshot = RepositorySnapshot & { fileIcons: Record<string, WebviewFileIcon>; repositoryCount: number; allRepositoryChanges: number };
const HISTORY_PAGE_SIZE = 80;

export class IdeaGitViewProvider implements vscode.WebviewViewProvider, vscode.TextDocumentContentProvider, vscode.Disposable {
  static readonly changesViewType = KivoViewTypes.changes;
  static readonly historyViewType = KivoViewTypes.history;
  static readonly revisionScheme = 'ideagit';
  static readonly productName = 'Kivo Git';
  private readonly views = new Map<KivoSurface, vscode.WebviewView>();
  private readonly readyViews = new Set<KivoSurface>();
  private client?: GitClient;
  private selectedWorkspaceRoot?: string;
  private repositories: vscode.WorkspaceFolder[] = [];
  private repositoriesLoading?: Promise<void>;
  private readonly gitStateListeners = new Map<string, vscode.Disposable>();
  private badgeCount = 0;
  private badgeCounts = new Map<string, number>();
  private badgeRefreshPromise?: Promise<void>;
  private badgeRefreshQueued = false;
  private badgeRefreshTimer?: NodeJS.Timeout;
  private readonly badgePollTimer: NodeJS.Timeout;
  private refreshTimer?: NodeJS.Timeout;
  private autoFetchTimer?: NodeJS.Timeout;
  private autoFetchPromise?: Promise<void>;
  private debounceTimer?: NodeJS.Timeout;
  private watcher?: vscode.FileSystemWatcher;
  private watchedRoot?: string;
  private operationId = 0;
  private operationRunning = false;
  private readonly pushReview = new PushReviewSession();
  private pushPreviewRequestId = 0;
  private lastFetchAttemptAt = 0;
  private lastFetchedAt?: number;
  private syncError?: string;
  private syncGeneration = 0;
  private commitLimit = HISTORY_PAGE_SIZE;
  private historyRef?: string;
  private lastSnapshot?: RepositorySnapshot;
  private pendingHistoryPathFilter?: string;
  private pendingHistoryBranchFilter?: string;
  private pendingHistoryCommitHash?: string;
  private pendingChangesReveal?: string;
  private readonly fileIconTheme = new FileIconThemeResolver();
  private fileIconThemeRefresh?: Promise<void>;
  private readonly coordinator = new SnapshotCoordinator(
    () => this.getClient().then((client) => client.snapshot(this.commitLimit, this.historyRef)),
    async (snapshot) => {
      this.lastSnapshot = snapshot;
      this.updateViewTitles(snapshot);
      await this.postSnapshotToReadyViews(snapshot);
      await this.deliverPendingNavigation('history');
      if (this.hasVisibleView() && vscode.workspace.getConfiguration('ideaGit').get<boolean>('autoFetch', true)) void this.autoFetchIfDue();
    },
    (error) => { void this.showEmpty(error); }
  );
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  private readonly repositoryEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeRepository = this.repositoryEmitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.context.subscriptions.push(
      vscode.workspace.onDidSaveTextDocument(() => { this.scheduleRefresh(40); this.scheduleBadgeRefresh(); }),
      vscode.workspace.onDidCreateFiles(() => { this.scheduleRefresh(); this.scheduleBadgeRefresh(); }),
      vscode.workspace.onDidDeleteFiles(() => { this.scheduleRefresh(); this.scheduleBadgeRefresh(); }),
      vscode.workspace.onDidRenameFiles(() => { this.scheduleRefresh(); this.scheduleBadgeRefresh(); }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('ideaGit')) this.configurePolling();
        if (event.affectsConfiguration('workbench.iconTheme')) void this.refreshFileIconTheme();
      }),
      vscode.window.onDidChangeActiveColorTheme(() => void this.refreshFileIconTheme()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        void this.discoverRepositories();
        this.resetRepository();
        void this.postToReadyViews({ type: 'empty', message: 'Loading selected repository…' });
        this.configurePolling();
        void this.preloadSnapshot();
        this.scheduleBadgeRefresh();
      })
    );
    this.badgePollTimer = setInterval(() => void this.refreshBadge(), 30000);
    void this.refreshBadge();
    void this.preloadSnapshot();
    void this.refreshFileIconTheme();
  }

  async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
    await Promise.all([this.discoverRepositories(), this.refreshFileIconTheme()]);
    const surface = surfaceForViewType(view.viewType);
    if (!surface) throw new Error(`Unsupported Kivo Git view type: ${view.viewType}`);
    this.views.set(surface, view);
    view.title = surface === 'changes' ? 'Commit' : 'History';
    if (surface === 'changes') this.updateBadge();
    this.readyViews.delete(surface);
    this.configureWebviewResources(view);
    view.webview.html = this.html(view.webview, surface);
    view.webview.onDidReceiveMessage((message: WebviewMessage) => void this.handle(surface, message));
    view.onDidChangeVisibility(() => this.configurePolling());
    view.onDidDispose(() => {
      if (this.views.get(surface) === view) {
        this.views.delete(surface);
        this.readyViews.delete(surface);
        if (this.pushReview.current?.surface === surface) this.pushReview.clear();
      }
      this.configurePolling();
    });
    this.configurePolling();
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    await this.discoverRepositories();
    const parameters = new URLSearchParams(uri.query);
    if (parameters.get('empty') === '1') return '';
    const root = parameters.get('repo');
    const workspace = root
      ? this.availableRepositories().find((folder) => folder.uri.fsPath === root)
      : this.selectedWorkspace();
    if (!workspace) return '';
    const client = workspace.uri.fsPath === this.selectedWorkspace()?.uri.fsPath
      ? await this.getClient()
      : new GitClient(workspace.uri.fsPath);
    if (parameters.get('index') === '1') return client.showIndexFile(uri.path.replace(/^\//, ''));
    const revision = parameters.get('commit');
    return revision
      ? client.showFileAtRevision(revision, uri.path.replace(/^\//, ''))
      : client.showHeadFile(uri.path.replace(/^\//, ''));
  }

  async refresh(silent = false): Promise<void> {
    if (!silent) await this.autoFetchIfDue(true);
    this.coordinator.request();
    if (!silent && !this.availableRepositories().length) void vscode.window.showInformationMessage(`${IdeaGitViewProvider.productName}: Open a Git repository to start.`);
  }

  private async preloadSnapshot(): Promise<void> {
    await this.discoverRepositories();
    if (this.availableRepositories().length) this.coordinator.request();
  }

  async showChanges(): Promise<void> {
    await vscode.commands.executeCommand(`${IdeaGitViewProvider.changesViewType}.focus`);
  }

  async showLog(): Promise<void> {
    await vscode.commands.executeCommand(`${IdeaGitViewProvider.historyViewType}.focus`);
  }

  async openResourceDiff(uri?: vscode.Uri): Promise<void> {
    try {
      const filePath = await this.workspaceRelativePath(uri);
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
      const filePath = await this.workspaceRelativePath(uri);
      this.historyRef = undefined;
      this.pendingHistoryBranchFilter = undefined;
      this.pendingHistoryPathFilter = filePath;
      await this.showLog();
      await this.deliverPendingNavigation('history');
    } catch (error) {
      void vscode.window.showErrorMessage(`${IdeaGitViewProvider.productName}: ${this.errorText(error)}`);
    }
  }

  async showCommitInHistory(hash: string, uri?: vscode.Uri): Promise<void> {
    try {
      if (!/^[0-9a-f]{40}$/i.test(hash)) throw new Error('The Blame commit hash is invalid.');
      if (uri) await this.workspaceRelativePath(uri);
      this.historyRef = undefined;
      this.commitLimit = HISTORY_PAGE_SIZE;
      this.lastSnapshot = undefined;
      this.coordinator.reset();
      this.pendingHistoryBranchFilter = undefined;
      this.pendingHistoryPathFilter = undefined;
      this.pendingHistoryCommitHash = hash;
      await this.showLog();
      await this.refresh(true);
      await this.deliverPendingNavigation('history');
    } catch (error) {
      void vscode.window.showErrorMessage(`${IdeaGitViewProvider.productName}: ${this.errorText(error)}`);
    }
  }

  async showResourceInChanges(uri?: vscode.Uri): Promise<void> {
    try {
      const filePath = await this.workspaceRelativePath(uri);
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
      const filePath = await this.workspaceRelativePath(uri);
      await this.moveFileToChangelist(await this.getClient(), filePath);
    } catch (error) {
      void vscode.window.showErrorMessage(`${IdeaGitViewProvider.productName}: ${this.errorText(error)}`);
    }
  }

  private async workspaceRelativePath(uri?: vscode.Uri): Promise<string> {
    await this.discoverRepositories();
    const resource = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!resource || resource.scheme !== 'file') throw new Error('Choose a file in the current workspace.');
    const resolved = path.resolve(resource.fsPath);
    const workspace = this.availableRepositories()
      .filter((candidate) => resolved.startsWith(`${path.resolve(candidate.uri.fsPath)}${path.sep}`))
      .sort((left, right) => right.uri.fsPath.length - left.uri.fsPath.length)[0];
    if (!workspace) throw new Error('The selected file is outside the open workspaces.');
    this.selectWorkspace(workspace);
    const root = path.resolve(workspace.uri.fsPath);
    if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) throw new Error('The selected file is outside the current workspace.');
    return path.relative(root, resolved).split(path.sep).join('/');
  }

  private async deliverPendingNavigation(surface: KivoSurface): Promise<void> {
    if (!this.readyViews.has(surface) || !this.lastSnapshot) return;
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
    if (surface === 'history' && this.pendingHistoryCommitHash) {
      const hash = this.pendingHistoryCommitHash;
      this.pendingHistoryCommitHash = undefined;
      await this.postToView(surface, { type: 'revealCommit', hash });
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
    this.badgeCounts.set(snapshot.root, snapshot.changes.length);
    this.badgeCount = [...this.badgeCounts.values()].reduce((total, count) => total + count, 0);
    this.updateBadge();
    await Promise.all([...this.readyViews].map((surface) => this.postSnapshotToView(surface, snapshot)));
  }

  private updateBadge(): void {
    const view = this.views.get('changes');
    if (view) view.badge = this.badgeCount ? {
      value: this.badgeCount,
      tooltip: `${this.badgeCount} uncommitted ${this.badgeCount === 1 ? 'file' : 'files'} across all Git repositories. The Commit view shows the selected repository.`
    } : undefined;
  }

  private scheduleBadgeRefresh(): void {
    if (this.badgeRefreshTimer) clearTimeout(this.badgeRefreshTimer);
    this.badgeRefreshTimer = setTimeout(() => {
      this.badgeRefreshTimer = undefined;
      void this.refreshBadge();
    }, 180);
  }

  private async refreshBadge(): Promise<void> {
    if (this.badgeRefreshPromise) {
      this.badgeRefreshQueued = true;
      return this.badgeRefreshPromise;
    }
    const task = (async () => {
      await this.discoverRepositories();
      const roots = [...new Set(this.availableRepositories().map((repository) => repository.uri.fsPath))];
      if (!roots.length) {
        this.badgeCount = 0;
        this.badgeCounts.clear();
        this.updateBadge();
        return;
      }
      const counts = await Promise.allSettled(roots.map((root) => new GitClient(root).changedFilesCount()));
      // Keep the last complete count if a repository is temporarily unavailable.
      if (counts.some((result) => result.status === 'rejected')) return;
      const previousCount = this.badgeCount;
      this.badgeCounts = new Map(roots.map((root, index) => [root, counts[index]?.status === 'fulfilled' ? counts[index].value : 0]));
      this.badgeCount = counts.reduce((total, result) => total + (result.status === 'fulfilled' ? result.value : 0), 0);
      this.updateBadge();
      if (this.lastSnapshot && this.badgeCount !== previousCount) {
        await Promise.all([...this.readyViews].map((surface) => this.postSnapshotToView(surface, this.lastSnapshot!)));
      }
    })();
    this.badgeRefreshPromise = task;
    try {
      await task;
    } finally {
      this.badgeRefreshPromise = undefined;
      if (this.badgeRefreshQueued) {
        this.badgeRefreshQueued = false;
        this.scheduleBadgeRefresh();
      }
    }
  }

  private async postSnapshotToView(surface: KivoSurface, snapshot: RepositorySnapshot): Promise<void> {
    if (!this.readyViews.has(surface)) return;
    const view = this.views.get(surface);
    if (!view) return;
    const payload: WebviewRepositorySnapshot = {
      ...snapshot,
      repositoryCount: this.availableRepositories().length,
      allRepositoryChanges: this.badgeCount,
      fileIcons: surface === 'changes'
        ? this.fileIconTheme.iconsFor(view.webview, snapshot.changes.map((change) => change.path))
        : {}
    };
    await view.webview.postMessage({ type: 'snapshot', payload });
  }

  private async getClient(): Promise<GitClient> {
    await this.discoverRepositories();
    const workspace = this.selectedWorkspace();
    if (!workspace) throw new Error('Open a folder containing a Git repository.');
    if (!this.client || this.client.workspaceRoot !== workspace.uri.fsPath) {
      this.client = new GitClient(workspace.uri.fsPath);
      await this.client.initialize();
    }
    if (this.watchedRoot !== workspace.uri.fsPath) this.watch(workspace);
    return this.client;
  }

  private selectedWorkspace(): vscode.WorkspaceFolder | undefined {
    return this.availableRepositories().find((folder) => folder.uri.fsPath === this.selectedWorkspaceRoot)
      || this.availableRepositories()[0];
  }

  private availableRepositories(): vscode.WorkspaceFolder[] {
    return this.repositories.length ? this.repositories : [...(vscode.workspace.workspaceFolders || [])];
  }

  private async discoverRepositories(): Promise<void> {
    if (this.repositoriesLoading) return this.repositoriesLoading;
    this.repositoriesLoading = (async () => {
      type GitRepository = { rootUri: vscode.Uri; state?: { onDidChange: vscode.Event<void> } };
      type GitApi = {
        repositories: GitRepository[];
        onDidOpenRepository: vscode.Event<GitRepository>;
        onDidCloseRepository: vscode.Event<GitRepository>;
      };
      const extension = vscode.extensions.getExtension<{ getAPI(version: 1): GitApi }>('vscode.git');
      if (!extension) return;
      const api = (await extension.activate()).getAPI(1);
      const update = () => {
        const previous = this.repositories.map((repository) => repository.uri.fsPath).join('\0');
        const gitRepositories = api.repositories.filter((repository) => repository.rootUri.scheme === 'file');
        const roots = new Set(gitRepositories.map((repository) => repository.rootUri.fsPath));
        for (const [root, listener] of this.gitStateListeners) {
          if (!roots.has(root)) {
            listener.dispose();
            this.gitStateListeners.delete(root);
          }
        }
        for (const repository of gitRepositories) {
          const root = repository.rootUri.fsPath;
          if (this.gitStateListeners.has(root) || !repository.state?.onDidChange) continue;
          this.gitStateListeners.set(root, repository.state.onDidChange(() => {
            if (this.selectedWorkspace()?.uri.fsPath === root) this.scheduleRefresh(80);
          }));
        }
        this.repositories = gitRepositories
          .map((repository, index) => ({ uri: repository.rootUri, name: path.basename(repository.rootUri.fsPath), index }));
        if (previous === this.repositories.map((repository) => repository.uri.fsPath).join('\0')) return;
        if (this.selectedWorkspaceRoot && !this.availableRepositories().some((repository) => repository.uri.fsPath === this.selectedWorkspaceRoot)) {
          this.selectedWorkspaceRoot = undefined;
          this.resetRepository();
        }
        void this.refresh(true);
        this.scheduleBadgeRefresh();
      };
      this.context.subscriptions.push(api.onDidOpenRepository(update), api.onDidCloseRepository(update));
      update();
    })().catch(() => { /* Fall back to the workspace folders when Git is unavailable. */ });
    return this.repositoriesLoading;
  }

  private selectWorkspace(workspace: vscode.WorkspaceFolder): void {
    if (workspace.uri.fsPath === this.selectedWorkspace()?.uri.fsPath) return;
    if (this.operationRunning) throw new Error('Finish the current Git operation before switching repositories.');
    this.selectedWorkspaceRoot = workspace.uri.fsPath;
    this.resetRepository();
    void this.postToReadyViews({ type: 'empty', message: 'Loading selected repository…' });
    this.configurePolling();
    if (!this.hasVisibleView()) void this.refresh(true);
  }

  private resetRepository(): void {
    this.pushReview.clear();
    this.pushPreviewRequestId++;
    this.client = undefined;
    this.watcher?.dispose();
    this.watchedRoot = undefined;
    this.lastSnapshot = undefined;
    this.lastFetchAttemptAt = 0;
    this.lastFetchedAt = undefined;
    this.syncError = undefined;
    this.syncGeneration += 1;
    this.commitLimit = HISTORY_PAGE_SIZE;
    this.historyRef = undefined;
    this.pendingHistoryPathFilter = undefined;
    this.pendingHistoryBranchFilter = undefined;
    this.pendingHistoryCommitHash = undefined;
    this.pendingChangesReveal = undefined;
    this.coordinator.reset();
  }

  private async chooseRepository(): Promise<void> {
    await this.discoverRepositories();
    const folders = this.availableRepositories();
    if (folders.length < 2) return;
    const selected = await vscode.window.showQuickPick(folders.map((folder) => ({
      label: folder.name,
      description: `${this.badgeCounts.get(folder.uri.fsPath) ?? '—'} changed files`,
      detail: folder.uri.fsPath,
      folder
    })), { title: 'Choose Kivo Git Repository', placeHolder: 'Select a detected Git repository' });
    if (!selected) return;
    try {
      this.selectWorkspace(selected.folder);
    } catch (error) {
      await this.postToReadyViews({ type: 'notice', phase: 'error', message: this.errorText(error) });
    }
  }

  private watch(workspace: vscode.WorkspaceFolder): void {
    this.watcher?.dispose();
    this.watchedRoot = workspace.uri.fsPath;
    this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(workspace, '**/*'));
    const onChange = (uri: vscode.Uri) => {
      // Snapshot reads acquire a changelist lock. Watching that lock would make
      // every snapshot trigger another snapshot indefinitely.
      if (!this.client?.isChangelistStorageFile(uri.fsPath)) {
        this.scheduleRefresh();
        this.scheduleBadgeRefresh();
      }
    };
    this.watcher.onDidChange(onChange);
    this.watcher.onDidCreate(onChange);
    this.watcher.onDidDelete(onChange);
  }

  private refreshDueAt?: number;

  private scheduleRefresh(delay = 140): void {
    const dueAt = Date.now() + delay;
    if (this.debounceTimer && this.refreshDueAt !== undefined && this.refreshDueAt <= dueAt) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.refreshDueAt = dueAt;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      this.refreshDueAt = undefined;
      void this.refresh(true);
    }, Math.max(0, dueAt - Date.now()));
  }

  private async handle(surface: KivoSurface, message: WebviewMessage): Promise<void> {
    if (!isMessageAllowedOnSurface(surface, message.type)) {
      await this.postToView(surface, { type: 'notice', phase: 'error', message: 'This action is not available in this Git tool window.' });
      return;
    }
    if (message.type === 'ready') {
      if (surface === 'history' && this.pendingHistoryBranchFilter === undefined && !this.pendingHistoryPathFilter && !this.pendingHistoryCommitHash) {
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
    if (message.type === 'showRecentCommit') {
      if (![...(this.lastSnapshot?.recentCommits || []), ...(this.lastSnapshot?.commits || [])].some((commit) => commit.hash === message.hash)) return;
      this.pendingHistoryCommitHash = message.hash;
      await this.showLog();
      await this.deliverPendingNavigation('history');
      return;
    }
    if (message.type === 'showChanges') {
      await this.showChanges();
      return;
    }
    if (message.type === 'chooseRepository') {
      await this.chooseRepository();
      return;
    }
    if (message.type === 'openSettings') {
      await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:KeatonLi.kivo-git');
      return;
    }
    try {
      const client = await this.getClient();
      switch (message.type) {
        case 'searchHistory': {
          const requestId = Number(message.requestId);
          if (!Number.isSafeInteger(requestId) || requestId < 0) return;
          const root = client.workspaceRoot;
          const filters = message.filters || {};
          try {
            const result = await client.searchCommits({
              query: String(filters.query || '').slice(0, 300), author: String(filters.author || '').slice(0, 200),
              age: String(filters.age || ''), path: String(filters.path || '').slice(0, 300), ref: String(filters.ref || '')
            }, Math.max(1, Number(message.limit) || HISTORY_PAGE_SIZE));
            if (this.selectedWorkspace()?.uri.fsPath === root) await this.postToView(surface, { type: 'historySearchResults', requestId, root, ...result });
          } catch (error) {
            await this.postToView(surface, { type: 'historySearchError', requestId, root, message: this.errorText(error) });
          }
          return;
        }
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
        case 'recentCommitDetails': {
          if (message.root !== this.lastSnapshot?.root || this.selectedWorkspace()?.uri.fsPath !== client.workspaceRoot ||
              !this.lastSnapshot?.recentCommits?.some((commit) => commit.hash === message.hash) ||
              !Number.isSafeInteger(message.requestId) || message.requestId < 0) return;
          const root = message.root;
          try {
            const details = await client.commitDetails(message.hash);
            if (this.lastSnapshot?.root !== root || this.selectedWorkspace()?.uri.fsPath !== client.workspaceRoot) return;
            const view = this.views.get(surface);
            await this.postToView(surface, { type: 'recentCommitDetails', root, requestId: message.requestId,
              payload: { ...details, fileIcons: view ? this.fileIconTheme.iconsFor(view.webview, details.files.map((file) => file.path)) : {} } });
          } catch (error) {
            await this.postToView(surface, { type: 'recentCommitDetailsError', root, requestId: message.requestId, hash: message.hash, message: this.errorText(error) });
          }
          return;
        }
        case 'openRecentCommitDiff':
          if (message.root !== this.lastSnapshot?.root || this.selectedWorkspace()?.uri.fsPath !== client.workspaceRoot ||
              !this.lastSnapshot?.recentCommits?.some((commit) => commit.hash === message.hash)) return;
          await this.openCommitDiff(client, message.hash, message.path, message.originalPath, message.kind);
          return;
        case 'commitDetails':
          try {
            const details = await client.commitDetails(message.hash);
            const view = this.views.get(surface);
            await this.postToView(surface, {
              type: 'commitDetails',
              payload: {
                ...details,
                fileIcons: view ? this.fileIconTheme.iconsFor(view.webview, details.files.map((file) => file.path)) : {}
              }
            });
          } catch (error) {
            await this.postToView(surface, { type: 'commitDetailsError', hash: message.hash, message: this.errorText(error) });
          }
          return;
        case 'openDiff':
          await this.openDiff(message.path, message.originalPath, message.kind, message.preview);
          return;
        case 'openStagedDiff':
          await this.openPartialDiff(message.path, 'staged');
          return;
        case 'openUnstagedDiff':
          await this.openPartialDiff(message.path, 'unstaged');
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
        case 'moveSelectedFilesToChangelist':
          await this.chooseChangelistForFiles(client, message.paths);
          return;
        case 'rollbackFiles':
          await this.rollbackFiles(client, message.paths);
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
          await this.commitAndPush(client, message.message, message.paths, surface);
          return;
        case 'reuseCommitMessage':
          await this.reuseCommitMessage(client, message.draft);
          return;
        case 'configureGitIdentity':
          await this.configureGitIdentity(client);
          return;
        case 'configureUpstream': {
          const remoteBranches = (this.lastSnapshot?.branches || []).filter((branch) => branch.remote);
          if (!remoteBranches.length) {
            void vscode.window.showInformationMessage('No remote branches found. Add a remote or Fetch, then try again.');
            return;
          }
          const current = this.lastSnapshot?.branch || '';
          const choice = await vscode.window.showQuickPick(remoteBranches.map((branch) => ({
            label: branch.name,
            description: branch.name.endsWith(`/${current}`) ? 'Same branch name' : undefined
          })), { title: `Track a remote branch from ${current}`, placeHolder: 'Choose the remote branch to pull from and push to' });
          if (choice) await this.operation('branch', 'Setting tracking branch…', () => client.setUpstream(choice.label), `Tracking ${choice.label}`);
          return;
        }
        case 'checkout':
          await this.operation('checkout', `Switching to ${message.branch}…`, async () => client.checkout(message.branch, message.remote), `Switched to ${message.branch}`);
          return;
        case 'createBranch':
          await this.createBranch(client, message.startPoint);
          return;
        case 'mergeBranch':
          await this.mergeBranch(client, message.branch);
          return;
        case 'updateBranch':
          await this.operation('branch', `Updating ${message.branch}…`, () => client.updateLocalBranch(message.branch), `${message.branch} updated from its remote`);
          return;
        case 'pushBranch':
          await this.pushWithPreview(client, surface, false, message.branch);
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
          await this.pushWithPreview(client, surface);
          return;
        case 'respondPushReview':
          await this.respondPushReview(client, surface, message);
          return;
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

  private async commitAndPush(client: GitClient, message: string, paths: string[], surface: KivoSurface): Promise<void> {
    const committed = await this.operation('commit', 'Creating commit…', () => client.commit(message, paths), 'Commit created', true);
    if (!committed) return;
    try {
      if (!await this.pushWithPreview(client, surface, true)) {
        void vscode.window.showInformationMessage('The commit is saved locally. You can push it later from Kivo Git.');
      }
    } catch (error) {
      void vscode.window.showWarningMessage(`The commit is saved locally, but push could not start: ${this.errorText(error)}`);
    }
  }

  private async pushWithPreview(client: GitClient, surface: KivoSurface, afterCommit = false, branch?: string): Promise<boolean> {
    if (this.operationRunning) return false;
    const requestId = ++this.pushPreviewRequestId;
    const generation = this.syncGeneration;
    const previous = this.pushReview.current;
    this.pushReview.clear();
    if (previous) await this.postToView(previous.surface, { type: 'pushReviewClosed', id: previous.id });
    const preview = branch ? await client.pushBranchPreview(branch) : await client.pushPreview();
    if (requestId !== this.pushPreviewRequestId || generation !== this.syncGeneration || this.selectedWorkspace()?.uri.fsPath !== client.workspaceRoot) return false;
    if (!preview.ahead) {
      void vscode.window.showInformationMessage('There are no outgoing commits to push.');
      return false;
    }
    const review = this.pushReview.open({ surface, root: client.workspaceRoot, preview, afterCommit, branch });
    await this.postToView(surface, { type: 'pushReview', ...review });
    return true;
  }

  private async respondPushReview(client: GitClient, surface: KivoSurface, message: Extract<WebviewMessage, { type: 'respondPushReview' }>): Promise<void> {
    if (!['push', 'cancel', 'fetch'].includes(message.choice) || message.root !== client.workspaceRoot) return;
    const review = this.pushReview.take(message.id, surface, client.workspaceRoot);
    if (!review) return;
    await this.postToView(surface, { type: 'pushReviewClosed', id: review.id });
    if (message.choice === 'cancel') return;
    if (this.selectedWorkspace()?.uri.fsPath !== client.workspaceRoot) return;
    if (message.choice === 'fetch') { await this.fetchAndReview(client); return; }
    if (review.preview.behind || review.rejection) return;
    const { preview, branch } = review;
    const pushed = await this.operation('push', 'Pushing…', () => branch ? client.pushBranch(branch, preview) : client.push(preview), 'Push complete');
    if (!pushed && /rejected|non-fast-forward|fetch first|failed to push/i.test(this.syncError || '')) {
      if (this.selectedWorkspace()?.uri.fsPath !== client.workspaceRoot) return;
      const rejected = this.pushReview.open({ ...review, rejection: 'The remote rejected this push. Fetch the latest commits and review the branch before pushing again.' });
      await this.postToView(surface, { type: 'pushReview', ...rejected });
    }
  }

  private async fetchAndReview(client: GitClient): Promise<void> {
    if (await this.operation('fetch', 'Fetching remote updates…', () => client.fetch(), 'Remote updates fetched')) {
      await this.showLog();
    }
  }

  private async moveFileToChangelist(client: GitClient, filePath: string): Promise<void> {
    await this.chooseChangelistForFiles(client, [filePath]);
  }

  private async reuseCommitMessage(client: GitClient, draft: string): Promise<void> {
    const commits = await client.recentCommitMessages();
    if (!commits.length) {
      void vscode.window.showInformationMessage('No commit messages on the current branch yet.');
      return;
    }
    const selected = await vscode.window.showQuickPick(commits.map((commit) => ({
      label: commit.subject,
      description: commit.hash.slice(0, 8),
      hash: commit.hash
    })), { title: 'Reuse Commit Message', placeHolder: 'Choose a recent commit on the current branch' });
    if (!selected) return;
    if (draft.trim()) {
      const choice = await vscode.window.showWarningMessage('Replace the current commit message draft?', { modal: true }, 'Replace Draft');
      if (choice !== 'Replace Draft') return;
    }
    const details = await client.commitDetails(selected.hash);
    await this.postToView('changes', { type: 'reuseCommitMessage', body: details.body, expectedDraft: draft });
  }

  private async rollbackFiles(client: GitClient, paths: string[]): Promise<void> {
    const uniquePaths = Array.isArray(paths) ? [...new Set(paths)] : [];
    if (!uniquePaths.length || uniquePaths.some((filePath) => typeof filePath !== 'string' || !filePath || filePath.includes('\0'))) {
      throw new Error('Select changed files to roll back.');
    }
    const root = path.resolve(client.workspaceRoot);
    const snapshot = await client.snapshot(this.commitLimit);
    const changesByPath = new Map(snapshot.changes.map((change) => [change.path, change]));
    const selected = uniquePaths.map((filePath) => {
      const change = changesByPath.get(filePath);
      if (!change) throw new Error(`The selected file is no longer changed: ${filePath}. Refresh and try again.`);
      return change;
    });
    const fileUris = selected.map((change) => {
      const resolved = path.resolve(root, change.path);
      if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error('The selected file is outside the repository.');
      return vscode.Uri.file(resolved);
    });
    const fileState = async (uri: vscode.Uri): Promise<string> => {
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        return `${stat.type}:${stat.size}:${stat.mtime}`;
      } catch (error) {
        if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') return 'missing';
        throw error;
      }
    };
    const expectedFileStates = await Promise.all(fileUris.map(fileState));
    const newFiles = selected.filter((change) => change.kind === 'untracked' || change.indexStatus === 'A' && change.kind !== 'conflict');
    const existing = selected.filter((change) => !newFiles.includes(change));
    const detail = [
      ...(existing.length ? [`Restore ${existing.length} tracked ${existing.length === 1 ? 'file' : 'files'} to HEAD, including staged changes:`, ...existing.map((change) => `  ${change.path}`)] : []),
      ...(newFiles.length ? [`Move ${newFiles.length} new ${newFiles.length === 1 ? 'file' : 'files'} to Trash:`, ...newFiles.map((change) => `  ${change.path}`)] : []),
      '', 'This will discard the selected working changes. Other files stay untouched.'
    ].join('\n');
    const choice = await vscode.window.showWarningMessage(
      `Rollback ${selected.length} selected ${selected.length === 1 ? 'file' : 'files'}?`,
      { modal: true, detail }, 'Rollback Files'
    );
    if (choice !== 'Rollback Files') return;
    await this.operation('rollback', `Rolling back ${selected.length} ${selected.length === 1 ? 'file' : 'files'}…`, async () => {
      if (this.selectedWorkspace()?.uri.fsPath !== client.workspaceRoot) throw new Error('The selected repository changed. Select the files again.');
      const current = await client.snapshot(this.commitLimit);
      const currentByPath = new Map(current.changes.map((change) => [change.path, change]));
      for (const change of selected) {
        const latest = currentByPath.get(change.path);
        if (!latest || latest.kind !== change.kind || latest.indexStatus !== change.indexStatus ||
            latest.workingTreeStatus !== change.workingTreeStatus || latest.originalPath !== change.originalPath) {
          throw new Error(`The state of ${change.path} changed. Review the files before rolling back.`);
        }
      }
      const currentFileStates = await Promise.all(fileUris.map(fileState));
      if (currentFileStates.some((state, index) => state !== expectedFileStates[index])) {
        throw new Error('A selected file changed during confirmation. Review the files before rolling back.');
      }
      const restorePaths = [...new Set(existing.flatMap((change) => change.originalPath
        ? [change.originalPath, change.path] : [change.path]))];
      if (restorePaths.length) await client.restoreFilesToHead(restorePaths);
      const stagedNew = newFiles.filter((change) => change.indexStatus === 'A').map((change) => change.path);
      if (stagedNew.length) await client.unstageNewFiles(stagedNew);
      for (const change of newFiles) {
        const index = selected.indexOf(change);
        if (expectedFileStates[index] !== 'missing') await vscode.workspace.fs.delete(fileUris[index]!, { useTrash: true });
      }
    }, `Rolled back ${selected.length} ${selected.length === 1 ? 'file' : 'files'}`);
  }

  private async configureGitIdentity(client: GitClient): Promise<void> {
    const current = this.lastSnapshot?.identity;
    const name = await vscode.window.showInputBox({
      title: 'Git Identity for This Repository',
      prompt: 'Name to record on new commits in this repository',
      value: current?.name || '',
      validateInput: (value) => value.trim() && !/[\r\n]/.test(value) ? undefined : 'Enter your Git author name.'
    });
    if (name === undefined) return;
    const email = await vscode.window.showInputBox({
      title: 'Git Identity for This Repository',
      prompt: 'Email to record on new commits in this repository',
      value: current?.email || '',
      validateInput: (value) => /^[^\s@<>]+@[^\s@<>]+$/.test(value.trim()) ? undefined : 'Enter a Git author email.'
    });
    if (email === undefined) return;
    await this.operation('identity', 'Saving Git identity…', () => client.setLocalCommitIdentity(name, email), 'Repository Git identity configuration saved');
  }

  async showLineBlame(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showInformationMessage(`${IdeaGitViewProvider.productName}: Open a file and place the cursor on a line first.`);
      return;
    }
    try {
      if (editor.document.isDirty) {
        const choice = await vscode.window.showWarningMessage(
          'Save this file before checking line history? Unsaved edits can shift the line number.',
          'Save and Blame'
        );
        if (choice !== 'Save and Blame') return;
        if (!await editor.document.save()) throw new Error('The file could not be saved. Line history was not checked.');
      }
      const filePath = await this.workspaceRelativePath(editor.document.uri);
      const line = editor.selection.active.line + 1;
      const blame = await (await this.getClient()).blameLine(filePath, line);
      const shortHash = blame.hash.slice(0, 8);
      const authoredAt = blame.authorTime ? new Date(blame.authorTime * 1000).toLocaleString() : 'time unknown';
      const summary = blame.summary || 'No commit message';
      const message = blame.uncommitted
        ? `${path.basename(filePath)}:${line} · Uncommitted line · no commit author yet`
        : `${path.basename(filePath)}:${line} · ${blame.author} · ${authoredAt}\n${summary} (${shortHash})`;
      const actions = blame.uncommitted ? ['Show File History'] : ['Show Commit in History', 'Copy Commit Hash', 'Show File History'];
      const action = await vscode.window.showInformationMessage(message, ...actions);
      if (action === 'Show Commit in History' && !blame.uncommitted) {
        await this.showCommitInHistory(blame.hash, editor.document.uri);
      } else if (action === 'Copy Commit Hash' && !blame.uncommitted) {
        await vscode.env.clipboard.writeText(blame.hash);
        void vscode.window.showInformationMessage('Commit hash copied.');
      } else if (action === 'Show File History') {
        await this.showFileHistory(editor.document.uri);
      }
    } catch (error) {
      const message = this.errorText(error);
      if (/no such path|no such file/i.test(message)) {
        void vscode.window.showInformationMessage(`${path.basename(editor.document.uri.fsPath)} has no committed history yet.`);
        return;
      }
      void vscode.window.showErrorMessage(`${IdeaGitViewProvider.productName}: ${message}`);
    }
  }

  private async chooseChangelistForFiles(client: GitClient, paths: string[]): Promise<void> {
    const uniquePaths = [...new Set(paths)].filter((filePath) => typeof filePath === 'string' && filePath.length > 0);
    if (!uniquePaths.length) return;
    const snapshot = await client.snapshot(this.commitLimit);
    const changedPaths = new Set(snapshot.changes.map((change) => change.path));
    if (uniquePaths.some((filePath) => !changedPaths.has(filePath))) {
      void vscode.window.showInformationMessage(`${IdeaGitViewProvider.productName}: The selected files changed. Refresh the Commit view and try again.`);
      return;
    }
    const selected = new Set(uniquePaths);
    const sourceLists = snapshot.changelists.filter((list) => list.changes.some((change) => selected.has(change.path)));
    const options = snapshot.changelists
      .filter((list) => sourceLists.length !== 1 || list.id !== sourceLists[0]?.id)
      .map((list) => ({ label: list.name, description: list.active ? 'Active changelist' : undefined, id: list.id }));
    if (!options.length) {
      void vscode.window.showInformationMessage(`${IdeaGitViewProvider.productName}: Create another changelist before moving this file.`);
      return;
    }
    const target = await vscode.window.showQuickPick(options, {
      title: uniquePaths.length === 1 ? 'Move to Changelist' : `Move ${uniquePaths.length} Files to Changelist`,
      placeHolder: uniquePaths.length === 1 ? uniquePaths[0] : `${uniquePaths.length} selected files`,
      ignoreFocusOut: true
    });
    if (!target) return;
    await this.operation('move', uniquePaths.length === 1 ? `Moving ${uniquePaths[0]}…` : `Moving ${uniquePaths.length} files…`, () => client.moveToChangelist(uniquePaths, target.id), `Moved to ${target.label}`);
  }

  private async operation(kind: OperationKind, label: string, action: () => Promise<void>, success: string, clearsCommit = false): Promise<boolean> {
    if (this.operationRunning) throw new Error('Another Git operation is already running.');
    this.operationRunning = true;
    const id = ++this.operationId;
    let writeStarted = false;
    try {
      await this.postToReadyViews({ type: 'operation', id, kind, phase: 'loading', message: label });
      if (this.autoFetchPromise) await this.autoFetchPromise;
      this.coordinator.beginWrite();
      writeStarted = true;
      await vscode.window.withProgress({ location: vscode.ProgressLocation.SourceControl, title: `${IdeaGitViewProvider.productName}: ${label}` }, action);
      if (kind === 'commit' || kind === 'checkout' || kind === 'pull' || kind === 'branch') this.repositoryEmitter.fire();
      if (kind === 'fetch') await this.setSyncState('idle', Date.now());
      else if (kind === 'pull' || kind === 'push') await this.setSyncState('idle', Date.now());
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
    const workspace = this.selectedWorkspace();
    if (!workspace) return;
    const oldUri = this.revisionUri(originalPath ?? filePath);
    const currentUri = kind === 'deleted'
      ? this.revisionUri(filePath, 'empty=1')
      : vscode.Uri.file(path.join(workspace.uri.fsPath, filePath));
    await vscode.commands.executeCommand('vscode.diff', oldUri, currentUri, `${filePath} (HEAD ↔ Working Tree)`, { preview, preserveFocus: preview });
  }

  private async openPartialDiff(filePath: string, layer: 'staged' | 'unstaged'): Promise<void> {
    const change = this.lastSnapshot?.changes.find((candidate) => candidate.path === filePath);
    if (!change || !change.staged || change.kind === 'conflict' || change.workingTreeStatus === '.' || change.workingTreeStatus === 'R') {
      throw new Error('This file no longer has both staged and unstaged changes. Refresh and try again.');
    }
    const file = this.workspaceFileUri(filePath);
    const nonce = Date.now();
    const revisionUri = (revisionPath: string, query: string) => this.revisionUri(revisionPath, `${query}&view=${nonce}`);
    const indexUri = revisionUri(filePath, 'index=1');
    if (layer === 'staged') {
      const headPath = change.indexStatus === 'R' ? change.originalPath || filePath : filePath;
      this.workspaceFileUri(headPath);
      const headUri = change.indexStatus === 'A' ? revisionUri(headPath, 'empty=1') : revisionUri(headPath, 'head=1');
      await vscode.commands.executeCommand('vscode.diff', headUri, indexUri, `${filePath} (HEAD ↔ Index)`, { preview: false });
      return;
    }
    const workingUri = change.workingTreeStatus === 'D' ? revisionUri(filePath, 'empty=1') : file;
    await vscode.commands.executeCommand('vscode.diff', indexUri, workingUri, `${filePath} (Index ↔ Working Tree)`, { preview: false });
  }

  private async openFile(filePath: string): Promise<void> {
    const file = this.workspaceFileUri(filePath);
    const document = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
  }

  private workspaceFileUri(filePath: string): vscode.Uri {
    const workspace = this.selectedWorkspace();
    if (!workspace) throw new Error('Open a folder containing a Git repository.');
    const root = path.resolve(workspace.uri.fsPath);
    const resolved = path.resolve(root, filePath);
    if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) throw new Error('The selected file is outside the workspace.');
    return vscode.Uri.file(resolved);
  }

  private revisionUri(filePath: string, query = ''): vscode.Uri {
    const parameters = new URLSearchParams(query);
    const root = this.selectedWorkspace()?.uri.fsPath;
    if (root) parameters.set('repo', root);
    return vscode.Uri.from({ scheme: IdeaGitViewProvider.revisionScheme, path: `/${filePath}`, query: parameters.toString() });
  }

  private async openCommitDiff(client: GitClient, hash: string, filePath: string, originalPath?: string, kind?: string): Promise<void> {
    const details = await client.commitDetails(hash);
    if (this.selectedWorkspace()?.uri.fsPath !== client.workspaceRoot) return;
    const parent = details.parents[0];
    const oldUri = kind === 'A' || !parent
      ? this.revisionUri(originalPath ?? filePath, 'empty=1')
      : this.revisionUri(originalPath ?? filePath, `commit=${encodeURIComponent(parent)}`);
    const currentUri = kind === 'D'
      ? this.revisionUri(filePath, 'empty=1')
      : this.revisionUri(filePath, `commit=${encodeURIComponent(hash)}`);
    await vscode.commands.executeCommand('vscode.diff', oldUri, currentUri, `${filePath} (${hash.slice(0, 8)} · ${details.subject})`, { preview: false });
  }

  private configurePolling(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.autoFetchTimer) clearInterval(this.autoFetchTimer);
    if (!this.hasVisibleView()) return;
    const configuration = vscode.workspace.getConfiguration('ideaGit');
    const interval = configuration.get<number>('autoRefreshInterval', 30000);
    this.refreshTimer = setInterval(() => void this.refresh(true), interval);
    void this.refresh(true);
    if (configuration.get<boolean>('autoFetch', true)) {
      const autoFetchInterval = configuration.get<number>('autoFetchInterval', 60000);
      this.autoFetchTimer = setInterval(() => void this.autoFetchIfDue(), autoFetchInterval);
      if (this.lastSnapshot) void this.autoFetchIfDue();
    }
  }

  private async autoFetchIfDue(force = false): Promise<void> {
    if (this.autoFetchPromise || this.operationRunning || !this.hasVisibleView()) return this.autoFetchPromise;
    const interval = vscode.workspace.getConfiguration('ideaGit').get<number>('autoFetchInterval', 60000);
    if (!force && Date.now() - this.lastFetchAttemptAt < interval) return;
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
    this.autoFetchPromise = task.finally(() => {
      this.autoFetchPromise = undefined;
      if (generation !== this.syncGeneration) void this.autoFetchIfDue();
    });
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
      changes.title = `${snapshot.repositoryName} · Commit`;
      changes.description = undefined;
    }
    const history = this.views.get('history');
    if (history) {
      history.title = 'History';
      history.description = snapshot.branch === '(detached)'
        ? `Detached HEAD${snapshot.headOid ? ` · ${snapshot.headOid.slice(0, 8)}` : ''}`
        : snapshot.branch;
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
    const selectionUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'change-selection.js'));
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
          <symbol id="kivo-graph" viewBox="0 0 24 24"><path d="M6.5 4.5v15m0-7.5h1.8c2.8 0 4.7-1.9 4.7-4.6V6.2l2.2-1.7"/><circle cx="6.5" cy="4.5" r="2"/><circle cx="6.5" cy="19.5" r="2"/><circle cx="17" cy="4.5" r="2"/></symbol>
          <symbol id="kivo-changes" viewBox="0 0 24 24"><path d="M5 7.5h14M5 12h14M5 16.5h9"/><path d="M4 4.5h16v15H4z"/></symbol>
          <symbol id="kivo-sync" viewBox="0 0 24 24"><path d="M19 8a7.5 7.5 0 0 0-13.2-1.8L4 8.5M5 16a7.5 7.5 0 0 0 13.2 1.8l1.8-2.3"/><path d="M4 4.5v4h4M20 19.5v-4h-4"/></symbol>
          <symbol id="kivo-recovery" viewBox="0 0 24 24"><path d="M4 6.5h16v13H4zM7 6.5V4h10v2.5M7 11h10M7 15h6"/></symbol>
          <symbol id="kivo-conflict" viewBox="0 0 24 24"><path d="m12 4 8 15H4z"/><path d="M12 9v4m0 3h.01"/></symbol>
        </svg>
        <main id="app"></main>
        <div id="toast-region" aria-live="assertive"></div>
        <script nonce="${nonce}" src="${graphLayoutUri}"></script>
        <script nonce="${nonce}" src="${selectionUri}"></script>
        <script nonce="${nonce}" src="${jsUri}"></script>
      </body>
      </html>`;
  }

  dispose(): void {
    this.pushReview.clear();
    for (const listener of this.gitStateListeners.values()) listener.dispose();
    this.gitStateListeners.clear();
    clearInterval(this.badgePollTimer);
    if (this.badgeRefreshTimer) clearTimeout(this.badgeRefreshTimer);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.autoFetchTimer) clearInterval(this.autoFetchTimer);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.refreshDueAt = undefined;
    this.watcher?.dispose();
    this.emitter.dispose();
    this.repositoryEmitter.dispose();
  }
}
