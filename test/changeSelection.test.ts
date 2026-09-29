import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

async function selection() {
  const context: Record<string, any> = {};
  runInNewContext(await readFile('media/change-selection.js', 'utf8'), context);
  return context.KivoChangeSelection;
}

const changes = [
  { path: 'a.txt', kind: 'modified', staged: true, indexStatus: 'M', workingTreeStatus: '.' },
  { path: 'b.txt', kind: 'modified', staged: false, indexStatus: '.', workingTreeStatus: 'M' },
  { path: 'c.txt', kind: 'modified', staged: true, indexStatus: 'M', workingTreeStatus: 'M' },
  { path: 'd.txt', kind: 'untracked', staged: false, indexStatus: '?', workingTreeStatus: '?' }
];
const snapshot = { changes, changelists: [{ id: 'default', changes }] };

describe('filtered change selection', () => {
  it('selects staged results and ranges without including hidden files', async () => {
    const api = await selection();
    const result = api.model(snapshot, { filter: 'staged' });
    expect(result.visiblePaths).toEqual(['a.txt', 'c.txt']);
    expect(api.range(result.visiblePaths, 'a.txt', 'c.txt')).toEqual(['a.txt', 'c.txt']);
    expect(api.range(result.visiblePaths, 'b.txt', 'c.txt')).toEqual(['c.txt']);
  });

  it('reports hidden selections without silently discarding them', async () => {
    const api = await selection();
    const result = api.model(snapshot, { filter: 'staged', selected: new Set(['b.txt', 'c.txt', 'gone.txt']) });
    expect(result.hiddenCount).toBe(1);
    expect(result.selectedChanges.map((change: any) => change.path)).toEqual(['b.txt', 'c.txt']);
  });

  it('combines search with worktree state and excludes collapsed lists from keyboard selection', async () => {
    const api = await selection();
    expect(api.model(snapshot, { filter: 'worktree' }).visiblePaths).toEqual(['b.txt', 'c.txt', 'd.txt']);
    expect(api.model(snapshot, { filter: 'worktree', query: 'C.TXT' }).visiblePaths).toEqual(['c.txt']);
    const collapsed = api.model(snapshot, { collapsed: new Set(['default']), selected: new Set(['a.txt']) });
    expect(collapsed.visiblePaths).toEqual([]);
    expect(collapsed.hiddenCount).toBe(0);
  });

  it('keeps range selection in the same tracked-first order shown in the file list', async () => {
    const api = await selection();
    const mixed = { changes, changelists: [{ id: 'default', changes: [changes[0], changes[3], changes[1], changes[2]] }] };
    const result = api.model(mixed);
    expect(result.visiblePaths).toEqual(['a.txt', 'b.txt', 'c.txt', 'd.txt']);
    expect(api.range(result.visiblePaths, 'b.txt', 'd.txt')).toEqual(['b.txt', 'c.txt', 'd.txt']);
    expect(mixed.changelists[0]!.changes[1]!.path).toBe('d.txt');
  });
});
