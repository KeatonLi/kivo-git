import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

describe('extension contribution model', () => {
  it('keeps Kivo Git in the bottom Panel and exposes a direct Log command', async () => {
    const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    expect(manifest.contributes.viewsContainers.panel).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'ideaGit', title: 'Kivo Git' })
    ]));
    expect(manifest.contributes.viewsContainers.activitybar).toBeUndefined();
    expect(manifest.contributes.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: 'ideaGit.showLog', title: 'Kivo Git: Show Log' })
    ]));
  });
});
