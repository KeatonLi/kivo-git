import { CheckoutError, GitCommandError, WorktreeCreationError, WorktreeRemovalError } from './git/checkout';

export type RecoveryAction = 'openWorktree' | 'stashes' | 'changes' | 'details' | 'copy' | 'refresh';
export interface OperationFailure {
  id: number;
  root: string;
  kind: string;
  title: string;
  details: string;
  actions: RecoveryAction[];
  worktreePath?: string;
  stashHash?: string;
  actualBranch?: string;
}

export function redactGitDetail(text: string): string {
  return text.replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1[redacted]@')
    .replace(/([?&](?:access_token|token|password|key)=)[^\s&#]+/gi, '$1[redacted]');
}

export function operationFailure(error: unknown, context: { id: number; root: string; kind: string }): OperationFailure {
  const issue = error instanceof CheckoutError ? error : undefined;
  const creation = error instanceof WorktreeCreationError ? error : undefined;
  const removal = error instanceof WorktreeRemovalError ? error : undefined;
  const command = error instanceof GitCommandError ? error : undefined;
  const message = error instanceof Error ? error.message : String(error);
  const removalState = removal?.actual;
  let details = issue?.details || message;
  if (creation) {
    details = [creation.message,
      ...(creation.created ? [`Registered path: ${creation.created.path}`, `Actual checkout: ${creation.created.branch || 'detached or unavailable'}`] : []),
      ...(creation.actualBranch ? [`Local branch: ${creation.actualBranch.name} (${creation.actualBranch.oid})`] : []),
      ...(creation.pathExists !== undefined ? [`Destination present: ${creation.pathExists ? 'yes' : 'no'}`] : []),
      ...(creation.details !== creation.message ? [creation.details] : [])
    ].join('\n');
  } else if (removal) {
    details = [removal.message,
      ...(removalState ? [`Registration: ${removalState.worktree?.path ?? 'none'}`, `Directory present: ${removalState.pathExists ? 'yes' : 'no'}`] : []),
      ...(removal.details !== removal.message ? [removal.details] : [])
    ].join('\n');
  } else if (command) {
    details = `git ${command.args.join(' ')}\nExit: ${command.exitCode ?? 'unknown'}\n${command.stderr}\n${command.stdout}`;
  }
  const inspectedTree = creation?.pathExists !== false && creation?.created ? creation.created
    : removalState?.pathExists ? removalState.worktree : undefined;
  const worktreePath = issue?.worktreePath || (inspectedTree && !inspectedTree.bare && inspectedTree.prunable === undefined ? inspectedTree.path : undefined);
  const actions: RecoveryAction[] = [];
  if (worktreePath) actions.push('openWorktree');
  if (issue?.stashHash) actions.push('stashes');
  if (issue?.code === 'changes-blocked' || issue?.code === 'operation-in-progress') actions.push('changes');
  actions.push('details', 'copy', 'refresh');
  return { ...context, title: redactGitDetail(issue ? message : (message.split('\n')[0] || '')).slice(0, 320), details: redactGitDetail(details), actions,
    ...(worktreePath ? { worktreePath } : {}),
    ...(issue?.stashHash ? { stashHash: issue.stashHash } : {}),
    ...(issue?.actualBranch ? { actualBranch: issue.actualBranch } : {}) };
}
