export interface WorktreeReviewObservation {
  /** Stable identity of this registration within the common Git directory, not its checkout path. */
  id: string;
  path: string;
  head?: string;
  branch?: string;
  isCurrent?: boolean;
  bare?: boolean;
  detached?: boolean;
  /** Git porcelain reasons; the empty string still denotes the presence of the flag. */
  locked?: string;
  prunable?: string;
}

export interface WorktreeReviewEntry extends WorktreeReviewObservation {
  /** A repository-local token for the exact observation and checkpoint shown to the reviewer. */
  version: number;
  kind: 'discovered' | 'changed' | 'removed' | 'unchanged';
  pending: boolean;
  previousReviewHead?: string;
}

export interface WorktreeReviewSnapshot {
  schemaVersion: 1;
  initialized: boolean;
  revision: number;
  entries: WorktreeReviewEntry[];
}

// Live registrations always stay tracked. Only orphaned pending removals have a retention limit.
const MAX_TOMBSTONES = 256;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && !value.includes('\0');
}

function parseObservation(value: unknown): WorktreeReviewObservation | undefined {
  if (!isRecord(value) || !isText(value.id) || !value.id || !isText(value.path) || !value.path) return;
  const observation: WorktreeReviewObservation = { id: value.id, path: value.path };
  for (const field of ['head', 'branch', 'locked', 'prunable'] as const) {
    const item = value[field];
    if (item === undefined) continue;
    if (!isText(item) || (!item && (field === 'head' || field === 'branch'))) return;
    observation[field] = item;
  }
  for (const field of ['isCurrent', 'bare', 'detached'] as const) {
    const item = value[field];
    if (item !== undefined && typeof item !== 'boolean') return;
    if (item) observation[field] = true;
  }
  return observation;
}

function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function readSnapshot(value: unknown): WorktreeReviewSnapshot | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.initialized !== 'boolean' ||
      !isRevision(value.revision) || !Array.isArray(value.entries) ||
      (!value.initialized && (value.revision !== 0 || value.entries.length !== 0))) return;
  const entries: WorktreeReviewEntry[] = [];
  const ids = new Set<string>();
  const versions = new Set<number>();
  for (const item of value.entries) {
    if (!isRecord(item)) return;
    const observation = parseObservation(item);
    const { kind, pending, previousReviewHead, version } = item;
    if (!observation || ids.has(observation.id) || !isRevision(version) || version === 0 ||
        version > value.revision || versions.has(version) ||
        (kind !== 'discovered' && kind !== 'changed' && kind !== 'removed' && kind !== 'unchanged') ||
        pending !== (kind !== 'unchanged') || (kind === 'removed' && observation.isCurrent) ||
        (previousReviewHead !== undefined && (!isText(previousReviewHead) || !previousReviewHead))) return;
    ids.add(observation.id);
    versions.add(version);
    const entry: WorktreeReviewEntry = { ...observation, version, kind, pending };
    if (previousReviewHead !== undefined) entry.previousReviewHead = previousReviewHead;
    entries.push(entry);
  }
  return { schemaVersion: 1, initialized: value.initialized, revision: value.revision, entries };
}

function nextRevision(revision: number): number {
  const next = revision + 1;
  if (!Number.isSafeInteger(next)) throw new RangeError('Worktree review revision limit reached');
  return next;
}

function pruneTombstones(records: Map<string, WorktreeReviewEntry>): void {
  const removed = Array.from(records.values()).filter(entry => entry.kind === 'removed');
  if (removed.length <= MAX_TOMBSTONES) return;
  removed.sort((left, right) => right.version - left.version);
  for (const entry of removed.slice(MAX_TOMBSTONES)) records.delete(entry.id);
}

/** Observation and checkpoint state for one repository; callers own discovery and persistence. */
export class WorktreeReviewState {
  private records = new Map<string, WorktreeReviewEntry>();
  private initialized = false;
  private revision = 0;

  constructor(persisted?: unknown) {
    const snapshot = readSnapshot(persisted);
    if (!snapshot) return;
    this.initialized = snapshot.initialized;
    this.revision = snapshot.revision;
    this.records = new Map(snapshot.entries.map(entry => [entry.id, entry]));
    pruneTombstones(this.records);
  }

  /** Apply a complete, successful list. On read failure, callers must leave the last snapshot intact. */
  observe(observations: readonly WorktreeReviewObservation[]): boolean {
    const observed = new Map<string, WorktreeReviewObservation>();
    for (const input of observations) {
      const observation = parseObservation(input);
      if (!observation || observed.has(observation.id)) throw new TypeError('Invalid worktree review observation');
      observed.set(observation.id, observation);
    }

    let changed = !this.initialized;
    let revision = this.revision;
    const records = new Map(this.records);
    for (const [id, observation] of observed) {
      const previous = records.get(id);
      const discovered = !previous || previous.kind === 'removed';
      const refChanged = previous?.head !== observation.head || previous?.branch !== observation.branch;
      const versionChanged = discovered || refChanged || previous.path !== observation.path ||
        previous.bare !== observation.bare || previous.detached !== observation.detached ||
        previous.locked !== observation.locked || previous.prunable !== observation.prunable;
      if (!versionChanged && previous.isCurrent === observation.isCurrent) continue;
      changed = true;
      const kind = discovered ? (!this.initialized && observation.isCurrent ? 'unchanged' : 'discovered')
        : refChanged ? 'changed' : previous.kind;
      if (versionChanged) revision = nextRevision(revision);
      const entry: WorktreeReviewEntry = {
        ...observation, version: versionChanged ? revision : previous.version, kind, pending: kind !== 'unchanged'
      };
      if (previous?.previousReviewHead !== undefined) entry.previousReviewHead = previous.previousReviewHead;
      records.set(id, entry);
    }
    for (const [id, previous] of this.records) {
      if (observed.has(id) || previous.kind === 'removed') continue;
      changed = true;
      revision = nextRevision(revision);
      const tombstone: WorktreeReviewEntry = { ...previous, version: revision, kind: 'removed', pending: true };
      delete tombstone.isCurrent;
      records.set(id, tombstone);
    }

    if (changed) {
      pruneTombstones(records);
      this.records = records;
      this.revision = revision;
      this.initialized = true;
    }
    return changed;
  }

  entries(): WorktreeReviewEntry[] {
    return Array.from(this.records.values(), entry => ({ ...entry }));
  }

  pending(): WorktreeReviewEntry[] {
    return this.entries().filter(entry => entry.pending);
  }

  /** Reject a stale token rather than moving the checkpoint past what was actually reviewed. */
  markReviewed(entry: Pick<WorktreeReviewEntry, 'id' | 'version'>): boolean {
    const record = this.records.get(entry.id);
    if (!record || record.version !== entry.version) return false;
    if (record.kind === 'removed') {
      this.records.delete(record.id);
    } else if (record.pending || record.previousReviewHead !== record.head) {
      this.revision = nextRevision(this.revision);
      const reviewed: WorktreeReviewEntry = { ...record, version: this.revision, kind: 'unchanged', pending: false };
      if (record.head === undefined) delete reviewed.previousReviewHead;
      else reviewed.previousReviewHead = record.head;
      this.records.set(record.id, reviewed);
    }
    return true;
  }

  serialize(): WorktreeReviewSnapshot {
    return { schemaVersion: 1, initialized: this.initialized, revision: this.revision, entries: this.entries() };
  }
}
