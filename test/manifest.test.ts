import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { KivoViewTypes } from '../src/viewLayout';

const root = process.cwd();

describe('extension contribution model', () => {
  it('keeps Commit in the left Activity Bar and Log in the bottom Panel', async () => {
    const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    expect(manifest.contributes.viewsContainers.activitybar).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'ideaGitChanges', title: 'Kivo Git' })
    ]));
    expect(manifest.contributes.viewsContainers.panel).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'ideaGitHistory', title: 'Kivo Git' })
    ]));
    expect(manifest.contributes.views.ideaGitChanges).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: KivoViewTypes.changes, name: 'Commit' })
    ]));
    expect(manifest.contributes.views.ideaGitHistory).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: KivoViewTypes.history, name: 'Log' })
    ]));
    expect(JSON.stringify(manifest.contributes.views)).not.toContain('ideaGit.panel');
    expect(manifest.activationEvents).toEqual(expect.arrayContaining([
      `onView:${KivoViewTypes.changes}`,
      `onView:${KivoViewTypes.history}`
    ]));
  });

  it('exposes direct commands for the two independently focusable surfaces', async () => {
    const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    expect(manifest.contributes.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: 'ideaGit.showChanges', title: 'Kivo Git: Show Changes' }),
      expect.objectContaining({ command: 'ideaGit.showLog', title: 'Kivo Git: Show Log' })
    ]));
  });
});
