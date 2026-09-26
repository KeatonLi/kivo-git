import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { KivoViewTypes } from '../src/viewLayout';

const root = process.cwd();

describe('extension contribution model', () => {
  it('keeps Commit in the left Activity Bar and Kivo Git History in the bottom Panel', async () => {
    const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    expect(manifest.contributes.viewsContainers.activitybar).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'ideaGitChanges', title: 'Kivo Git' })
    ]));
    expect(manifest.contributes.viewsContainers.panel).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'ideaGitHistory', title: 'Kivo Git History' })
    ]));
    expect(manifest.contributes.views.ideaGitChanges).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: KivoViewTypes.changes, name: 'Commit' })
    ]));
    expect(manifest.contributes.views.ideaGitHistory).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: KivoViewTypes.history, name: 'History' })
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
      expect.objectContaining({ command: 'ideaGit.showLog', title: 'Kivo Git: Show History', icon: '$(history)' }),
      expect.objectContaining({ command: 'ideaGit.showLineBlame', title: 'Kivo Git: Show Line Blame', icon: '$(git-commit)' })
    ]));
    expect(manifest.contributes.menus['editor/context']).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: 'ideaGit.showLineBlame', when: 'editorTextFocus && resourceScheme == file' })
    ]));
  });

  it('adds focused Kivo Git actions to the Explorer file context menu', async () => {
    const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    expect(manifest.contributes.submenus).toContainEqual({ id: 'ideaGit.explorer', label: 'Kivo Git' });
    expect(manifest.contributes.menus['explorer/context']).toEqual(expect.arrayContaining([
      expect.objectContaining({ submenu: 'ideaGit.explorer', when: 'resourceScheme == file && !explorerResourceIsFolder' })
    ]));
    expect(manifest.contributes.menus['ideaGit.explorer']).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: 'ideaGit.openResourceDiff' }),
      expect.objectContaining({ command: 'ideaGit.showFileHistory' }),
      expect.objectContaining({ command: 'ideaGit.showResourceInChanges' }),
      expect.objectContaining({ command: 'ideaGit.moveResourceToChangelist' })
    ]));
  });

  it('keeps a native History button in the Commit view title', async () => {
    const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    expect(manifest.contributes.menus['view/title']).toEqual(expect.arrayContaining([
      expect.objectContaining({
        command: 'ideaGit.showLog',
        when: 'view == ideaGit.changes',
        group: 'navigation@1'
      }),
      expect.objectContaining({
        command: 'ideaGit.refresh',
        group: 'navigation@2'
      })
    ]));
  });
});
