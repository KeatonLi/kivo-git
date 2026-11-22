import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVSIX } from '@vscode/vsce';
import { expect, test } from 'vitest';

const root = join(__dirname, '..');
const maxIconSize = 1024 * 1024;

async function verifyFixture(oversized: boolean) {
  const directory = await mkdtemp(join(tmpdir(), 'kivo-verify-vsix-'));
  try {
    const { name, publisher, version, engines, categories, repository, icon } = JSON.parse(
      await readFile(join(root, 'package.json'), 'utf8')
    );
    const iconBytes = await readFile(join(root, icon));
    const manifestIcon = oversized ? './media/marketplace-icon.png' : icon;
    await mkdir(join(directory, 'dist'));
    await mkdir(join(directory, 'media'));
    await writeFile(join(directory, 'package.json'), JSON.stringify({
      name, publisher, version, engines, categories, repository, icon: manifestIcon,
      main: './dist/extension.js', files: ['dist', 'media'],
      contributes: { views: {
        ideaGitChanges: [{ id: 'ideaGit.changes', name: 'Commit' }],
        ideaGitHistory: [{ id: 'ideaGit.history', name: 'History' }]
      } }
    }));
    for (const entry of ['dist/extension.js', 'media/main.js', 'media/change-selection.js', 'media/graph-layout.js', 'media/main.css']) {
      await writeFile(join(directory, entry), '');
    }
    await writeFile(join(directory, icon), iconBytes);
    if (oversized) {
      // Keep the real icon in the archive, but point the manifest at a highly compressible oversized entry.
      const padded = Buffer.alloc(maxIconSize + 1);
      iconBytes.copy(padded);
      await writeFile(join(directory, manifestIcon), padded);
    }
    const vsix = join(directory, 'fixture.vsix');
    await createVSIX({ cwd: directory, packagePath: vsix, dependencies: false, skipLicense: true });
    const result = spawnSync(process.execPath, [join(root, 'scripts', 'verify-vsix.mjs'), vsix], { encoding: 'utf8' });
    if (result.error) throw result.error;
    return { ...result, archiveSize: (await stat(vsix)).size };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('VSIX verifier accepts the current packaged Marketplace icon', async () => {
  const result = await verifyFixture(false);
  expect(result.status, result.stderr).toBe(0);
});

test('VSIX verifier checks the uncompressed size of the manifest icon rather than the usual icon path', async () => {
  const result = await verifyFixture(true);
  expect(result.archiveSize).toBeLessThan(maxIconSize);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('./media/marketplace-icon.png is 1048577 bytes; the limit is 1024 KiB');
});
