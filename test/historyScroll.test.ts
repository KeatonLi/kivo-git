import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

describe('History pagination gesture', () => {
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
