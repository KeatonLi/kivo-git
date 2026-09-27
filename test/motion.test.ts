import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

async function motion() {
  const context: Record<string, any> = {
    reducedMotion: { matches: false }, document: { hidden: false },
    runningMotion: new Set(), elementMotion: new WeakMap(), Node: { ELEMENT_NODE: 1 }
  };
  const source = await readFile('media/main.js', 'utf8');
  const ast = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const names = new Set(['motionEnabled', 'playMotion', 'stopMotion', 'changelistMovement', 'keyFor']);
  runInNewContext(ast.statements.filter((node) => ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text)).map((node) => node.getText(ast)).join('\n'), context);
  return context;
}

describe('state-only motion', () => {
  it('animates a changelist transfer, not reflow, filtering, collapsed or offscreen rows', async () => {
    const context = await motion();
    const before = { listId: 'a', left: 10, top: 50, width: 200, height: 28 };
    expect(context.changelistMovement(before, { ...before, top: 100 }, 600)).toBeUndefined();
    expect(context.changelistMovement(before, { ...before, listId: 'b', top: 100 }, 600)).toEqual({ x: 0, y: -50 });
    expect(context.changelistMovement(before, { ...before, listId: 'b', top: 1000 }, 600)).toBeUndefined();
    expect(context.changelistMovement(before, { ...before, listId: 'b', height: 0 }, 600)).toBeUndefined();
  });

  it('skips animation in reduced-motion and hidden views', async () => {
    const context = await motion();
    const element = { animate: vi.fn() };
    context.reducedMotion.matches = true;
    context.playMotion(element, [], {});
    context.reducedMotion.matches = false;
    context.document.hidden = true;
    context.playMotion(element, [], {});
    expect(element.animate).not.toHaveBeenCalled();
  });

  it('cancels overlapping and active animations and handles cancellation rejections', async () => {
    const context = await motion();
    let rejectFirst!: (reason?: unknown) => void;
    const first = { cancel: vi.fn(() => rejectFirst()), finished: new Promise((_resolve, reject) => { rejectFirst = reject; }) };
    const second = { cancel: vi.fn(), finished: Promise.resolve() };
    const element = { animate: vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second) };
    context.playMotion(element, [], {});
    context.playMotion(element, [], {});
    expect(first.cancel).toHaveBeenCalledOnce();
    context.stopMotion();
    expect(second.cancel).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(context.runningMotion.size).toBe(0);
    expect(context.elementMotion.has(element)).toBe(false);
  });

  it('does not confuse a changelist container with its menu actions during DOM reuse', async () => {
    const context = await motion();
    const element = (isList: boolean) => ({ nodeType: 1, dataset: { listId: 'default' }, classList: { contains: () => isList } });
    expect(context.keyFor(element(true))).toBe('list:default');
    expect(context.keyFor(element(false))).toBeNull();
    expect(context.keyFor({ nodeType: 1, id: 'kivo-commit-changes', dataset: {} })).toBe('id:kivo-commit-changes');
  });
});
