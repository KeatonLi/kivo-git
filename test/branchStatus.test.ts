import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

async function renderBranches(snapshot: Record<string, unknown>, phase = 'idle'): Promise<string> {
  const source = await readFile(path.join(process.cwd(), 'media', 'main.js'), 'utf8');
  const start = source.indexOf('function renderLogBranchRow(');
  const end = source.indexOf('\nfunction renderBranchContextMenu(', start);
  return runInNewContext(`${source.slice(start, end)}\nrenderLogBranchPane(snapshot)`, {
    snapshot,
    ui: {
      logBranchQuery: '', graphBranchFilter: undefined, syncPhase: phase,
      branchGroupsExpanded: { local: true, remote: true, tags: false },
      branchVisibleCounts: { local: 36, remote: 36, tags: 36 }
    },
    BRANCH_PAGE_SIZE: 36,
    icon: (name: string) => `<icon name="${name}">`,
    escapeHtml: (value: unknown) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('"', '&quot;'),
    buildPathTree: (items: Array<Record<string, unknown>>) => ({ directories: new Map(), leaves: items.map((item) => ({ ...item, leaf: item.name })) })
  }) as string;
}

const snapshot = {
  branch: 'main', upstream: 'origin/main', behind: 2, ahead: 3,
  branches: [
    { name: 'other', current: false, remote: false },
    { name: 'main', current: true, remote: false },
    { name: 'origin/main', current: false, remote: true }
  ],
  tags: []
};

describe('History branch status', () => {
  it('puts the current branch first in Local with sync state beside it', async () => {
    const html = await renderBranches(snapshot);
    expect(html).not.toContain('HEAD (Current Branch)');
    expect(html).not.toContain('branch-pane-footer');
    expect(html.indexOf('data-log-branch="main"')).toBeLessThan(html.indexOf('data-log-branch="other"'));
    expect(html).toContain('2 incoming, 3 outgoing · origin/main');
    expect(html).toContain('class="branch-current-sync has-count"');
  });

  it('shows a compact failure state on the current branch', async () => {
    const html = await renderBranches(snapshot, 'error');
    expect(html).toContain('Remote check failed');
    expect(html).toContain('<icon name="warning">');
  });

  it('does not insert an empty Local placeholder when there is no local branch', async () => {
    const html = await renderBranches({ ...snapshot, branches: snapshot.branches.filter((branch) => branch.remote) });
    expect(html).not.toContain('No other local branches');
  });

  it('shows an untracked state and a loading icon without inventing counts', async () => {
    const untracked = await renderBranches({ ...snapshot, upstream: '', behind: 0, ahead: 0 });
    expect(untracked).toContain('No upstream branch');
    expect(untracked).not.toContain('incoming,');
    const fetching = await renderBranches(snapshot, 'fetching');
    expect(fetching).toContain('<icon name="loading">');
  });
});
