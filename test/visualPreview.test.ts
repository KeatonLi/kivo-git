import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

describe('visual parity fixture', () => {
  it('executes the production webview assets in both screenshot surfaces', async () => {
    const fixture = await readFile(path.join(root, 'test', 'visual-preview.html'), 'utf8');
    expect(fixture).toContain('/media/main.css');
    expect(fixture).toContain('/media/graph-layout.js');
    expect(fixture).toContain('/media/main.js');
    expect(fixture).toContain("get('surface') === 'changes' ? 'changes' : 'history'");
    expect(fixture).toContain("type: 'commitDetails'");
  });
});
