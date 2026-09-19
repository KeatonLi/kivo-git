#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const version = process.argv[2];
const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

if (!version || !semver.test(version)) {
  console.error('Usage: npm run release -- <version>  (example: 0.2.0-beta.1)');
  process.exit(1);
}

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed`);
};
const output = (command, args) => execFileSync(command, args, { encoding: 'utf8' }).trim();

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const repositoryPath = new URL(packageJson.repository.url).pathname.replace(/^\//, '').replace(/\.git$/, '');
const branch = output('git', ['branch', '--show-current']);
const remote = output('git', ['remote', 'get-url', 'origin']);

if (branch !== 'main') throw new Error(`Releases must be created from main, not ${branch || 'detached HEAD'}.`);
if (output('git', ['status', '--porcelain'])) throw new Error('Commit or stash all changes before releasing.');
if (!remote.replace(/\.git$/, '').endsWith(repositoryPath)) throw new Error(`origin does not match ${repositoryPath}.`);

run('git', ['fetch', 'origin', 'main', '--tags']);
run('git', ['merge-base', '--is-ancestor', 'origin/main', 'HEAD']);

run('npm', ['version', version, '--no-git-tag-version']);
const changelogUrl = new URL('../CHANGELOG.md', import.meta.url);
const changelog = readFileSync(changelogUrl, 'utf8');
if (!changelog.includes('## Unreleased')) throw new Error('CHANGELOG.md must contain an Unreleased section.');
const date = new Date().toISOString().slice(0, 10);
writeFileSync(changelogUrl, changelog.replace('## Unreleased', `## Unreleased\n\n## ${version} - ${date}`));
run('npm', ['run', 'package']);
run('git', ['add', 'package.json', 'package-lock.json', 'CHANGELOG.md']);
const tag = `v${version}`;
run('git', ['commit', '-m', `chore(release): ${tag}`]);
run('git', ['push', 'origin', 'main']);

console.log(`\nPushed ${tag}. GitHub Actions will create the tag and attach the VSIX and checksum to the Release.`);
