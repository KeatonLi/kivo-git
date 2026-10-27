import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verifyExistingRelease } from './check-existing-release.mjs';

const manifest = { name: 'kivo-git', publisher: 'KeatonLi', version: '0.5.9', categories: ['SCM Providers'] };
const release = { tag_name: 'v0.5.9', draft: false, prerelease: false, assets: [
  { name: 'kivo-git-0.5.9.vsix', state: 'uploaded' },
  { name: 'kivo-git-v0.5.9.vsix.sha256', state: 'uploaded' }
] };
const vsix = Buffer.from('package bytes');
const checksum = `${createHash('sha256').update(vsix).digest('hex')}  kivo-git-0.5.9.vsix\n`;

test('accepts only a complete matching release', () => {
  assert.doesNotThrow(() => verifyExistingRelease(release, manifest, manifest, vsix, checksum));
});

test('rejects missing or incomplete assets, draft releases and changed metadata', () => {
  for (const bad of [
    { ...release, assets: [release.assets[0]] },
    { ...release, assets: [{ ...release.assets[0], state: 'new' }, release.assets[1]] },
    { ...release, draft: true },
    { ...release, prerelease: true },
    { ...release, tag_name: 'v0.5.8' }
  ]) assert.throws(() => verifyExistingRelease(bad, manifest, manifest, vsix, checksum), /new version/);
  assert.throws(() => verifyExistingRelease(release, manifest, { ...manifest, publisher: 'other' }, vsix, checksum), /new version/);
});

test('rejects altered bytes, checksum filenames and invalid checksums', () => {
  assert.throws(() => verifyExistingRelease(release, manifest, manifest, Buffer.from('changed'), checksum), /checksum/);
  assert.throws(() => verifyExistingRelease(release, manifest, manifest, vsix, checksum.replace('kivo-git-0.5.9.vsix', '../other')), /checksum/);
  assert.throws(() => verifyExistingRelease(release, manifest, manifest, vsix, ''), /checksum/);
});
