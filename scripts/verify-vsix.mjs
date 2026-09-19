import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const [vsixPath] = process.argv.slice(2);
if (!vsixPath) throw new Error('Usage: node scripts/verify-vsix.mjs <kivo-git-*.vsix>');
if (!existsSync(vsixPath)) throw new Error(`VSIX does not exist: ${vsixPath}`);

const list = execFileSync('unzip', ['-Z1', vsixPath], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
const requiredEntries = [
  'extension/package.json',
  'extension/dist/extension.js',
  'extension/media/main.js',
  'extension/media/main.css',
  'extension/media/kivo-icon.png'
];
for (const entry of requiredEntries) {
  if (!list.includes(entry)) throw new Error(`VSIX is missing required runtime asset: ${entry}`);
}

const manifest = JSON.parse(execFileSync('unzip', ['-p', vsixPath, 'extension/package.json'], { encoding: 'utf8' }));
const changes = manifest?.contributes?.views?.ideaGitChanges ?? [];
const history = manifest?.contributes?.views?.ideaGitHistory ?? [];
if (!changes.some((view) => view.id === 'ideaGit.changes')) throw new Error('VSIX is missing the left Changes view.');
if (!history.some((view) => view.id === 'ideaGit.history')) throw new Error('VSIX is missing the bottom History view.');
if (JSON.stringify(manifest?.contributes?.views ?? {}).includes('ideaGit.panel')) throw new Error('VSIX still includes the retired single-panel view.');

console.log(`Verified ${path.basename(vsixPath)}: two Kivo Git surfaces and runtime assets are present.`);
