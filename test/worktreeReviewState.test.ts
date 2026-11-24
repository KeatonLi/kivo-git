import { describe, expect, it } from 'vitest';
import { WorktreeReviewState, type WorktreeReviewObservation } from '../src/git/WorktreeReviewState';

const firstHead = 'a'.repeat(40);
const secondHead = 'b'.repeat(40);
const current: WorktreeReviewObservation = { id: 'main', path: '/repo', branch: 'main', head: firstHead, isCurrent: true };
const linked: WorktreeReviewObservation = { id: 'linked', path: '/work/topic with spaces', branch: 'topic', head: firstHead };

function roundTrip(state: WorktreeReviewState): WorktreeReviewState {
  return new WorktreeReviewState(JSON.parse(JSON.stringify(state.serialize())));
}

function select(state: WorktreeReviewState, id = linked.id) {
  const entry = state.entries().find(candidate => candidate.id === id);
  if (!entry) throw new Error(`Missing test worktree ${id}`);
  return entry;
}

describe('WorktreeReviewState', () => {
  it('baselines the initial current entry and stably discovers linked registrations', () => {
    const state = new WorktreeReviewState();
    const locked = { ...linked, detached: true, locked: '', prunable: 'gitdir is missing' };
    expect(state.observe([current, locked])).toBe(true);
    expect(state.entries()).toEqual([
      { ...current, kind: 'unchanged', pending: false, version: 1 },
      { ...locked, kind: 'discovered', pending: true, version: 2 }
    ]);
    expect(state.pending()).toEqual([select(state)]);
    const persisted = state.serialize();
    expect(state.observe([locked, current])).toBe(false);
    expect(state.serialize()).toEqual(persisted);
    const restored = roundTrip(state);
    expect(restored.observe([current, locked])).toBe(false);
    expect(restored.serialize()).toEqual(persisted);
  });

  it('does not create or clear pending work or stale a review when the current workspace switches', () => {
    const state = new WorktreeReviewState();
    state.observe([current, linked]);
    const pinned = select(state);
    expect(state.observe([{ ...current, isCurrent: false }, { ...linked, isCurrent: true }])).toBe(true);
    expect(select(state, current.id)).toMatchObject({ pending: false });
    expect(select(state)).toMatchObject({ pending: true, isCurrent: true, version: pinned.version });
    expect(state.markReviewed(pinned)).toBe(true);
    expect(state.pending()).toEqual([]);
  });

  it('advances checkpoints only when marking the exact observed version', () => {
    let state = new WorktreeReviewState();
    state.observe([current, linked]);
    const discovery = select(state);
    expect(discovery.previousReviewHead).toBeUndefined();
    expect(state.markReviewed(discovery)).toBe(true);
    state = roundTrip(state);
    expect(select(state)).toMatchObject({ pending: false, previousReviewHead: firstHead });
    expect(state.markReviewed(discovery)).toBe(false);

    state.observe([current, { ...linked, head: secondHead }]);
    const anOpenReview = select(state);
    expect(anOpenReview).toMatchObject({ kind: 'changed', pending: true, head: secondHead, previousReviewHead: firstHead });
    state.observe([current, { ...linked, head: secondHead, branch: 'renamed' }]);
    expect(state.markReviewed(anOpenReview)).toBe(false);
    expect(select(state)).toMatchObject({ kind: 'changed', pending: true, branch: 'renamed', previousReviewHead: firstHead });
    expect(state.markReviewed(select(state))).toBe(true);
    expect(select(roundTrip(state))).toMatchObject({ kind: 'unchanged', pending: false, previousReviewHead: secondHead });
  });

  it('permits an explicit baseline checkpoint on the current entry, then detects its HEAD changes', () => {
    const state = new WorktreeReviewState();
    state.observe([current]);
    expect(select(state, current.id).previousReviewHead).toBeUndefined();
    expect(state.markReviewed(select(state, current.id))).toBe(true);
    state.observe([{ ...current, head: secondHead }]);
    expect(state.pending()).toEqual([
      expect.objectContaining({ id: current.id, isCurrent: true, kind: 'changed', previousReviewHead: firstHead })
    ]);
  });

  it('retains a removed worktree through restart and distinguishes a new registration at its path', () => {
    let state = new WorktreeReviewState();
    state.observe([current, linked]);
    state.markReviewed(select(state));
    state.observe([current, { ...linked, head: secondHead }]);
    const pinned = select(state);
    const replacement = { ...linked, id: 'replacement', head: secondHead };
    state.observe([current, replacement]);
    state = roundTrip(state);
    expect(state.pending()).toEqual([
      expect.objectContaining({ ...linked, head: secondHead, kind: 'removed', previousReviewHead: firstHead }),
      expect.objectContaining({ ...replacement, kind: 'discovered' })
    ]);
    expect(select(state, replacement.id).previousReviewHead).toBeUndefined();
    expect(state.observe([replacement, current])).toBe(false);
    expect(state.markReviewed(pinned)).toBe(false);
    const tombstone = select(state);
    expect(state.markReviewed(tombstone)).toBe(true);
    expect(state.markReviewed(tombstone)).toBe(false);
    expect(roundTrip(state).entries().map(entry => entry.id)).toEqual([current.id, replacement.id]);
  });

  it('never reuses a token when a registered identity returns or when a ref changes back', () => {
    const state = new WorktreeReviewState();
    state.observe([current, linked]);
    const first = select(state);
    state.observe([current, { ...linked, head: secondHead }]);
    state.observe([current, linked]);
    expect(state.markReviewed(first)).toBe(false);
    state.observe([current]);
    const removed = select(state);
    state.observe([current, linked]);
    expect(state.markReviewed(removed)).toBe(false);
    expect(select(state)).toMatchObject({ kind: 'discovered', pending: true });
  });

  it('updates metadata without turning an already reviewed worktree into pending work', () => {
    const state = new WorktreeReviewState();
    state.observe([current, linked]);
    state.markReviewed(select(state));
    const pinned = select(state);
    const moved = { ...linked, path: '/work/moved', locked: 'working offline', prunable: '' };
    expect(state.observe([current, moved])).toBe(true);
    expect(select(state)).toMatchObject({ ...moved, kind: 'unchanged', pending: false, previousReviewHead: firstHead });
    expect(state.markReviewed(pinned)).toBe(false);
  });

  it('retains all live registrations and only the most recent 256 unacknowledged removals', () => {
    const state = new WorktreeReviewState();
    const worktrees = Array.from({ length: 300 }, (_, i) => ({ id: `tree-${i}`, path: `/trees/${i}` }));
    state.observe([current, ...worktrees]);
    expect(state.entries()).toHaveLength(301);
    state.observe([current]);
    expect(state.pending()).toHaveLength(256);
    expect(state.pending().map(entry => entry.id)).toEqual(worktrees.slice(-256).map(entry => entry.id));
    expect(roundTrip(state).serialize()).toEqual(state.serialize());
    expect(state.observe([current])).toBe(false);
  });

  it('rejects malformed state and snapshots without retaining mutable external objects', () => {
    const state = new WorktreeReviewState();
    const input = { ...linked, id: '__proto__' };
    state.observe([current, input]);
    input.path = '/changed input';
    const saved = state.serialize();
    const immutableSnapshot = state.serialize();
    const restored = new WorktreeReviewState(saved);
    saved.entries[1]!.path = '/changed saved state';
    state.pending()[0]!.path = '/changed output';
    expect(restored.serialize()).toEqual(immutableSnapshot);
    expect(state.serialize()).toEqual(immutableSnapshot);
    expect(() => state.observe([current, current])).toThrow(TypeError);
    expect(() => state.observe([{ ...current, path: '' }])).toThrow(TypeError);
    expect(state.serialize()).toEqual(immutableSnapshot);

    const first = immutableSnapshot.entries[0]!;
    for (const malformed of [
      { ...immutableSnapshot, schemaVersion: 2 },
      { ...immutableSnapshot, revision: Number.NaN },
      { ...immutableSnapshot, entries: [first, { ...first, version: 2 }] },
      { ...immutableSnapshot, entries: [{ ...first, kind: 'removed', pending: false }] },
      { ...immutableSnapshot, entries: [{ ...first, previousReviewHead: { hash: firstHead } }] }
    ]) {
      const rejected = new WorktreeReviewState(malformed);
      expect(rejected.entries()).toEqual([]);
      expect(rejected.observe([current, linked])).toBe(true);
      expect(rejected.pending().map(entry => entry.id)).toEqual([linked.id]);
    }
  });
});
