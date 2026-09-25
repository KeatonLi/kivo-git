import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

async function renderBrief(snapshot: Record<string, unknown>, syncPhase = 'idle'): Promise<string> {
  const source = await readFile(path.join(process.cwd(), 'media', 'main.js'), 'utf8');
  const start = source.indexOf('function renderWorkspaceBrief(s) {');
  const end = source.indexOf('\nfunction renderFile(', start);
  return runInNewContext(`${source.slice(start, end)}\nrenderWorkspaceBrief(snapshot)`, {
    snapshot,
    ui: { syncPhase, operationKind: undefined, busy: false, lastFetchedAt: 1234, syncError: 'remote unavailable' },
    icon: (name: string) => `<icon name="${name}">`,
    escapeHtml: (value: unknown) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('"', '&quot;'),
    updatedLabel: () => 'Updated 2m ago'
  }) as string;
}

describe('Commit workspace status', () => {
  it('renders real local changes and both remote differences', async () => {
    const html = await renderBrief({ branch: 'main', upstream: 'origin/main', changes: [{ path: 'a' }, { path: 'b' }], behind: 3, ahead: 2 });
    expect(html).toContain('2 changed files');
    expect(html).toContain('origin/main');
    expect(html).toContain('<strong>3</strong><small>to pull</small>');
    expect(html).toContain('<strong>2</strong><small>to push</small>');
    expect(html).toContain('Updated 2m ago');
    expect(html).toContain('Local and remote have diverged');
    expect(html).toContain('data-action="fetch"');
  });

  it('shows a clean tree and makes missing upstream and fetch errors explicit', async () => {
    const html = await renderBrief({ changes: [], behind: 0, ahead: 0 }, 'error');
    expect(html).toContain('Working tree clean');
    expect(html).toContain('No upstream branch');
    expect(html).toContain('Remote check failed');
    expect(html).not.toContain('to pull');
  });

  it('marks remote comparison as in progress while fetching', async () => {
    const html = await renderBrief({ branch: 'main', upstream: 'origin/main', changes: [], behind: 0, ahead: 1 }, 'fetching');
    expect(html).toContain('Local commits ready to push');
    expect(html).toContain('Checking remote…');
    expect(html).toContain('data-action="fetch"');
    expect(html).toContain('disabled');
  });
});
