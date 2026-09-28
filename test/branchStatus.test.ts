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
    icon: (name: string, className?: string) => `<icon name="${name}"${className ? ` class="${className}"` : ''}>`,
    escapeHtml: (value: unknown) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('"', '&quot;'),
    buildPathTree: (items: Array<Record<string, unknown>>) => ({ directories: new Map(), leaves: items.map((item) => ({ ...item, leaf: item.name })) })
  }) as string;
}

const snapshot = {
  branch: 'main', upstream: 'origin/main', behind: 2, ahead: 3,
  branches: [
    { name: 'other', current: false, remote: false, upstream: 'origin/other', tracking: '<' },
    { name: 'main', current: true, remote: false, upstream: 'origin/main', tracking: '<>' },
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
    expect(html).toContain('class="branch-sync-indicator"');
    expect(html).toContain('<icon name="arrow-down" class="branch-sync-incoming">');
    expect(html).toContain('<icon name="arrow-up" class="branch-sync-outgoing">');
    expect(html).toContain('Incoming commits · origin/other');
    expect(html).toContain('data-update-branch="other"');
    expect(html).not.toContain('data-update-branch="main"');
  });

  it('shows a direction for each changed local branch and leaves clean and remote branches plain', async () => {
    const html = await renderBranches({ ...snapshot, behind: 0, ahead: 0, branches: [
      { name: 'main', current: true, remote: false, upstream: 'origin/main', tracking: '=' },
      { name: 'behind', current: false, remote: false, upstream: 'origin/behind', tracking: '<' },
      { name: 'ahead', current: false, remote: false, upstream: 'origin/ahead', tracking: '>' },
      { name: 'both', current: false, remote: false, upstream: 'origin/both', tracking: '<>' },
      { name: 'clean', current: false, remote: false, upstream: 'origin/clean', tracking: '=' },
      { name: 'origin/ahead', current: false, remote: true }
    ] });
    const row = (name: string) => html.match(new RegExp(`<button class="log-branch-row[^>]*data-log-branch="${name}"[^>]*>(.*?)</button>`))?.[1] || '';
    expect(row('main')).not.toContain('branch-sync-indicator');
    expect(row('behind')).toContain('branch-sync-incoming');
    expect(row('behind')).not.toContain('branch-sync-outgoing');
    expect(row('ahead')).toContain('branch-sync-outgoing');
    expect(row('ahead')).not.toContain('branch-sync-incoming');
    expect(row('both')).toContain('branch-sync-incoming');
    expect(row('both')).toContain('branch-sync-outgoing');
    expect(row('clean')).not.toContain('branch-sync-indicator');
    expect(row('origin/ahead')).not.toContain('branch-sync-indicator');
  });

  it('shows a compact failure state on the current branch', async () => {
    const html = await renderBranches(snapshot, 'error');
    expect(html).toContain('Remote check failed');
    expect(html).toContain('<icon name="warning" class="branch-sync-error">');
  });

  it('does not insert an empty Local placeholder when there is no local branch', async () => {
    const html = await renderBranches({ ...snapshot, branches: snapshot.branches.filter((branch) => branch.remote) });
    expect(html).not.toContain('No other local branches');
  });

  it('does not claim a remote difference for an untracked or clean current branch', async () => {
    const untracked = await renderBranches({ ...snapshot, upstream: '', behind: 0, ahead: 0 });
    expect(untracked.match(/data-log-branch="main"[^>]*>(.*?)<\/button>/)?.[1]).not.toContain('branch-sync-indicator');
    const clean = await renderBranches({ ...snapshot, behind: 0, ahead: 0 });
    expect(clean.match(/data-log-branch="main"[^>]*>(.*?)<\/button>/)?.[1]).not.toContain('branch-sync-indicator');
  });
});
