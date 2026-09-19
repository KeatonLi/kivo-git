import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspace = path.join(root, '.vscode-test-workspace');
await mkdir(workspace, { recursive: true });

await runTests({
  version: '1.95.0',
  extensionDevelopmentPath: root,
  extensionTestsPath: path.join(root, 'test', 'extension', 'index.js'),
  launchArgs: [workspace, '--disable-extensions', '--disable-gpu']
});
