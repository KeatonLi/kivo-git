import { describe, expect, it } from 'vitest';
import { CheckoutError, GitCommandError } from '../src/git/checkout';
import { operationFailure } from '../src/operationFeedback';

describe('recoverable operation diagnostics', () => {
  it('keeps the exact worktree and stash identity and selects relevant recovery actions', () => {
    const error = new CheckoutError('worktree-occupied', 'Branch occupied', 'Open its worktree');
    error.worktreePath = '/repo/other'; error.stashHash = 'a'.repeat(40); error.actualBranch = 'main';
    expect(operationFailure(error, { root: '/repo/main', id: 7, kind: 'checkout' })).toMatchObject({
      root: '/repo/main', id: 7, stashHash: error.stashHash, worktreePath: '/repo/other', actualBranch: 'main',
      actions: ['openWorktree', 'stashes', 'details', 'copy', 'refresh']
    });
  });
  it('redacts URL credentials from both summaries and detailed command output', () => {
    const secret = 'https://user:password@example.test/repo?token=hidden';
    const failure = operationFailure(new GitCommandError(['switch', 'feature'], '/repo', 128, `stdout ${secret}`, `stderr ${secret}`, ''), { id: 1, root: '/repo', kind: 'checkout' });
    expect(failure.title + failure.details).not.toContain('user:password'); expect(failure.title + failure.details).not.toContain('hidden');
    expect(failure.details).toContain('Exit: 128'); expect(failure.details).toContain('stdout'); expect(failure.details).toContain('stderr');
  });
});
