import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

async function renderBranchPane(snapshot: { branch: string; upstream?: string; ahead: number; behind: number }, phase = 'idle'): Promise<string> {
  const source = await readFile(path.join(process.cwd(), 'media', 'main.js'), 'utf8');
  const start = source.indexOf('function renderLogBranchPane(s) {');
  const end = source.indexOf('\nfunction renderBranchContextMenu()', start);
  const context = {
    ui: {
      logBranchQuery: '', branchGroupsExpanded: { local: true, remote: true, tags: false },
      branchVisibleCounts: { local: 36, remote: 36, tags: 36 }, syncPhase: phase,
      operationKind: undefined, busy: false
    },
    icon: (name: string) => `<icon name="${name}">`,
    escapeHtml: (value: unknown) => String(value ?? ''),
    BRANCH_PAGE_SIZE: 36,
    renderLogBranchRow: () => '<button>current</button>',
    buildPathTree: () => ({}),
    renderLogBranchTree: () => ''
  };
  return runInNewContext(`${source.slice(start, end)}\nrenderLogBranchPane(snapshot)`, {
    ...context,
    snapshot: {
      ...snapshot,
      branches: [{ name: snapshot.branch, current: true, remote: false }],
      tags: []
    }
  }) as string;
}

describe('History branch sync summary', () => {
  it('shows both commit differences and a remote refresh action', async () => {
    const html = await renderBranchPane({ branch: 'main', upstream: 'origin/main', behind: 2, ahead: 3 });
    expect(html).toContain('2 behind');
    expect(html).toContain('3 ahead');
    expect(html).toContain('data-action="fetch"');
    expect(html).toContain('Compared with the last fetched origin/main');
  });

  it('does not invent counts without an upstream and marks an in-flight fetch', async () => {
    const untracked = await renderBranchPane({ branch: 'main', behind: 0, ahead: 0 });
    expect(untracked).toContain('No upstream branch');
    const fetching = await renderBranchPane({ branch: 'main', upstream: 'origin/main', behind: 1, ahead: 0 }, 'fetching');
    expect(fetching).toContain('Checking remote');
    expect(fetching).toContain('disabled');
  });
});
