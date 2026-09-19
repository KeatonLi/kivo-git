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
  parents: string[];
  refs: GitRef[];
  lane: number;
  incomingLanes: number[];
  parentLanes: number[];
}

export type GitRefKind = 'local' | 'remote' | 'tag';

export interface GitRef {
  name: string;
  kind: GitRefKind;
  current?: boolean;
}

export interface CommitFile {
  path: string;
  status: string;
  originalPath?: string;
}

export interface CommitDetails {
  hash: string;
  subject: string;
  body: string;
  author: string;
  date: string;
  parents: string[];
  refs: GitRef[];
  files: CommitFile[];
}

export interface ChangeList {
  id: string;
  name: string;
  active: boolean;
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
  /** True when the repository has more history than the current graph window. */
  commitsHasMore: boolean;
}

export type PullStrategy = 'merge' | 'rebase' | 'ff-only';
