import { describe, expect, it } from 'vitest';
import { isMessageAllowedOnSurface, KivoViewTypes, surfaceForViewType } from '../src/viewLayout';

describe('Kivo Git two-surface routing', () => {
  it('maps the declared views to the IDEA-style Changes and History surfaces', () => {
    expect(surfaceForViewType(KivoViewTypes.changes)).toBe('changes');
    expect(surfaceForViewType(KivoViewTypes.history)).toBe('history');
    expect(surfaceForViewType('ideaGit.panel')).toBeUndefined();
  });

  it('keeps local-change operations out of the History panel', () => {
    expect(isMessageAllowedOnSurface('changes', 'commit')).toBe(true);
    expect(isMessageAllowedOnSurface('changes', 'commitAndPush')).toBe(true);
    expect(isMessageAllowedOnSurface('changes', 'showLog')).toBe(true);
    expect(isMessageAllowedOnSurface('changes', 'openDiff')).toBe(true);
    expect(isMessageAllowedOnSurface('history', 'commit')).toBe(false);
    expect(isMessageAllowedOnSurface('history', 'commitAndPush')).toBe(false);
    expect(isMessageAllowedOnSurface('history', 'openDiff')).toBe(false);
  });

  it('keeps graph/history operations out of the Changes sidebar', () => {
    expect(isMessageAllowedOnSurface('history', 'commitDetails')).toBe(true);
    expect(isMessageAllowedOnSurface('history', 'loadMoreCommits')).toBe(true);
    expect(isMessageAllowedOnSurface('changes', 'commitDetails')).toBe(false);
    expect(isMessageAllowedOnSurface('changes', 'loadMoreCommits')).toBe(false);
    expect(isMessageAllowedOnSurface('history', 'showChanges')).toBe(true);
    expect(isMessageAllowedOnSurface('changes', 'showChanges')).toBe(false);
    for (const message of ['mergeBranch', 'renameBranch', 'deleteBranch', 'copyBranchName', 'createTag', 'checkoutRevision', 'copyCommitHash', 'copyCommitSubject']) {
      expect(isMessageAllowedOnSurface('history', message)).toBe(true);
      expect(isMessageAllowedOnSurface('changes', message)).toBe(false);
    }
  });

  it('keeps file-specific navigation in the Changes surface', () => {
    for (const message of ['showFileHistory', 'showBranchHistory', 'revealInExplorer']) {
      expect(isMessageAllowedOnSurface('changes', message)).toBe(true);
      expect(isMessageAllowedOnSurface('history', message)).toBe(false);
    }
  });

  it('allows synchronisation and branch operations from either surface', () => {
    for (const message of ['ready', 'refresh', 'fetch', 'pull', 'push', 'checkout', 'createBranch']) {
      expect(isMessageAllowedOnSurface('changes', message)).toBe(true);
      expect(isMessageAllowedOnSurface('history', message)).toBe(true);
    }
  });
});
