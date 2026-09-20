/**
 * The two independent VS Code surfaces that make up the Git workflow.
 *
 * Changes deliberately lives in the Activity Bar; History deliberately lives
 * in the bottom Panel. Keeping the routing here (rather than in the webview)
 * makes the placement a testable product contract.
 */
export const KivoViewTypes = {
  changes: 'ideaGit.changes',
  history: 'ideaGit.history'
} as const;

export type KivoSurface = keyof typeof KivoViewTypes;

export function surfaceForViewType(viewType: string): KivoSurface | undefined {
  return (Object.entries(KivoViewTypes) as Array<[KivoSurface, string]>)
    .find(([, candidate]) => candidate === viewType)?.[0];
}

const sharedMessages = new Set([
  'ready',
  'refresh',
  'fetch',
  'pull',
  'push',
  'checkout'
]);

const messagesBySurface: Record<KivoSurface, ReadonlySet<string>> = {
  changes: new Set([
    'openDiff',
    'commit',
    'commitAndPush',
    'showLog',
    'openSettings',
    'createChangelist',
    'renameChangelist',
    'deleteChangelist',
    'setActiveChangelist',
    'moveFiles'
  ]),
  history: new Set([
    'loadMoreCommits',
    'commitDetails',
    'openCommitDiff',
    'showChanges'
  ])
};

/** Prevents a hidden/incorrect webview surface from issuing foreign actions. */
export function isMessageAllowedOnSurface(surface: KivoSurface, type: string): boolean {
  return sharedMessages.has(type) || messagesBySurface[surface].has(type);
}
