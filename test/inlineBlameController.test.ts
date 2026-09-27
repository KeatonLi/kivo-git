import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => {
  const listeners: Record<string, Array<(...args: any[]) => void>> = {};
  return {
    listeners,
    editor: undefined as any,
    enabled: true,
    blameLine: vi.fn(),
    emit(name: string, event?: unknown) {
      for (const listener of listeners[name] || []) listener(event);
    },
    listen(name: string, listener: (...args: any[]) => void) {
      (listeners[name] ||= []).push(listener);
      return { dispose() { listeners[name] = listeners[name]?.filter((item) => item !== listener) || []; } };
    }
  };
});

vi.mock('vscode', () => ({
  window: {
    get activeTextEditor() { return harness.editor; },
    createTextEditorDecorationType: () => ({ dispose() {} }),
    onDidChangeActiveTextEditor: (listener: (...args: any[]) => void) => harness.listen('active', listener),
    onDidChangeTextEditorSelection: (listener: (...args: any[]) => void) => harness.listen('selection', listener)
  },
  workspace: {
    getConfiguration: () => ({ get: () => harness.enabled }),
    getWorkspaceFolder: () => ({ uri: { fsPath: '/workspace' } }),
    onDidChangeTextDocument: (listener: (...args: any[]) => void) => harness.listen('change', listener),
    onDidSaveTextDocument: (listener: (...args: any[]) => void) => harness.listen('save', listener),
    onDidChangeWorkspaceFolders: (listener: (...args: any[]) => void) => harness.listen('folders', listener),
    onDidChangeConfiguration: (listener: (...args: any[]) => void) => harness.listen('configuration', listener)
  },
  ThemeColor: class { constructor(readonly id: string) {} },
  MarkdownString: class {
    value = '';
    isTrusted?: { enabledCommands: string[] };
    appendText(value: string) { this.value += value; }
    appendMarkdown(value: string) { this.value += value; }
  }
}));

vi.mock('../src/git/GitClient', () => ({
  GitClient: class { blameLine = harness.blameLine; }
}));

import { InlineBlameController } from '../src/InlineBlameController';

const result = { hash: 'a'.repeat(40), author: 'Tester', authorTime: 1_700_000_000,
  summary: 'A useful change', line: 1, content: 'line', uncommitted: false };

function editor() {
  const document = {
    uri: { scheme: 'file', fsPath: '/workspace/file.txt', toString: () => 'file:///workspace/file.txt' }, isDirty: false, version: 1,
    lineAt: (line: number) => ({ range: { line } })
  };
  return {
    document,
    selection: { active: { line: 0 }, isEmpty: true },
    selections: [{}],
    setDecorations: vi.fn()
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  harness.editor = editor();
  harness.enabled = true;
  harness.blameLine.mockReset().mockResolvedValue(result);
});

afterEach(() => {
  vi.useRealTimers();
  harness.editor = undefined;
});

describe('current-line blame controller', () => {
  it('waits for the cursor to settle and reuses a visited line without another Git call', async () => {
    const controller = new InlineBlameController();
    await vi.advanceTimersByTimeAsync(250);
    harness.editor.selection.active.line = 1;
    harness.emit('selection', { textEditor: harness.editor });
    await vi.advanceTimersByTimeAsync(250);
    harness.editor.selection.active.line = 2;
    harness.emit('selection', { textEditor: harness.editor });
    await vi.advanceTimersByTimeAsync(449);
    expect(harness.blameLine).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.blameLine).toHaveBeenCalledExactlyOnceWith('file.txt', 3, expect.objectContaining({ timeout: 5000, signal: expect.any(AbortSignal) }));
    expect(harness.editor.setDecorations.mock.lastCall?.[1]?.[0]?.renderOptions.after.contentText).toContain('Tester');
    expect(harness.editor.setDecorations.mock.lastCall?.[1]?.[0]?.hoverMessage.value).toContain('Open commit in History');
    expect(harness.editor.setDecorations.mock.lastCall?.[1]?.[0]?.hoverMessage.isTrusted.enabledCommands).toEqual(['ideaGit.revealBlameCommit']);

    harness.editor.selection.active.line = 0;
    harness.emit('selection', { textEditor: harness.editor });
    await vi.advanceTimersByTimeAsync(450);
    expect(harness.blameLine).toHaveBeenCalledTimes(2);
    harness.editor.selection.active.line = 2;
    harness.emit('selection', { textEditor: harness.editor });
    expect(harness.blameLine).toHaveBeenCalledTimes(2);
    controller.dispose();
  });

  it('hides attribution while dirty and cancels stale results after a line change', async () => {
    let finish!: (value: typeof result) => void;
    harness.blameLine.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const controller = new InlineBlameController();
    await vi.advanceTimersByTimeAsync(450);
    const oldSignal = harness.blameLine.mock.calls[0]?.[2]?.signal;
    harness.editor.selection.active.line = 1;
    harness.emit('selection', { textEditor: harness.editor });
    expect(oldSignal.aborted).toBe(true);
    finish(result);
    await vi.advanceTimersByTimeAsync(450);
    expect(harness.blameLine).toHaveBeenCalledTimes(2);
    expect(harness.editor.setDecorations.mock.lastCall?.[1]?.[0]?.range.line).toBe(1);

    harness.editor.document.isDirty = true;
    harness.emit('change', { document: harness.editor.document });
    expect(harness.editor.setDecorations.mock.lastCall?.[1]).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(harness.blameLine).toHaveBeenCalledTimes(2);
    controller.dispose();
  });

  it('removes the annotation immediately when the setting is disabled', async () => {
    const controller = new InlineBlameController();
    await vi.advanceTimersByTimeAsync(450);
    harness.enabled = false;
    harness.emit('configuration', { affectsConfiguration: () => true });
    expect(harness.editor.setDecorations.mock.lastCall?.[1]).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(harness.blameLine).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it('does not run Git for every line in a non-repository workspace', async () => {
    harness.blameLine.mockRejectedValueOnce(new Error('fatal: not a git repository'));
    const controller = new InlineBlameController();
    await vi.advanceTimersByTimeAsync(450);
    harness.editor.selection.active.line = 1;
    harness.emit('selection', { textEditor: harness.editor });
    await vi.advanceTimersByTimeAsync(1000);
    expect(harness.blameLine).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15_000);
    harness.emit('selection', { textEditor: harness.editor });
    await vi.advanceTimersByTimeAsync(450);
    expect(harness.blameLine).toHaveBeenCalledTimes(2);
    controller.dispose();
  });
});
