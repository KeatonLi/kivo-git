import * as vscode from 'vscode';
import { IdeaGitViewProvider } from './IdeaGitViewProvider';
import { InlineBlameController } from './InlineBlameController';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new IdeaGitViewProvider(context);
  const inlineBlame = new InlineBlameController();
  context.subscriptions.push(
    provider,
    inlineBlame,
    provider.onDidChangeRepository(() => inlineBlame.invalidate()),
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
    vscode.commands.registerCommand('ideaGit.showLog', () => provider.showLog()),
    vscode.commands.registerCommand('ideaGit.openResourceDiff', (uri?: vscode.Uri) => provider.openResourceDiff(uri)),
    vscode.commands.registerCommand('ideaGit.showFileHistory', (uri?: vscode.Uri) => provider.showFileHistory(uri)),
    vscode.commands.registerCommand('ideaGit.showLineBlame', () => provider.showLineBlame()),
    vscode.commands.registerCommand('ideaGit.toggleInlineBlame', () => inlineBlame.toggle()),
    vscode.commands.registerCommand('ideaGit.moveResourceToChangelist', (uri?: vscode.Uri) => provider.moveResourceToChangelist(uri)),
    vscode.commands.registerCommand('ideaGit.showResourceInChanges', (uri?: vscode.Uri) => provider.showResourceInChanges(uri))
  );
}

export function deactivate(): void {}
