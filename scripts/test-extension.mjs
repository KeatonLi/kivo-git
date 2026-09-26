import { mkdir, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspace = path.join(root, '.vscode-test-workspace');
const isolatedProfile = await mkdtemp(path.join(os.tmpdir(), 'kivo-git-extension-test-'));
await mkdir(workspace, { recursive: true });

await runTests({
  ...(process.env.KIVO_VSCODE_EXECUTABLE_PATH
    ? { vscodeExecutablePath: process.env.KIVO_VSCODE_EXECUTABLE_PATH }
    : { version: '1.95.0' }),
  extensionDevelopmentPath: root,
  extensionTestsPath: path.join(root, 'test', 'extension', 'index.js'),
  launchArgs: [
    workspace,
    '--user-data-dir', path.join(isolatedProfile, 'user-data'),
    '--extensions-dir', path.join(isolatedProfile, 'extensions'),
    '--disable-extensions',
    '--disable-gpu'
  ]
});
