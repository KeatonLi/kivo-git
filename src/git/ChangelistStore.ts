import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { ChangeList, GitChange } from './types';

interface StoreData {
  lists: Array<{ id: string; name: string }>;
  assignments: Record<string, string>;
  activeId?: string;
}

const DEFAULT_LIST = { id: 'default', name: 'Default Changelist' };
type LockOwner = { pid: number; host: string; token: string };

export class ChangelistStore {
  private readonly file: string;

  constructor(gitDirectory: string) {
    this.file = path.join(gitDirectory, 'ideagit', 'changelists.json');
  }

  isStorageFile(filePath: string): boolean {
    return path.dirname(path.resolve(filePath)) === path.dirname(path.resolve(this.file));
  }

  private async read(): Promise<StoreData> {
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const data = JSON.parse(raw) as StoreData;
      if (!data || !Array.isArray(data.lists) ||
          data.lists.some((item) => !item || typeof item.id !== 'string' || !item.id || typeof item.name !== 'string') ||
          new Set(data.lists.map((item) => item.id)).size !== data.lists.length ||
          (data.assignments !== undefined && (!data.assignments || typeof data.assignments !== 'object' || Array.isArray(data.assignments) ||
            Object.values(data.assignments).some((id) => typeof id !== 'string')))) {
        throw new Error('Invalid changelist data');
      }
      return {
        lists: data.lists.some((item) => item.id === DEFAULT_LIST.id) ? data.lists : [DEFAULT_LIST, ...data.lists],
        assignments: Object.assign(Object.create(null), data.assignments),
        activeId: data.lists.some((item) => item.id === data.activeId) ? data.activeId : DEFAULT_LIST.id
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { lists: [{ ...DEFAULT_LIST }], assignments: Object.create(null), activeId: DEFAULT_LIST.id };
      }
      throw new Error(`Cannot read changelists at ${this.file}. The existing file has been preserved. ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async write(data: StoreData): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(data, null, 2), { encoding: 'utf8', flag: 'wx' });
      await fs.rename(temporary, this.file);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  // Lock the entire read/modify/write, including reads that assign new changes.
  // A second window must not overwrite a more recent assignment.
  private async transaction<T>(action: () => Promise<T>): Promise<T> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const lockPath = `${this.file}.lock`;
    const deadline = Date.now() + 3000;
    const owner: LockOwner = { pid: process.pid, host: os.hostname(), token: randomUUID() };
    const ownerText = JSON.stringify(owner);
    let lock: Awaited<ReturnType<typeof fs.open>> | undefined;
    while (!lock) {
      try {
        lock = await fs.open(lockPath, 'wx');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (await this.recoverStaleLock(lockPath)) continue;
        if (Date.now() >= deadline) throw new Error(`Changelists are locked by another operation. Retry after it finishes. If all other Kivo Git windows are closed, check ${lockPath}.`);
        await delay(25);
      }
    }
    let wroteOwner = false;
    try {
      await lock.writeFile(ownerText, 'utf8');
      wroteOwner = true;
      return await action();
    } finally {
      await lock.close();
      const current = await fs.readFile(lockPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return '';
      });
      if (!wroteOwner || current === ownerText) await fs.unlink(lockPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }

  private async recoverStaleLock(lockPath: string): Promise<boolean> {
    try {
      const stat = await fs.stat(lockPath);
      if (Date.now() - stat.mtimeMs < 5000) return false;
      const content = await fs.readFile(lockPath, 'utf8');
      const owner = JSON.parse(content) as LockOwner;
      if (owner.host !== os.hostname() || !Number.isInteger(owner.pid) || owner.pid < 1 || typeof owner.token !== 'string') return false;
      try {
        process.kill(owner.pid, 0);
        return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false;
      }
      const unchanged = await fs.stat(lockPath);
      if (unchanged.ino !== stat.ino || unchanged.mtimeMs !== stat.mtimeMs || await fs.readFile(lockPath, 'utf8') !== content) return false;
      await fs.unlink(lockPath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return false;
      throw error;
    }
  }

  group(changes: GitChange[]): Promise<ChangeList[]> {
    return this.transaction(() => this.groupUnlocked(changes));
  }

  private async groupUnlocked(changes: GitChange[]): Promise<ChangeList[]> {
    const data = await this.read();
    const existingPaths = new Set(changes.map((change) => change.path));
    let changed = false;
    for (const change of changes) {
      if (change.kind === 'renamed' && change.originalPath && !data.assignments[change.path] && data.assignments[change.originalPath]) {
        data.assignments[change.path] = data.assignments[change.originalPath]!;
        changed = true;
      }
    }
    for (const assignedPath of Object.keys(data.assignments)) {
      if (!existingPaths.has(assignedPath)) {
        delete data.assignments[assignedPath];
        changed = true;
      }
    }
    const activeId = data.activeId ?? DEFAULT_LIST.id;
    const lists = data.lists.map((list) => ({ ...list, active: list.id === activeId, changes: [] as GitChange[] }));
    const listsById = new Map(lists.map((list) => [list.id, list]));
    for (const change of changes) {
      const listId = data.assignments[change.path] ?? activeId;
      if (!data.assignments[change.path]) {
        data.assignments[change.path] = listId;
        changed = true;
      }
      const list = listsById.get(listId) ?? lists[0];
      list?.changes.push(change);
    }
    if (changed) await this.write(data);
    return lists;
  }

  create(name: string): Promise<void> { return this.transaction(() => this.createUnlocked(name)); }

  private async createUnlocked(name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('Changelist name cannot be empty.');
    const data = await this.read();
    if (data.lists.some((item) => item.name.toLowerCase() === trimmed.toLowerCase())) {
      throw new Error(`Changelist “${trimmed}” already exists.`);
    }
    const id = `list-${randomUUID()}`;
    data.lists.push({ id, name: trimmed });
    data.activeId = id;
    await this.write(data);
  }

  rename(id: string, name: string): Promise<void> { return this.transaction(() => this.renameUnlocked(id, name)); }

  private async renameUnlocked(id: string, name: string): Promise<void> {
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

  delete(id: string): Promise<void> { return this.transaction(() => this.deleteUnlocked(id)); }

  private async deleteUnlocked(id: string): Promise<void> {
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

  setActive(id: string): Promise<void> { return this.transaction(() => this.setActiveUnlocked(id)); }

  private async setActiveUnlocked(id: string): Promise<void> {
    const data = await this.read();
    if (!data.lists.some((item) => item.id === id)) throw new Error('Changelist no longer exists.');
    data.activeId = id;
    await this.write(data);
  }

  move(paths: string[], listId: string): Promise<void> { return this.transaction(() => this.moveUnlocked(paths, listId)); }

  private async moveUnlocked(paths: string[], listId: string): Promise<void> {
    const data = await this.read();
    if (!data.lists.some((item) => item.id === listId)) throw new Error('Target changelist no longer exists.');
    for (const filePath of paths) data.assignments[filePath] = listId;
    await this.write(data);
  }
}
