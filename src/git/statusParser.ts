import type { GitChange } from './types';

export interface ParsedStatus {
  branch: string;
  upstream?: string;
  ahead: number;
  behind: number;
  changes: GitChange[];
}

function classify(indexStatus: string, workingTreeStatus: string, untracked = false): GitChange['kind'] {
  if (untracked) return 'untracked';
  if (indexStatus === 'U' || workingTreeStatus === 'U' || indexStatus === 'A' && workingTreeStatus === 'A') return 'conflict';
  const status = workingTreeStatus !== '.' ? workingTreeStatus : indexStatus;
  if (status === 'A') return 'added';
  if (status === 'D') return 'deleted';
  if (status === 'R' || status === 'C') return 'renamed';
  return 'modified';
}

export function parsePorcelainV2(output: string): ParsedStatus {
  let branch = 'HEAD';
  let upstream: string | undefined;
  let ahead = 0;
  let behind = 0;
  const changes: GitChange[] = [];
  const records = output.split('\0');

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    if (record.startsWith('# branch.head ')) {
      branch = record.slice(14).trim();
      continue;
    }
    if (record.startsWith('# branch.upstream ')) {
      upstream = record.slice(18).trim();
      continue;
    }
    if (record.startsWith('# branch.ab ')) {
      const match = record.match(/\+(\d+)\s+-(\d+)/);
      if (match) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
      continue;
    }
    if (record.startsWith('? ')) {
      changes.push({
        path: record.slice(2),
        kind: 'untracked',
        indexStatus: '?',
        workingTreeStatus: '?',
        staged: false
      });
      continue;
    }
    if (record.startsWith('1 ') || record.startsWith('u ')) {
      const fields = record.split(' ');
      const xy = fields[1] ?? '..';
      const pathOffset = record.startsWith('1 ') ? 8 : 10;
      const path = fields.slice(pathOffset).join(' ');
      changes.push({
        path,
        kind: classify(xy[0] ?? '.', xy[1] ?? '.'),
        indexStatus: xy[0] ?? '.',
        workingTreeStatus: xy[1] ?? '.',
        staged: (xy[0] ?? '.') !== '.'
      });
      continue;
    }
    if (record.startsWith('2 ')) {
      const fields = record.split(' ');
      const xy = fields[1] ?? '..';
      const path = fields.slice(9).join(' ');
      const originalPath = records[index + 1] || undefined;
      index += 1;
      changes.push({
        path,
        originalPath,
        kind: 'renamed',
        indexStatus: xy[0] ?? '.',
        workingTreeStatus: xy[1] ?? '.',
        staged: (xy[0] ?? '.') !== '.'
      });
    }
  }

  return { branch, upstream, ahead, behind, changes };
}
