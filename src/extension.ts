import * as vscode from 'vscode';
import { IdeaGitViewProvider } from './IdeaGitViewProvider';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new IdeaGitViewProvider(context);
  context.subscriptions.push(
    provider,
    vscode.window.registerWebviewViewProvider(IdeaGitViewProvider.changesViewType, provider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.window.registerWebviewViewProvider(IdeaGitViewProvider.historyViewType, provider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.workspace.registerTextDocumentContentProvider(IdeaGitViewProvider.revisionScheme, provider),
    vscode.commands.registerCommand('ideaGit.refresh', () => provider.refresh()),
    vscode.commands.registerCommand('ideaGit.focus', () => provider.showChanges()),
    vscode.commands.registerCommand('ideaGit.showChanges', () => provider.showChanges()),
    vscode.commands.registerCommand('ideaGit.showLog', () => provider.showLog())
  );
}

export function deactivate(): void {}
