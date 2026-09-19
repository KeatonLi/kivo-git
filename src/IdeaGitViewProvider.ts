import * as vscode from 'vscode';
import path from 'node:path';
import { GitClient } from './git/GitClient';
import { SnapshotCoordinator } from './SnapshotCoordinator';

type WebviewMessage =
  | { type: 'ready' | 'refresh' | 'fetch' | 'pull' | 'push' }
  | { type: 'openDiff'; path: string; originalPath?: string; kind?: string; preview?: boolean }
  | { type: 'commit'; message: string; paths: string[] }
  | { type: 'checkout'; branch: string; remote: boolean }
  | { type: 'createChangelist' }
  | { type: 'renameChangelist'; id: string; name: string }
  | { type: 'deleteChangelist'; id: string; name: string }
  | { type: 'setActiveChangelist'; id: string }
  | { type: 'moveFiles'; paths: string[]; listId: string };
type OperationKind = 'commit' | 'checkout' | 'changelist' | 'move' | 'fetch' | 'pull' | 'push';

export class IdeaGitViewProvider implements vscode.WebviewViewProvider, vscode.TextDocumentContentProvider, vscode.Disposable {
  static readonly viewType = 'ideaGit.panel';
  static readonly revisionScheme = 'ideagit';
  private view?: vscode.WebviewView;
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
  private readonly coordinator = new SnapshotCoordinator(
    () => this.getClient().then((client) => client.snapshot()),
    async (snapshot) => { await this.view?.webview.postMessage({ type: 'snapshot', payload: snapshot }); },
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
        this.watcher?.dispose();
        this.coordinator.reset();
        this.configurePolling();
      })
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((message: WebviewMessage) => void this.handle(message));
    view.onDidChangeVisibility(() => this.configurePolling());
    this.configurePolling();
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    if (uri.query === 'empty=1') return '';
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) return '';
    const client = await this.getClient();
    return client.showHeadFile(uri.path.replace(/^\//, ''));
  }

  async refresh(silent = false): Promise<void> {
    if (!this.view || !this.view.visible) return;
    this.coordinator.request();
    if (!silent && !vscode.workspace.workspaceFolders?.length) void vscode.window.showInformationMessage('IdeaGit: Open a Git repository to start.');
  }

  private async showEmpty(error: unknown): Promise<void> {
    this.client = undefined;
    this.coordinator.reset();
    await this.view?.webview.postMessage({ type: 'empty', message: this.errorText(error) });
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
    if (!this.view?.visible) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.refresh(true), 180);
  }

  private async handle(message: WebviewMessage): Promise<void> {
    if (message.type === 'ready') {
      await this.setSyncState(this.autoFetchPromise ? 'fetching' : this.syncError ? 'error' : 'idle', undefined, this.syncError);
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
        case 'openDiff':
          await this.openDiff(message.path, message.originalPath, message.kind, message.preview);
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
          await this.operation('pull', 'Pulling…', () => client.pull(), 'Repository updated');
          return;
        case 'push':
          await this.operation('push', 'Pushing…', () => client.push(), 'Push complete');
      }
    } catch (error) {
      const detail = this.errorText(error);
      await this.view?.webview.postMessage({ type: 'notice', phase: 'error', message: detail });
      void vscode.window.showErrorMessage(`IdeaGit: ${detail}`);
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
    if (this.autoFetchPromise) await this.autoFetchPromise;
    if (this.operationRunning) throw new Error('Another Git operation is already running.');
    this.operationRunning = true;
    const id = ++this.operationId;
    this.coordinator.beginWrite();
    await this.view?.webview.postMessage({ type: 'operation', id, kind, phase: 'loading', message: label });
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.SourceControl, title: `IdeaGit: ${label}` }, action);
      if (kind === 'fetch' || kind === 'pull' || kind === 'push') await this.setSyncState('idle', Date.now());
      await this.view?.webview.postMessage({ type: 'operation', id, kind, phase: 'success', message: success, clearsCommit });
    } catch (error) {
      this.coordinator.reset();
      if (kind === 'fetch' || kind === 'pull' || kind === 'push') await this.setSyncState('error', undefined, this.errorText(error));
      await this.view?.webview.postMessage({ type: 'operation', id, kind, phase: 'error', message: this.errorText(error) });
    } finally {
      this.operationRunning = false;
      this.coordinator.endWrite();
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

  private configurePolling(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.autoFetchTimer) clearInterval(this.autoFetchTimer);
    if (!this.view?.visible) return;
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
    if (this.autoFetchPromise || this.operationRunning || !this.view?.visible) return this.autoFetchPromise;
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
    await this.view?.webview.postMessage({ type: 'syncStatus', phase, lastFetchedAt: this.lastFetchedAt, error: this.syncError });
  }

  private errorText(error: unknown): string {
    return error instanceof Error ? error.message.replace(/^fatal:\s*/i, '') : String(error);
  }

  private html(webview: vscode.Webview): string {
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
        <title>IdeaGit</title>
      </head>
      <body>
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
