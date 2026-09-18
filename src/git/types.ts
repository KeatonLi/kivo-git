export type ChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflict';

export interface GitChange {
  path: string;
  originalPath?: string;
  kind: ChangeKind;
  indexStatus: string;
  workingTreeStatus: string;
  staged: boolean;
}

export interface BranchSummary {
  name: string;
  current: boolean;
  remote: boolean;
  upstream?: string;
  tracking?: string;
}

export interface CommitSummary {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  subject: string;
}

export interface ChangeList {
  id: string;
  name: string;
  changes: GitChange[];
}

export interface RepositorySnapshot {
  repositoryName: string;
  root: string;
  branch: string;
  upstream?: string;
  ahead: number;
  behind: number;
  changes: GitChange[];
  changelists: ChangeList[];
  branches: BranchSummary[];
  commits: CommitSummary[];
}
