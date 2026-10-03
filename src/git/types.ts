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
  oid?: string;
  current: boolean;
  remote: boolean;
  upstream?: string;
  tracking?: string;
  ahead?: number;
  behind?: number;
}

export interface CommitSummary {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  subject: string;
  parents: string[];
  /** Paths touched by this commit, used by the IDEA-style Log path filter. */
  paths: string[];
  refs: GitRef[];
  /** This commit is ahead of the displayed local branch's tracking ref. */
  unpushedTo?: string;
  lane: number;
  incomingLanes: number[];
  parentLanes: number[];
  /** Whether the current commit enters this row from the preceding graph row. */
  hasIncoming?: boolean;
  /** Exact lane routing for this row. `through` edges bypass the commit node. */
  laneTransitions?: GraphLaneTransition[];
}

export interface GraphLaneTransition {
  from: number;
  to: number;
  kind: 'through' | 'parent';
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

export interface LineBlame {
  hash: string;
  author: string;
  authorTime: number;
  summary: string;
  line: number;
  content: string;
  uncommitted: boolean;
}

export interface PushPreview {
  branch: string;
  upstream: string;
  remote: string;
  targetBranch: string;
  head: string;
  upstreamOid: string;
  ahead: number;
  behind: number;
  commits: Array<{ hash: string; subject: string }>;
  fileCount: number;
}

export interface ChangeList {
  id: string;
  name: string;
  active: boolean;
  changes: GitChange[];
}

export interface RepositorySnapshot {
  operation?: GitOperationState;
  repositoryName: string;
  /** Stable host/webview identity: exactly the selected GitClient.workspaceRoot. */
  root: string;
  branch: string;
  headOid?: string;
  identity?: { name: string; email: string; ready: boolean };
  upstream?: string;
  ahead: number;
  behind: number;
  changes: GitChange[];
  changelists: ChangeList[];
  branches: BranchSummary[];
  tags?: GitRef[];
  commits: CommitSummary[];
  /** Latest five commits reachable from HEAD, independent of the History ref filter. */
  recentCommits?: CommitSummary[];
  /** True when the repository has more history than the current graph window. */
  commitsHasMore: boolean;
}

export type PullStrategy = 'merge' | 'rebase' | 'ff-only';

export interface WorkflowFile extends CommitFile { oldRevision: string; newRevision: string }
export interface BranchComparison {
  currentName: string; targetName: string; currentOid: string; targetOid: string;
  current: { count: number; commits: Array<{ hash: string; subject: string }> };
  target: { count: number; commits: Array<{ hash: string; subject: string }> };
  files: WorkflowFile[];
}
export interface StashEntry { hash: string; ref: string; date: string; subject: string }
export interface StashDetails extends StashEntry { files: WorkflowFile[] }
export interface GitOperationState { kind: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'conflicts'; token: string; files: string[] }
