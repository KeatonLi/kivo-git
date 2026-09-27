import type { LineBlame } from './git/types';

const CACHE_TTL_MS = 30_000;
const FAILURE_TTL_MS = 5_000;
const MAX_ENTRIES = 200;

export function inlineBlameLabel(blame: LineBlame, now = Date.now()): string {
  if (blame.uncommitted) return 'Uncommitted changes';
  const summary = blame.summary.replace(/\s+/g, ' ').trim();
  const ageMinutes = Math.max(0, Math.floor((now - blame.authorTime * 1000) / 60_000));
  const age = !blame.authorTime ? '' : ageMinutes < 1 ? 'just now' : ageMinutes < 60 ? `${ageMinutes}m ago`
    : ageMinutes < 1440 ? `${Math.floor(ageMinutes / 60)}h ago`
      : ageMinutes < 43200 ? `${Math.floor(ageMinutes / 1440)}d ago`
        : `${Math.floor(ageMinutes / 43200)}mo ago`;
  const author = blame.author.length > 24 ? `${blame.author.slice(0, 23)}…` : blame.author;
  const label = [author, age, summary || blame.hash.slice(0, 8)].filter(Boolean).join(' · ');
  return label.length > 72 ? `${label.slice(0, 71).trimEnd()}…` : label;
}

/** Bounds repeated lookups when the cursor revisits lines or a path has no history. */
export class InlineBlameCache {
  private readonly entries = new Map<string, { value: LineBlame | null; expiresAt: number }>();
  private readonly pending = new Map<string, Promise<LineBlame | null>>();
  private generation = 0;

  peek(key: string, now = Date.now()): LineBlame | null | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return undefined;
    }
    // Refresh insertion order so recently revisited lines stay in the bounded cache.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  async get(key: string, load: () => Promise<LineBlame>): Promise<LineBlame | null> {
    const cached = this.peek(key);
    if (cached !== undefined) return cached;
    const pending = this.pending.get(key);
    if (pending) return pending;
    const generation = this.generation;
    const request = load().then((value) => {
      if (generation === this.generation) this.store(key, value, CACHE_TTL_MS);
      return value;
    }, (error) => {
      if (generation === this.generation && (error as Error)?.name !== 'AbortError') this.store(key, null, FAILURE_TTL_MS);
      return null;
    }).finally(() => {
      if (this.pending.get(key) === request) this.pending.delete(key);
    });
    this.pending.set(key, request);
    return request;
  }

  clear(): void {
    this.generation += 1;
    this.entries.clear();
    // In-flight requests may complete, but callers also check their generation.
    this.pending.clear();
  }

  private store(key: string, value: LineBlame | null, ttl: number): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: Date.now() + ttl });
    while (this.entries.size > MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value!);
  }
}
