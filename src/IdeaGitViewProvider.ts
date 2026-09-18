import * as vscode from 'vscode';
import path from 'node:path';
import { GitClient } from './git/GitClient';

type WebviewMessage =
  | { type: 'ready' | 'refresh' | 'fetch' | 'pull' | 'push' }
  | { type: 'openDiff'; path: string; originalPath?: string; kind?: string }
  | { type: 'commit'; message: string; paths: string[] }
  | { type: 'checkout'; branch: string; remote: boolean }
  | { type: 'createChangelist'; name: string }
  | { type: 'moveFiles'; paths: string[]; listId: string };

export class IdeaGitViewProvider implements vscode.WebviewViewProvider, vscode.TextDocumentContentProvider, vscode.Disposable {
  static readonly viewType = 'ideaGit.panel';
  static readonly revisionScheme = 'ideagit';
  private view?: vscode.WebviewView;
  private client?: GitClient;
  private refreshTimer?: NodeJS.Timeout;
  private refreshing = false;
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

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
    if (!this.view || this.refreshing) return;
    this.refreshing = true;
    try {
      const client = await this.getClient();
      const snapshot = await client.snapshot();
      await this.view.webview.postMessage({ type: 'snapshot', payload: snapshot });
    } catch (error) {
      this.client = undefined;
      await this.view.webview.postMessage({
        type: 'empty',
        message: error instanceof Error ? error.message : 'Open a Git repository to start.'
      });
      if (!silent) void vscode.window.showErrorMessage(`IdeaGit: ${this.errorText(error)}`);
    } finally {
      this.refreshing = false;
    }
  }

  private async getClient(): Promise<GitClient> {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) throw new Error('Open a folder containing a Git repository.');
    if (!this.client || this.client.workspaceRoot !== workspace.uri.fsPath) {
      this.client = new GitClient(workspace.uri.fsPath);
      await this.client.initialize();
    }
    return this.client;
  }

  private async handle(message: WebviewMessage): Promise<void> {
    try {
      const client = await this.getClient();
      switch (message.type) {
        case 'ready':
        case 'refresh':
          await this.refresh();
          return;
        case 'openDiff':
          await this.openDiff(message.path, message.originalPath, message.kind);
          return;
        case 'commit':
          await this.operation('Creating commit…', async () => client.commit(message.message, message.paths), 'Commit created');
          return;
        case 'checkout':
          await this.operation(`Switching to ${message.branch}…`, async () => client.checkout(message.branch, message.remote), `Switched to ${message.branch}`);
          return;
        case 'createChangelist':
          await client.createChangelist(message.name);
          await this.refresh(true);
          return;
        case 'moveFiles':
          await client.moveToChangelist(message.paths, message.listId);
          await this.refresh(true);
          return;
        case 'fetch':
          await this.operation('Fetching…', () => client.fetch(), 'Fetch complete');
          return;
        case 'pull':
          await this.operation('Pulling…', () => client.pull(), 'Repository updated');
          return;
        case 'push':
          await this.operation('Pushing…', () => client.push(), 'Push complete');
      }
    } catch (error) {
      const detail = this.errorText(error);
      await this.view?.webview.postMessage({ type: 'operation', phase: 'error', message: detail });
      void vscode.window.showErrorMessage(`IdeaGit: ${detail}`);
    }
  }

  private async operation(label: string, action: () => Promise<void>, success: string): Promise<void> {
    await this.view?.webview.postMessage({ type: 'operation', phase: 'loading', message: label });
    await vscode.window.withProgress({ location: vscode.ProgressLocation.SourceControl, title: `IdeaGit: ${label}` }, action);
    await this.refresh(true);
    await this.view?.webview.postMessage({ type: 'operation', phase: 'success', message: success });
  }

  private async openDiff(filePath: string, originalPath?: string, kind?: string): Promise<void> {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) return;
    const oldUri = vscode.Uri.from({ scheme: IdeaGitViewProvider.revisionScheme, path: `/${originalPath ?? filePath}` });
    const currentUri = kind === 'deleted'
      ? vscode.Uri.from({ scheme: IdeaGitViewProvider.revisionScheme, path: `/${filePath}`, query: 'empty=1' })
      : vscode.Uri.file(path.join(workspace.uri.fsPath, filePath));
    await vscode.commands.executeCommand('vscode.diff', oldUri, currentUri, `${filePath} (HEAD ↔ Working Tree)`);
  }

  private configurePolling(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (!this.view?.visible) return;
    const interval = vscode.workspace.getConfiguration('ideaGit').get<number>('autoRefreshInterval', 2500);
    this.refreshTimer = setInterval(() => void this.refresh(true), interval);
    void this.refresh(true);
  }

  private errorText(error: unknown): string {
    return error instanceof Error ? error.message.replace(/^fatal:\s*/i, '') : String(error);
  }

  private html(webview: vscode.Webview): string {
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.css'));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.js'));
    const nonce = Math.random().toString(36).slice(2);
    return `<!doctype html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
        <link rel="stylesheet" href="${cssUri}">
        <title>IdeaGit</title>
      </head>
      <body>
        <main id="app" aria-live="polite"></main>
        <div id="toast-region" aria-live="assertive"></div>
        <script nonce="${nonce}" src="${jsUri}"></script>
      </body>
      </html>`;
  }

  dispose(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.emitter.dispose();
  }
}
