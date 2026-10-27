#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Called before deciding to skip an existing release. Never repairs or replaces
// published assets; a failed check needs investigation and a new version.
export function verifyExistingRelease(release, current, manifest, vsix, checksum) {
  const version = current.version;
  const tag = `v${version}`;
  const vsixName = `kivo-git-${version}.vsix`;
  const checksumName = `kivo-git-${tag}.vsix.sha256`;
  const fail = (reason) => { throw new Error(`${reason} Investigate the existing release and use a new version; do not replace published assets.`); };

  if (release.tag_name !== tag || release.draft || release.prerelease !== version.includes('-')) fail('Release metadata does not match.');
  for (const name of [vsixName, checksumName]) {
    const matching = (release.assets ?? []).filter((asset) => asset.name === name);
    if (matching.length !== 1 || matching[0].state !== 'uploaded') fail(`Missing or incomplete release asset: ${name}.`);
  }
  for (const field of ['name', 'publisher', 'version', 'categories']) {
    if (JSON.stringify(manifest[field]) !== JSON.stringify(current[field])) fail(`VSIX manifest ${field} does not match.`);
  }
  const digest = createHash('sha256').update(vsix).digest('hex');
  // Accept the standard sha256sum text form only; never read a path from an
  // untrusted checksum file or silently accept another filename.
  if (checksum !== `${digest}  ${vsixName}\n`) fail('VSIX checksum does not match.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [releaseFile, sourceFile, directory] = process.argv.slice(2);
  if (!releaseFile || !sourceFile || !directory) throw new Error('Usage: check-existing-release.mjs <release.json> <package.json> <directory>');
  const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
  const current = json(sourceFile);
  verifyExistingRelease(
    json(releaseFile), current, json(join(directory, 'manifest.json')),
    readFileSync(join(directory, `kivo-git-${current.version}.vsix`)),
    readFileSync(join(directory, `kivo-git-v${current.version}.vsix.sha256`), 'utf8')
  );
}
