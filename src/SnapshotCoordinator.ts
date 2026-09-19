import type { RepositorySnapshot } from './git/types';

/** Serializes reads and never publishes a read invalidated by a newer request or write. */
export class SnapshotCoordinator {
  private requested = 0;
  private published = '';
  private running = false;
  private writing = false;
  private queued = false;

  constructor(
    private readonly read: () => Promise<RepositorySnapshot>,
    private readonly publish: (snapshot: RepositorySnapshot) => Promise<void>,
    private readonly report: (error: unknown) => void
  ) {}

  request(): void {
    this.requested += 1;
    this.queued = true;
    void this.drain();
  }

  beginWrite(): void {
    this.writing = true;
    this.requested += 1;
  }

  endWrite(): void {
    this.writing = false;
    this.request();
  }

  reset(): void {
    this.requested += 1;
    this.published = '';
    this.queued = false;
  }

  private async drain(): Promise<void> {
    if (this.running || this.writing || !this.queued) return;
    this.running = true;
    try {
      while (this.queued && !this.writing) {
        this.queued = false;
        const generation = this.requested;
        try {
          const snapshot = await this.read();
          if (generation !== this.requested || this.writing) continue;
          const fingerprint = JSON.stringify(snapshot);
          if (fingerprint !== this.published) {
            await this.publish(snapshot);
            this.published = fingerprint;
          }
        } catch (error) {
          if (generation === this.requested) this.report(error);
        }
      }
    } finally {
      this.running = false;
      if (this.queued && !this.writing) void this.drain();
    }
  }
}
