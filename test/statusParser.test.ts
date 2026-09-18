import { describe, expect, it } from 'vitest';
import { parsePorcelainV2 } from '../src/git/statusParser';

describe('parsePorcelainV2', () => {
  it('parses branch metadata and ordinary changes', () => {
    const result = parsePorcelainV2([
      '# branch.oid abc',
      '# branch.head feature/idea-git',
      '# branch.upstream origin/feature/idea-git',
      '# branch.ab +3 -2',
      '1 .M N... 100644 100644 100644 abc abc src/main.ts',
      '? docs/design notes.md',
      ''
    ].join('\0'));
    expect(result).toMatchObject({ branch: 'feature/idea-git', upstream: 'origin/feature/idea-git', ahead: 3, behind: 2 });
    expect(result.changes).toEqual([
      expect.objectContaining({ path: 'src/main.ts', kind: 'modified', staged: false }),
      expect.objectContaining({ path: 'docs/design notes.md', kind: 'untracked' })
    ]);
  });

  it('parses staged rename records and the original path', () => {
    const result = parsePorcelainV2('2 R. N... 100644 100644 100644 abc def R100 src/new.ts\0src/old.ts\0');
    expect(result.changes[0]).toMatchObject({ path: 'src/new.ts', originalPath: 'src/old.ts', kind: 'renamed', staged: true });
  });

  it('marks unmerged records as conflicts', () => {
    const result = parsePorcelainV2('u UU N... 100644 100644 100644 100644 a b c src/conflict.ts\0');
    expect(result.changes[0]).toMatchObject({ path: 'src/conflict.ts', kind: 'conflict' });
  });
});
