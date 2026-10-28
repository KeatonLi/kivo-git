import path from 'node:path';

export interface WorktreeSummary {
  path: string;
  head?: string;
  branch?: string;
  bare?: boolean;
  detached?: boolean;
  locked?: string;
  prunable?: string;
}

export interface WorktreeCreationPlan {
  root: string;
  sourceRoot: string;
  sourceDevice: number;
  sourceInode: number;
  commonDir: string;
  branch: string;
  path: string;
  head: string;
  parentDevice: number;
  parentInode: number;
}

/** An attempted creation may have registered a worktree even when Git fails. */
export class WorktreeCreationError extends Error {
  constructor(message: string, readonly created?: WorktreeSummary, readonly details = message) {
    super(message);
    this.name = 'WorktreeCreationError';
  }
}

/** Porcelain -z leaves paths and lock reasons unquoted, including newlines. */
export function parseWorktrees(output: string): WorktreeSummary[] {
  const result: WorktreeSummary[] = [];
  let current: WorktreeSummary | undefined;
  for (const field of output.split('\0')) {
    if (field.startsWith('worktree ')) {
      current = { path: field.slice(9) };
      result.push(current);
    } else if (current) {
      if (field.startsWith('HEAD ')) current.head = field.slice(5);
      else if (field.startsWith('branch refs/heads/')) current.branch = field.slice(18);
      else if (field === 'bare') current.bare = true;
      else if (field === 'detached') current.detached = true;
      else if (field === 'locked' || field.startsWith('locked ')) current.locked = field.slice(7);
      else if (field === 'prunable' || field.startsWith('prunable ')) current.prunable = field.slice(9);
    }
  }
  return result;
}

export function sameWorktreePath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

export class GitCommandError extends Error {
  constructor(readonly args: string[], readonly root: string, readonly exitCode: number | string | undefined,
    readonly stdout: string, readonly stderr: string, fallback: string) {
    super(stderr.trim() || stdout.trim() || fallback);
    this.name = 'GitCommandError';
  }
}

export type CheckoutIssue = 'worktree-occupied' | 'operation-in-progress' | 'branch-missing' | 'tracking-conflict'
  | 'changes-blocked' | 'checkout-completed-with-error' | 'checkout-incomplete' | 'git-error';

export class CheckoutError extends Error {
  worktreePath?: string;
  stashHash?: string;
  actualBranch?: string;
  constructor(readonly code: CheckoutIssue, message: string, readonly details = message) {
    super(message);
    this.name = 'CheckoutError';
  }
}
