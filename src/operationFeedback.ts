import { CheckoutError, GitCommandError } from './git/checkout';

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
  const command = error instanceof GitCommandError ? error : undefined;
  const message = error instanceof Error ? error.message : String(error);
  const details = issue?.details || (command
    ? `git ${command.args.join(' ')}\nExit: ${command.exitCode ?? 'unknown'}\n${command.stderr}\n${command.stdout}` : message);
  const actions: RecoveryAction[] = [];
  if (issue?.worktreePath) actions.push('openWorktree');
  if (issue?.stashHash) actions.push('stashes');
  if (issue?.code === 'changes-blocked' || issue?.code === 'operation-in-progress') actions.push('changes');
  actions.push('details', 'copy', 'refresh');
  return { ...context, title: redactGitDetail(issue ? message : (message.split('\n')[0] || '')).slice(0, 320), details: redactGitDetail(details), actions,
    ...(issue?.worktreePath ? { worktreePath: issue.worktreePath } : {}),
    ...(issue?.stashHash ? { stashHash: issue.stashHash } : {}),
    ...(issue?.actualBranch ? { actualBranch: issue.actualBranch } : {}) };
}
