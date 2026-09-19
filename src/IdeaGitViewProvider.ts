import * as vscode from 'vscode';
import path from 'node:path';
import { GitClient } from './git/GitClient';
import type { PullStrategy, RepositorySnapshot } from './git/types';
import { SnapshotCoordinator } from './SnapshotCoordinator';
import { isMessageAllowedOnSurface, KivoViewTypes, type KivoSurface, surfaceForViewType } from './viewLayout';

type WebviewMessage =
  | { type: 'ready' | 'refresh' | 'fetch' | 'push' | 'loadMoreCommits' }
  | { type: 'pull'; strategy: PullStrategy }
  | { type: 'commitDetails'; hash: string }
  | { type: 'openDiff'; path: string; originalPath?: string; kind?: string; preview?: boolean }
  | { type: 'openCommitDiff'; hash: string; path: string; originalPath?: string; kind?: string }
  | { type: 'commit'; message: string; paths: string[] }
  | { type: 'checkout'; branch: string; remote: boolean }
  | { type: 'createChangelist' }
  | { type: 'renameChangelist'; id: string; name: string }
  | { type: 'deleteChangelist'; id: string; name: string }
  | { type: 'setActiveChangelist'; id: string }
  | { type: 'moveFiles'; paths: string[]; listId: string };
type OperationKind = 'commit' | 'checkout' | 'changelist' | 'move' | 'fetch' | 'pull' | 'push';

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
  private commitLimit = 80;
  private lastSnapshot?: RepositorySnapshot;
  private readonly coordinator = new SnapshotCoordinator(
    () => this.getClient().then((client) => client.snapshot(this.commitLimit)),
    async (snapshot) => {
      this.lastSnapshot = snapshot;
      await this.postToReadyViews({ type: 'snapshot', payload: snapshot });
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
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.client = undefined;
        this.watchedRoot = undefined;
        this.lastFetchAttemptAt = 0;
        this.lastFetchedAt = undefined;
        this.syncError = undefined;
        this.syncGeneration += 1;
        this.commitLimit = 80;
        this.lastSnapshot = undefined;
        this.watcher?.dispose();
        this.coordinator.reset();
        this.configurePolling();
      })
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    const surface = surfaceForViewType(view.viewType);
    if (!surface) throw new Error(`Unsupported Kivo Git view type: ${view.viewType}`);
    this.views.set(surface, view);
    this.readyViews.delete(surface);
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
    };
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
      this.readyViews.add(surface);
      await this.setSyncState(this.autoFetchPromise ? 'fetching' : this.syncError ? 'error' : 'idle', undefined, this.syncError);
      if (this.lastSnapshot) await this.postToView(surface, { type: 'snapshot', payload: this.lastSnapshot });
      await this.refresh(true);
      return;
    }
    if (message.type === 'refresh') {
      await this.refresh();
      return;
    }
    try {
      const client = await this.getClient();
      switch (message.type) {
        case 'loadMoreCommits':
          this.commitLimit = Math.min(this.commitLimit + 80, 800);
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
        case 'openCommitDiff':
          await this.openCommitDiff(client, message.hash, message.path, message.originalPath, message.kind);
          return;
        case 'commit':
          await this.operation('commit', 'Creating commit…', async () => client.commit(message.message, message.paths), 'Commit created', true);
          return;
        case 'checkout':
          await this.operation('checkout', `Switching to ${message.branch}…`, async () => client.checkout(message.branch, message.remote), `Switched to ${message.branch}`);
          return;
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

  private async operation(kind: OperationKind, label: string, action: () => Promise<void>, success: string, clearsCommit = false): Promise<void> {
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
    } catch (error) {
      this.coordinator.reset();
      if (kind === 'fetch' || kind === 'pull' || kind === 'push') await this.setSyncState('error', undefined, this.errorText(error));
      await this.postToReadyViews({ type: 'operation', id, kind, phase: 'error', message: this.errorText(error) });
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

  private errorText(error: unknown): string {
    return error instanceof Error ? error.message.replace(/^fatal:\s*/i, '') : String(error);
  }

  private html(webview: vscode.Webview, surface: KivoSurface): string {
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.css'));
    const codiconUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'codicons', 'codicon.css'));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.js'));
    const nonce = Math.random().toString(36).slice(2);
    return `<!doctype html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
        <link rel="stylesheet" href="${codiconUri}">
        <link rel="stylesheet" href="${cssUri}">
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
