import { afterEach, describe, expect, it, vi } from 'vitest';
import { InlineBlameCache, inlineBlameLabel } from '../src/inlineBlameModel';
import type { LineBlame } from '../src/git/types';

const blame: LineBlame = {
  hash: 'a'.repeat(40), author: 'A Developer', authorTime: 1_700_000_000,
  summary: 'Improve the current line', line: 2, content: 'example', uncommitted: false
};

afterEach(() => vi.useRealTimers());

describe('inline blame presentation', () => {
  it('keeps committed labels compact and distinguishes uncommitted content', () => {
    expect(inlineBlameLabel(blame, blame.authorTime * 1000 + 2 * 86_400_000)).toBe('A Developer · 2d ago · Improve the current line');
    expect(inlineBlameLabel({ ...blame, uncommitted: true })).toBe('Uncommitted changes');
    expect(inlineBlameLabel({ ...blame, summary: 'very long '.repeat(20) }).length).toBeLessThanOrEqual(72);
  });

  it('deduplicates one line lookup and reuses its cached result', async () => {
    const cache = new InlineBlameCache();
    let resolve!: (value: LineBlame) => void;
    const load = vi.fn(() => new Promise<LineBlame>((done) => { resolve = done; }));
    const first = cache.get('file:2', load);
    const second = cache.get('file:2', load);
    expect(load).toHaveBeenCalledTimes(1);
    resolve(blame);
    expect(await first).toEqual(blame);
    expect(await second).toEqual(blame);
    expect(await cache.get('file:2', load)).toEqual(blame);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('briefly caches missing history, then permits a retry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const cache = new InlineBlameCache();
    const load = vi.fn().mockRejectedValueOnce(new Error('not tracked')).mockResolvedValue(blame);
    expect(await cache.get('untracked:1', load)).toBeNull();
    expect(await cache.get('untracked:1', load)).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date('2026-01-01T00:00:06Z'));
    expect(await cache.get('untracked:1', load)).toEqual(blame);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('does not repopulate invalidated results from an old request', async () => {
    const cache = new InlineBlameCache();
    let resolve!: (value: LineBlame) => void;
    const request = cache.get('file:2', () => new Promise<LineBlame>((done) => { resolve = done; }));
    cache.clear();
    resolve(blame);
    await request;
    expect(cache.peek('file:2')).toBeUndefined();
  });

  it('does not mistake a cancelled lookup for missing history', async () => {
    const cache = new InlineBlameCache();
    const cancelled = Object.assign(new Error('cancelled'), { name: 'AbortError' });
    expect(await cache.get('file:2', async () => { throw cancelled; })).toBeNull();
    expect(cache.peek('file:2')).toBeUndefined();
    expect(await cache.get('file:2', async () => blame)).toEqual(blame);
  });

  it('expires old results and caps the number of remembered lines', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const cache = new InlineBlameCache();
    for (let line = 0; line <= 200; line += 1) await cache.get(`file:${line}`, async () => blame);
    expect(cache.peek('file:0')).toBeUndefined();
    expect(cache.peek('file:200')).toEqual(blame);
    vi.setSystemTime(new Date('2026-01-01T00:00:31Z'));
    expect(cache.peek('file:200')).toBeUndefined();
  });
});
