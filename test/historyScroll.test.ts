import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

describe('History pagination gesture', () => {
  it('keeps fine trackpad movement and uses the live position when a queued frame runs', async () => {
    const source = await readFile(path.join(process.cwd(), 'media', 'main.js'), 'utf8');
    const start = source.indexOf('function onGraphScroll(');
    const end = source.indexOf('\nfunction reachableCommitHashes(', start);
    const ui = { graphScrollTop: 0 };
    let frame: (() => void) | undefined;
    const render = vi.fn();
    const restoreGraphScroll = vi.fn();
    const list = { scrollTop: 12, clientHeight: 180, scrollHeight: 2000, isConnected: true,
      querySelector: () => ({ dataset: { windowStart: '0', windowEnd: '20' } }) };
    const scroll = runInNewContext(`${source.slice(start, end)}\nonGraphScroll`, {
      ui, GRAPH_BOTTOM_EPSILON: 2, graphScrollFrame: undefined,
      requestAnimationFrame: (callback: () => void) => { frame = callback; return 1; },
      graphRenderWindow: () => ({ start: 1, end: 21 }), graphCommits: () => [],
      render, restoreGraphScroll, requestMoreHistory: vi.fn()
    }) as (event: { currentTarget: typeof list }) => void;
    scroll({ currentTarget: list });
    expect(ui.graphScrollTop).toBe(12);
    list.scrollTop = 29;
    frame?.();
    expect(ui.graphScrollTop).toBe(29);
    expect(render).toHaveBeenCalledOnce();
    expect(restoreGraphScroll).not.toHaveBeenCalled();
  });

  it('loads only when the scrollable commit list reaches its bottom', async () => {
    const source = await readFile(path.join(process.cwd(), 'media', 'main.js'), 'utf8');
    const start = source.indexOf('function onGraphScroll(');
    const end = source.indexOf('\nfunction reachableCommitHashes(', start);
    const requestMoreHistory = vi.fn();
    const scroll = runInNewContext(`${source.slice(start, end)}\nonGraphScroll`, {
      ui: { graphScrollTop: 0 },
      GRAPH_ROW_HEIGHT: 30,
      GRAPH_BOTTOM_EPSILON: 2,
      graphScrollFrame: undefined,
      requestAnimationFrame: () => 1,
      requestMoreHistory
    }) as (event: { currentTarget: { scrollTop: number; scrollHeight: number; clientHeight: number } }) => void;

    scroll({ currentTarget: { scrollTop: 817, clientHeight: 180, scrollHeight: 1000 } });
    expect(requestMoreHistory).not.toHaveBeenCalled();
    scroll({ currentTarget: { scrollTop: 820, clientHeight: 180, scrollHeight: 1000 } });
    expect(requestMoreHistory).toHaveBeenCalledOnce();
    expect(requestMoreHistory).toHaveBeenCalledWith(820);
    scroll({ currentTarget: { scrollTop: 0, clientHeight: 180, scrollHeight: 180 } });
    expect(requestMoreHistory).toHaveBeenCalledOnce();
  });
});
