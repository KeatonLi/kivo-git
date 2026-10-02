import { describe, expect, it } from 'vitest';
import { PushReviewSession } from '../src/PushReviewSession';
import type { PushPreview } from '../src/git/types';

const preview: PushPreview = {
  branch: 'feature/one', upstream: 'origin/feature/one', remote: 'origin', targetBranch: 'feature/one',
  head: 'a'.repeat(40), upstreamOid: 'b'.repeat(40), ahead: 3, behind: 0,
  commits: [{ hash: 'a'.repeat(40), subject: 'Local changes' }], fileCount: 2
};
const review = { surface: 'changes' as const, root: '/repo/one', preview, afterCommit: false };

describe('host-owned Push review', () => {
  it('accepts the reviewed refs once, without accepting new refs from the webview', () => {
    const session = new PushReviewSession();
    const opened = session.open(review);
    expect(session.take(opened.id, 'changes', '/repo/one')?.preview).toEqual(preview);
    expect(session.take(opened.id, 'changes', '/repo/one')).toBeUndefined();
  });

  it('ignores replies from another surface, repository, or review without consuming the current review', () => {
    const session = new PushReviewSession();
    const opened = session.open(review);
    expect(session.take(opened.id, 'history', '/repo/one')).toBeUndefined();
    expect(session.take(opened.id, 'changes', '/repo/two')).toBeUndefined();
    expect(session.take(opened.id + 1, 'changes', '/repo/one')).toBeUndefined();
    expect(session.take(opened.id, 'changes', '/repo/one')).toEqual(opened);
  });

  it('invalidates an older confirmation when a newer branch review opens', () => {
    const session = new PushReviewSession();
    const old = session.open(review);
    const latest = session.open({ ...review, preview: { ...preview, branch: 'feature/two' } });
    expect(session.take(old.id, 'changes', '/repo/one')).toBeUndefined();
    expect(session.take(latest.id, 'changes', '/repo/one')?.preview.branch).toBe('feature/two');
  });

  it('invalidates confirmations when a view closes or the selected repository changes', () => {
    const session = new PushReviewSession();
    const old = session.open(review);
    session.clear();
    expect(session.take(old.id, 'changes', '/repo/one')).toBeUndefined();
    expect(session.open(review).id).toBeGreaterThan(old.id);
  });

  it('allows inspection only for exact commit hashes in the active review and stops after cancellation', () => {
    const session = new PushReviewSession();
    const opened = session.open(review);
    expect(session.allowsCommit(opened.id, 'changes', '/repo/one', preview.head)).toBe(true);
    expect(session.allowsCommit(opened.id, 'changes', '/repo/one', preview.head.slice(0, 7))).toBe(false);
    expect(session.allowsCommit(opened.id, 'changes', '/repo/one', 'c'.repeat(40))).toBe(false);
    expect(session.allowsCommit(opened.id, 'history', '/repo/one', preview.head)).toBe(false);
    expect(session.allowsCommit(opened.id, 'changes', '/repo/two', preview.head)).toBe(false);
    expect(session.allowsCommit(opened.id + 1, 'changes', '/repo/one', preview.head)).toBe(false);
    expect(session.take(opened.id, 'changes', '/repo/one')).toEqual(opened);
    expect(session.allowsCommit(opened.id, 'changes', '/repo/one', preview.head)).toBe(false);
  });
});
