import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

async function resize() {
  let editorHeight = 64;
  const listeners = new Map<string, (event: any) => void>();
  const editor = { getBoundingClientRect: () => ({ height: editorHeight }) };
  const tree = { clientHeight: 300 };
  const panel = { getBoundingClientRect: () => ({ height: editorHeight + 66 }),
    querySelector: (selector: string) => selector === '#commit-message' ? editor : undefined, classList: { toggle: vi.fn() },
    style: { setProperty: (key: string, value: string) => { if (key === '--commit-message-height') editorHeight = parseFloat(value); } } };
  const chrome = [34, 31, 28, 12].map(height => ({ getBoundingClientRect: () => ({ height }) }));
  const content = { clientHeight: 600, children: [...chrome, tree, panel], querySelector: (selector: string) => selector === '.commit-panel' ? panel : selector === '#commit-message' ? editor : tree };
  const splitter = { closest: () => content, setAttribute: vi.fn(), setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: vi.fn(),
    addEventListener: (name: string, handler: (event: any) => void) => listeners.set(name, handler),
    removeEventListener: (name: string) => listeners.delete(name) };
  const context: Record<string, any> = { ui: { commitMessageHeight: 64 }, activeCommitPanelResize: undefined,
    COMMIT_PANEL_MIN_HEIGHT: 0, COMMIT_PANEL_MAX_HEIGHT: 320, COMMIT_PANEL_DEFAULT_HEIGHT: 64,
    clamp: (v: number, min: number, max: number) => Math.max(min, Math.min(max, v)),
    getComputedStyle: () => ({ marginTop: '0px', marginBottom: '0px' }),
    document: { body: { classList: { add: vi.fn(), remove: vi.fn() } } }, persist: vi.fn() };
  const source = await readFile('media/main.js', 'utf8');
  const ast = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const names = new Set(['commitPanelBounds', 'applyCommitPanelHeight', 'syncCommitMessageDisclosure', 'startCommitPanelResize', 'finishCommitPanelResize']);
  runInNewContext(ast.statements.filter(node => ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text)).map(node => node.getText(ast)).join('\n'), context);
  context.startCommitPanelResize({ currentTarget: splitter, button: 0, pointerId: 1, clientY: 200, preventDefault() {} });
  return { context, height: () => editorHeight, move: (clientY: number) => listeners.get('pointermove')?.({ pointerId: 1, clientY }), cancel: () => listeners.get('pointercancel')?.({ pointerId: 1 }), finish: () => listeners.get('pointerup')?.({ pointerId: 1 }) };
}

describe('commit editor drag', () => {
  it('shrinks to zero and immediately reverses after overshooting the boundary', async () => {
    const r = await resize();
    r.move(380);
    expect(r.height()).toBe(0);
    r.move(375);
    expect(r.height()).toBe(5);
    r.finish();
    expect(r.context.persist).toHaveBeenCalledOnce();
  });

  it('keeps subpixel pointer displacement instead of losing each small step', async () => {
    const r = await resize();
    r.move(199.75); r.move(199.5); r.move(199.25);
    expect(r.height()).toBeCloseTo(64.75);
  });

  it('restores the starting height on cancellation and ignores subsequent events', async () => {
    const r = await resize();
    r.move(150);
    expect(r.height()).toBe(114);
    r.cancel();
    expect(r.height()).toBe(64);
    r.move(100);
    expect(r.height()).toBe(64);
    expect(r.context.persist).not.toHaveBeenCalled();
  });

  it('limits expansion to a budget that retains file-review space, then reverses immediately', async () => {
    const r = await resize();
    r.move(-300);
    expect(r.height()).toBe(317);
    r.move(-299);
    expect(r.height()).toBe(316);
  });
});
