import { describe, expect, it, vi } from 'vitest';
import { SnapshotCoordinator } from '../src/SnapshotCoordinator';
import type { RepositorySnapshot } from '../src/git/types';

const snapshot = (branch: string) => ({ branch } as RepositorySnapshot);
const flush = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); };

describe('SnapshotCoordinator', () => {
  it('skips identical states and publishes only changed snapshots', async () => {
    const read = vi.fn().mockResolvedValue(snapshot('main'));
    const publish = vi.fn().mockResolvedValue(undefined);
    const coordinator = new SnapshotCoordinator(read, publish, vi.fn());
    coordinator.request();
    await flush();
    coordinator.request();
    await flush();
    expect(read).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('drops an obsolete read and publishes the latest result', async () => {
    let finish!: (value: RepositorySnapshot) => void;
    const read = vi.fn().mockImplementationOnce(() => new Promise<RepositorySnapshot>((resolve) => { finish = resolve; }))
      .mockResolvedValueOnce(snapshot('feature'));
    const publish = vi.fn().mockResolvedValue(undefined);
    const coordinator = new SnapshotCoordinator(read, publish, vi.fn());
    coordinator.request();
    coordinator.request();
    finish(snapshot('main'));
    await flush();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(snapshot('feature'));
  });

  it('does not publish a read from before a write, and refreshes afterward', async () => {
    let finish!: (value: RepositorySnapshot) => void;
    const read = vi.fn().mockImplementationOnce(() => new Promise<RepositorySnapshot>((resolve) => { finish = resolve; }))
      .mockResolvedValueOnce(snapshot('new'));
    const publish = vi.fn().mockResolvedValue(undefined);
    const coordinator = new SnapshotCoordinator(read, publish, vi.fn());
    coordinator.request();
    coordinator.beginWrite();
    finish(snapshot('old'));
    await flush();
    expect(publish).not.toHaveBeenCalled();
    coordinator.endWrite();
    await flush();
    expect(publish).toHaveBeenCalledWith(snapshot('new'));
  });

  it('publishes the same state again after reset', async () => {
    const publish = vi.fn().mockResolvedValue(undefined);
    const coordinator = new SnapshotCoordinator(() => Promise.resolve(snapshot('main')), publish, vi.fn());
    coordinator.request();
    await flush();
    coordinator.reset();
    coordinator.request();
    await flush();
    expect(publish).toHaveBeenCalledTimes(2);
  });
});
