import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'node_modules', '@vscode', 'codicons');
const target = resolve(root, 'media', 'codicons');

mkdirSync(target, { recursive: true });
copyFileSync(resolve(source, 'dist', 'codicon.css'), resolve(target, 'codicon.css'));
copyFileSync(resolve(source, 'dist', 'codicon.ttf'), resolve(target, 'codicon.ttf'));
copyFileSync(resolve(source, 'LICENSE'), resolve(target, 'LICENSE.txt'));
