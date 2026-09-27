import * as vscode from 'vscode';
import path from 'node:path';
import { GitClient } from './git/GitClient';
import type { LineBlame } from './git/types';
import { InlineBlameCache, inlineBlameLabel } from './inlineBlameModel';

const LOOKUP_DELAY_MS = 450;
const LOOKUP_TIMEOUT_MS = 5000;
const NON_REPOSITORY_RETRY_MS = 15_000;

/** One quiet, current-line annotation; the detailed command remains available on demand. */
export class InlineBlameController implements vscode.Disposable {
  private readonly decoration = vscode.window.createTextEditorDecorationType({
    after: { color: new vscode.ThemeColor('descriptionForeground'), margin: '0 0 0 2em' }
  });
  private readonly cache = new InlineBlameCache();
  private readonly unavailableRoots = new Map<string, number>();
  private readonly subscriptions: vscode.Disposable[];
  private decoratedEditor?: vscode.TextEditor;
  private currentKey?: string;
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<LineBlame | null>;
  private abortController?: AbortController;
  private generation = 0;

  constructor() {
    this.subscriptions = [
      vscode.window.onDidChangeActiveTextEditor(() => this.schedule()),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        if (event.textEditor === vscode.window.activeTextEditor) this.schedule();
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document !== vscode.window.activeTextEditor?.document) return;
        this.invalidate();
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (document === vscode.window.activeTextEditor?.document) this.invalidate();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.invalidate()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('ideaGit.inlineBlame.enabled')) this.invalidate();
      })
    ];
    this.schedule();
  }

  async toggle(): Promise<void> {
    const resource = vscode.window.activeTextEditor?.document.uri;
    const configuration = vscode.workspace.getConfiguration('ideaGit', resource);
    const setting = configuration.inspect<boolean>('inlineBlame.enabled');
    const target = setting?.workspaceFolderValue !== undefined ? vscode.ConfigurationTarget.WorkspaceFolder
      : setting?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
    const enabled = !configuration.get<boolean>('inlineBlame.enabled', true);
    await configuration.update('inlineBlame.enabled', enabled, target);
    void vscode.window.showInformationMessage(`Kivo Git inline blame ${enabled ? 'enabled' : 'disabled'}.`);
  }

  /** Git operations can change authorship without editing the open document. */
  invalidate(): void {
    this.cache.clear();
    this.currentKey = undefined;
    this.schedule();
  }

  dispose(): void {
    this.cancel();
    this.clearDecoration();
    this.cache.clear();
    this.unavailableRoots.clear();
    for (const subscription of this.subscriptions) subscription.dispose();
    this.decoration.dispose();
  }

  private cancel(): void {
    this.generation += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.abortController?.abort();
    this.abortController = undefined;
  }

  private clearDecoration(): void {
    this.decoratedEditor?.setDecorations(this.decoration, []);
    this.decoratedEditor = undefined;
  }

  private schedule(): void {
    const editor = vscode.window.activeTextEditor;
    const document = editor?.document;
    const enabled = vscode.workspace.getConfiguration('ideaGit', document?.uri).get<boolean>('inlineBlame.enabled', true);
    const workspace = document?.uri.scheme === 'file' ? vscode.workspace.getWorkspaceFolder(document.uri) : undefined;
    if (!enabled || !editor || !document || !workspace || document.isDirty || editor.selections.length !== 1 || !editor.selection.isEmpty) {
      this.cancel();
      this.currentKey = undefined;
      this.clearDecoration();
      return;
    }
    const lineIndex = editor.selection.active.line;
    const relativePath = path.relative(workspace.uri.fsPath, document.uri.fsPath).split(path.sep).join('/');
    if (!relativePath || relativePath.startsWith('../')) {
      this.cancel();
      this.currentKey = undefined;
      this.clearDecoration();
      return;
    }
    const unavailableUntil = this.unavailableRoots.get(workspace.uri.fsPath) || 0;
    if (unavailableUntil > Date.now()) {
      this.cancel();
      this.currentKey = undefined;
      this.clearDecoration();
      return;
    }
    if (unavailableUntil) this.unavailableRoots.delete(workspace.uri.fsPath);
    const key = JSON.stringify([workspace.uri.fsPath, relativePath, document.version, lineIndex]);
    const cached = this.cache.peek(key);
    if (key === this.currentKey && (this.timer || this.inFlight || (this.decoratedEditor === editor && cached !== undefined))) return;
    this.cancel();
    this.currentKey = key;
    this.clearDecoration();
    const generation = this.generation;
    if (cached !== undefined) {
      if (cached) this.show(editor, lineIndex, cached);
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.lookup(generation, key, editor, lineIndex, workspace.uri.fsPath, relativePath);
    }, LOOKUP_DELAY_MS);
  }

  private async lookup(generation: number, key: string, editor: vscode.TextEditor, lineIndex: number, root: string, relativePath: string): Promise<void> {
    if (this.inFlight) await this.inFlight;
    if (generation !== this.generation || this.currentKey !== key) return;
    const abortController = new AbortController();
    this.abortController = abortController;
    const request = this.cache.get(key, async () => {
      try {
        return await new GitClient(root).blameLine(relativePath, lineIndex + 1, {
          timeout: LOOKUP_TIMEOUT_MS, signal: abortController.signal
        });
      } catch (error) {
        if (/not a git repository/i.test(error instanceof Error ? error.message : String(error))) {
          this.unavailableRoots.set(root, Date.now() + NON_REPOSITORY_RETRY_MS);
          this.cache.clear();
        }
        throw error;
      }
    });
    this.inFlight = request;
    const blame = await request;
    if (this.inFlight === request) this.inFlight = undefined;
    if (this.abortController === abortController) this.abortController = undefined;
    if (generation !== this.generation || this.currentKey !== key || vscode.window.activeTextEditor !== editor || editor.document.isDirty) return;
    if (blame) this.show(editor, lineIndex, blame);
  }

  private show(editor: vscode.TextEditor, lineIndex: number, blame: LineBlame): void {
    const line = editor.document.lineAt(lineIndex);
    const hover = new vscode.MarkdownString();
    hover.appendText(blame.uncommitted
      ? 'Uncommitted changes on this line.'
      : `${blame.author} · ${blame.authorTime ? new Date(blame.authorTime * 1000).toLocaleString() : 'time unknown'}\n${blame.summary}\n${blame.hash}`);
    editor.setDecorations(this.decoration, [{
      range: line.range,
      hoverMessage: hover,
      renderOptions: { after: { contentText: inlineBlameLabel(blame) } }
    }]);
    this.decoratedEditor = editor;
  }
}
