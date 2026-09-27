import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ChangelistStore } from '../src/git/ChangelistStore';
import type { GitChange } from '../src/git/types';

const roots: string[] = [];
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kivo-store-'));
  roots.push(root);
  return { root, store: new ChangelistStore(root), file: path.join(root, 'ideagit', 'changelists.json') };
}
const change = (file: string): GitChange => ({ path: file, kind: 'modified', staged: false, indexStatus: '.', workingTreeStatus: 'M' });
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

describe('changelist data safety', () => {
  it('identifies its own storage events without excluding ordinary repository files', async () => {
    const { store, root, file } = await setup();
    expect(store.isStorageFile(file)).toBe(true);
    expect(store.isStorageFile(`${file}.lock`)).toBe(true);
    expect(store.isStorageFile(`${file}.unique.tmp`)).toBe(true);
    expect(store.isStorageFile(path.join(root, 'config'))).toBe(false);
    expect(store.isStorageFile(path.join(root, 'ideagit-other', 'file.txt'))).toBe(false);
  });
  it('preserves invalid JSON and invalid schemas instead of overwriting user data', async () => {
    const { store, file } = await setup();
    await fs.mkdir(path.dirname(file));
    for (const content of ['{broken', '{"lists":null}', '{"lists":[],"assignments":42}']) {
      await fs.writeFile(file, content);
      await expect(store.group([change('a.txt')])).rejects.toThrow('preserved');
      expect(await fs.readFile(file, 'utf8')).toBe(content);
    }
  });

  it('migrates a renamed file from its old non-active changelist', async () => {
    const { store } = await setup();
    await store.create('Feature');
    const initial = await store.group([change('old.txt')]);
    const feature = initial.find((list) => list.name === 'Feature')!;
    await store.setActive('default');
    const grouped = await store.group([{ ...change('new.txt'), kind: 'renamed', originalPath: 'old.txt', indexStatus: 'R' }]);
    expect(grouped.find((list) => list.id === feature.id)?.changes.map((item) => item.path)).toEqual(['new.txt']);
    expect(grouped.find((list) => list.id === 'default')?.changes).toEqual([]);
  });

  it('serializes writers across instances and treats prototype-like filenames as ordinary paths', async () => {
    const { root, store, file } = await setup();
    await Promise.all([store.create('A'), new ChangelistStore(root).create('B')]);
    const lists = await store.group([change('__proto__'), change('constructor')]);
    expect(lists.map((list) => list.name).sort()).toEqual(['A', 'B', 'Default Changelist']);
    expect(lists.flatMap((list) => list.changes)).toHaveLength(2);
    expect(JSON.parse(await fs.readFile(file, 'utf8')).assignments.__proto__).toEqual(expect.any(String));
    expect(await fs.readdir(path.dirname(file))).toEqual(['changelists.json']);
  });
});
