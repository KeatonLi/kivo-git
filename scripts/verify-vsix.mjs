import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import yauzl from 'yauzl';

const sourceManifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const vsixPath = process.argv[2] ?? `${sourceManifest.name}-${sourceManifest.version}.vsix`;
if (!existsSync(vsixPath)) throw new Error(`VSIX does not exist: ${vsixPath}`);

// Read ZIP entries directly so package verification also works on Windows without unzip.
const { list, manifestText } = await new Promise((resolve, reject) => {
  yauzl.open(vsixPath, { lazyEntries: true }, (error, zip) => {
    if (error) return reject(error);
    const list = [];
    let manifestText;
    zip.on('error', reject);
    zip.on('end', () => resolve({ list, manifestText }));
    zip.on('entry', (entry) => {
      list.push(entry.fileName);
      if (entry.fileName !== 'extension/package.json') return zip.readEntry();
      zip.openReadStream(entry, (error, stream) => {
        if (error) { zip.close(); return reject(error); }
        const chunks = [];
        stream.on('error', (error) => { zip.close(); reject(error); });
        stream.on('data', (chunk) => chunks.push(chunk));
        stream.on('end', () => {
          manifestText = Buffer.concat(chunks).toString('utf8');
          zip.readEntry();
        });
      });
    });
    zip.readEntry();
  });
});
const requiredEntries = [
  'extension/package.json',
  'extension/dist/extension.js',
  'extension/media/main.js',
  'extension/media/change-selection.js',
  'extension/media/graph-layout.js',
  'extension/media/main.css',
  'extension/media/kivo-icon.png'
];
for (const entry of requiredEntries) {
  if (!list.includes(entry)) throw new Error(`VSIX is missing required runtime asset: ${entry}`);
}

const manifest = JSON.parse(manifestText);
if (`${manifest.publisher}.${manifest.name}` !== 'KeatonLi.kivo-git') throw new Error('VSIX has the wrong Marketplace extension ID.');
if (manifest.version !== sourceManifest.version) throw new Error('VSIX has the wrong release version.');
const marketplaceCategories = new Set([
  'Programming Languages', 'Snippets', 'Linters', 'Themes', 'Debuggers', 'Formatters',
  'Keymaps', 'SCM Providers', 'Other', 'Extension Packs', 'Language Packs',
  'Data Science', 'Machine Learning', 'Visualization', 'Notebooks', 'Education', 'Testing'
]);
for (const category of manifest.categories ?? []) {
  if (!marketplaceCategories.has(category)) throw new Error(`VSIX has an unsupported Marketplace category: ${category}`);
}
const changes = manifest?.contributes?.views?.ideaGitChanges ?? [];
const history = manifest?.contributes?.views?.ideaGitHistory ?? [];
if (!changes.some((view) => view.id === 'ideaGit.changes')) throw new Error('VSIX is missing the left Changes view.');
if (!history.some((view) => view.id === 'ideaGit.history')) throw new Error('VSIX is missing the bottom History view.');
if (JSON.stringify(manifest?.contributes?.views ?? {}).includes('ideaGit.panel')) throw new Error('VSIX still includes the retired single-panel view.');

console.log(`Verified ${path.basename(vsixPath)}: two Kivo Git surfaces and runtime assets are present.`);
