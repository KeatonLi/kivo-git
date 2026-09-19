import * as vscode from 'vscode';
import { IdeaGitViewProvider } from './IdeaGitViewProvider';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new IdeaGitViewProvider(context);
  context.subscriptions.push(
    provider,
    vscode.window.registerWebviewViewProvider(IdeaGitViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.workspace.registerTextDocumentContentProvider(IdeaGitViewProvider.revisionScheme, provider),
    vscode.commands.registerCommand('ideaGit.refresh', () => provider.refresh()),
    vscode.commands.registerCommand('ideaGit.focus', () => vscode.commands.executeCommand('ideaGit.panel.focus')),
    vscode.commands.registerCommand('ideaGit.showLog', () => provider.showLog())
  );
}

export function deactivate(): void {}
