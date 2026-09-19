import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ChangeList, GitChange } from './types';

interface StoreData {
  lists: Array<{ id: string; name: string }>;
  assignments: Record<string, string>;
  activeId?: string;
}

const DEFAULT_LIST = { id: 'default', name: 'Default Changelist' };

export class ChangelistStore {
  private readonly file: string;

  constructor(gitDirectory: string) {
    this.file = path.join(gitDirectory, 'ideagit', 'changelists.json');
  }

  private async read(): Promise<StoreData> {
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const data = JSON.parse(raw) as StoreData;
      return {
        lists: data.lists.some((item) => item.id === DEFAULT_LIST.id) ? data.lists : [DEFAULT_LIST, ...data.lists],
        assignments: data.assignments ?? {},
        activeId: data.lists.some((item) => item.id === data.activeId) ? data.activeId : DEFAULT_LIST.id
      };
    } catch {
      return { lists: [DEFAULT_LIST], assignments: {}, activeId: DEFAULT_LIST.id };
    }
  }

  private async write(data: StoreData): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(data, null, 2), 'utf8');
  }

  async group(changes: GitChange[]): Promise<ChangeList[]> {
    const data = await this.read();
    const existingPaths = new Set(changes.map((change) => change.path));
    let changed = false;
    for (const assignedPath of Object.keys(data.assignments)) {
      if (!existingPaths.has(assignedPath)) {
        delete data.assignments[assignedPath];
        changed = true;
      }
    }
    const activeId = data.activeId ?? DEFAULT_LIST.id;
    const lists = data.lists.map((list) => ({ ...list, active: list.id === activeId, changes: [] as GitChange[] }));
    for (const change of changes) {
      const listId = data.assignments[change.path] ?? activeId;
      if (!data.assignments[change.path]) {
        data.assignments[change.path] = listId;
        changed = true;
      }
      const list = lists.find((candidate) => candidate.id === listId) ?? lists[0];
      list?.changes.push(change);
    }
    if (changed) await this.write(data);
    return lists;
  }

  async create(name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('Changelist name cannot be empty.');
    const data = await this.read();
    if (data.lists.some((item) => item.name.toLowerCase() === trimmed.toLowerCase())) {
      throw new Error(`Changelist “${trimmed}” already exists.`);
    }
    const id = `list-${Date.now().toString(36)}`;
    data.lists.push({ id, name: trimmed });
    data.activeId = id;
    await this.write(data);
  }

  async rename(id: string, name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('Changelist name cannot be empty.');
    const data = await this.read();
    const list = data.lists.find((item) => item.id === id);
    if (!list) throw new Error('Changelist no longer exists.');
    if (data.lists.some((item) => item.id !== id && item.name.toLowerCase() === trimmed.toLowerCase())) {
      throw new Error(`Changelist “${trimmed}” already exists.`);
    }
    list.name = trimmed;
    await this.write(data);
  }

  async delete(id: string): Promise<void> {
    if (id === DEFAULT_LIST.id) throw new Error('The default changelist cannot be deleted.');
    const data = await this.read();
    if (!data.lists.some((item) => item.id === id)) throw new Error('Changelist no longer exists.');
    data.lists = data.lists.filter((item) => item.id !== id);
    for (const [filePath, listId] of Object.entries(data.assignments)) {
      if (listId === id) data.assignments[filePath] = DEFAULT_LIST.id;
    }
    if (data.activeId === id) data.activeId = DEFAULT_LIST.id;
    await this.write(data);
  }

  async setActive(id: string): Promise<void> {
    const data = await this.read();
    if (!data.lists.some((item) => item.id === id)) throw new Error('Changelist no longer exists.');
    data.activeId = id;
    await this.write(data);
  }

  async move(paths: string[], listId: string): Promise<void> {
    const data = await this.read();
    if (!data.lists.some((item) => item.id === listId)) throw new Error('Target changelist no longer exists.');
    for (const filePath of paths) data.assignments[filePath] = listId;
    await this.write(data);
  }
}
