import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { GitCommandError, parseWorktrees, sameWorktreePath, type WorktreeSummary } from './checkout';
import { parsePorcelainV2 } from './statusParser';
import type { GitChange, WorkflowFile } from './types';

const exec = promisify(execFile);
const defaultLimit = 20;
const maximumLimit = 100;
const maximumGitOffset = 0x7fffffff; // Git's --skip takes a signed int.
const scopeChanged = 'The Git repository changed. Refresh Worktree Review and try again.';
const worktreeUnavailable = 'This registered worktree is unavailable. Refresh Worktree Review and try again.';
const worktreeChanged = 'This worktree or its HEAD changed. Refresh Worktree Review and try again.';
const repositoryOverrides = new Set(['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_IMPLICIT_WORK_TREE', 'GIT_GRAFT_FILE', 'GIT_SHALLOW_FILE', 'GIT_PREFIX',
  'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT']);

export interface WorktreeReviewEntry extends WorktreeSummary {
  id: string;
  isCurrent?: boolean;
}

export interface WorktreeReviewInventory {
  commonDir: string;
  repositoryId: string;
  entries: WorktreeReviewEntry[];
}

export interface WorktreeReviewCommit {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  date: string;
}

export interface WorktreeReviewWindow {
  commits: WorktreeReviewCommit[];
  hasMore: boolean;
}

export interface WorktreeReviewRange {
  readonly tip: string;
  readonly exclude?: string;
}

export interface WorktreeReviewData extends WorktreeReviewWindow {
  mode: 'recent' | 'since' | 'rewritten' | 'baseline-unavailable';
  range?: WorktreeReviewRange;
  changes?: GitChange[];
  statusError?: string;
}

export interface WorktreeReviewTarget {
  ref: string;
  label: string;
  oid: string;
}

export interface WorktreeReviewDelivery {
  target: WorktreeReviewTarget;
  head: string;
  base: string;
  files: WorkflowFile[];
}

interface DirectoryIdentity {
  path: string;
  id: string;
}

interface Scope {
  root: DirectoryIdentity;
  common: DirectoryIdentity;
}

interface Registration {
  backPointer: string;
  admin: DirectoryIdentity;
}

interface Entry {
  observation: WorktreeReviewEntry;
  admin?: DirectoryIdentity;
  linked: boolean;
}

function fingerprint(...parts: Array<string | number>): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function pathKey(location: string): string {
  const normalized = path.resolve(location);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function gitLine(output: string): string {
  // Strip just Git's terminator, not spaces or newlines belonging to a path.
  return output.replace(/\r?\n$/, '');
}

function commitOid(value: string | undefined): string | undefined {
  return typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value) && !/^0+$/.test(value)
    ? value.toLowerCase() : undefined;
}

async function run(root: string, args: string[]): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '' };
  // On-demand reads for other worktrees must use their real index/objects, not
  // process-wide overrides (for example, a terminal launched by a Git hook).
  for (const key of Object.keys(env)) if (repositoryOverrides.has(key.toUpperCase())) delete env[key];
  try {
    return (await exec('git', ['--no-pager', '--no-optional-locks', '--no-replace-objects', ...args], {
      cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 15_000, env
    })).stdout;
  } catch (error) {
    const detail = error as Error & { code?: string | number; stdout?: string; stderr?: string };
    throw new GitCommandError(args, root, detail.code, detail.stdout || '', detail.stderr || '', detail.message);
  }
}

async function directoryIdentity(location: string): Promise<DirectoryIdentity> {
  if (!path.isAbsolute(location)) throw new Error(worktreeUnavailable);
  const canonical = await fs.realpath(location);
  const stat = await fs.stat(canonical, { bigint: true });
  if (!stat.isDirectory()) throw new Error(worktreeUnavailable);
  // An admin directory persists across HEAD/branch changes and `git worktree move`,
  // but a removed/recreated registration does not inherit the previous checkpoint.
  return { path: canonical, id: fingerprint(pathKey(canonical), String(stat.dev), String(stat.ino), String(stat.birthtimeNs)) };
}

async function readScope(root: string): Promise<Scope> {
  const resolve = async (...args: string[]) => directoryIdentity(gitLine(await run(root, ['rev-parse', ...args])));
  const [top, common] = await Promise.all([resolve('--show-toplevel'), resolve('--path-format=absolute', '--git-common-dir')]);
  return { root: top, common };
}

async function checkScope(root: string, inventory: WorktreeReviewInventory): Promise<Scope> {
  const scope = await readScope(root).catch(() => { throw new Error(scopeChanged); });
  if (scope.common.id !== inventory.repositoryId || !sameWorktreePath(scope.common.path, inventory.commonDir)) throw new Error(scopeChanged);
  return scope;
}

async function pointer(file: string): Promise<string> {
  // Do not follow links when examining a Git control file under the verified
  // directories. Legitimate pointers are short, ordinary text files.
  const stats = await fs.lstat(file);
  if (!stats.isFile() || stats.size > 16 * 1024) throw new Error(worktreeUnavailable);
  const contents = gitLine(await fs.readFile(file, 'utf8'));
  if (!contents || contents.includes('\0')) throw new Error(worktreeUnavailable);
  return contents;
}

async function registrations(common: DirectoryIdentity): Promise<Map<string, Registration[]>> {
  const locations = new Map<string, Registration[]>();
  const linkedDir = path.join(common.path, 'worktrees');
  const linkedStat = await fs.lstat(linkedDir).catch(() => undefined);
  if (!linkedStat?.isDirectory()) return locations;
  for (const child of await fs.readdir(linkedDir, { withFileTypes: true })) {
    if (!child.isDirectory()) continue;
    const registration = await (async (): Promise<Registration | undefined> => {
      const admin = await directoryIdentity(path.join(linkedDir, child.name));
      if (!sameWorktreePath(path.dirname(admin.path), linkedDir)) return undefined;
      const backPointer = path.resolve(admin.path, await pointer(path.join(admin.path, 'gitdir')));
      if (path.basename(backPointer) !== '.git') return undefined;
      return { admin, backPointer };
    })().catch(() => undefined);
    if (!registration) continue;
    const key = pathKey(path.dirname(registration.backPointer));
    const values = locations.get(key) ?? [];
    values.push(registration);
    locations.set(key, values);
  }
  return locations;
}

async function readEntries(scope: Scope): Promise<Entry[]> {
  const [output, linked] = await Promise.all([
    run(scope.root.path, ['worktree', 'list', '--porcelain', '-z']), registrations(scope.common)
  ]);
  return parseWorktrees(output).flatMap((tree, index) => {
    if (!path.isAbsolute(tree.path)) return [];
    // The first entry is the primary worktree (or bare repository). Linked IDs
    // come from the admin registration even for a missing, prunable directory.
    const candidates = linked.get(pathKey(tree.path));
    const admin = index === 0 ? scope.common : candidates?.length === 1 ? candidates[0]!.admin : undefined;
    const id = fingerprint(scope.common.id, index === 0 ? 'primary' : admin?.id ?? `unverified:${pathKey(tree.path)}`);
    return [{ observation: { ...tree, id, head: commitOid(tree.head), isCurrent: sameWorktreePath(scope.root.path, tree.path) }, admin, linked: index !== 0 }];
  });
}

export async function readWorktreeReviewInventory(root: string): Promise<WorktreeReviewInventory> {
  const scope = await readScope(root);
  const entries = await readEntries(scope);
  const after = await readScope(root);
  if (after.common.id !== scope.common.id || after.root.id !== scope.root.id) throw new Error(scopeChanged);
  return { commonDir: scope.common.path, repositoryId: scope.common.id, entries: entries.map(entry => entry.observation) };
}

function listLimit(limit: number): number {
  return Number.isFinite(limit) ? Math.max(1, Math.min(maximumLimit, Math.floor(limit))) : defaultLimit;
}

function objectRunner(scope: Scope): (args: string[]) => Promise<string> {
  // Pin the object store so even a path replacement cannot redirect Git discovery
  // to a different repository. The caller also revalidates the store afterwards.
  return args => run(scope.common.path, [`--git-dir=${scope.common.path}`, ...args]);
}

type ObjectRunner = ReturnType<typeof objectRunner>;

async function commitExists(objects: ObjectRunner, oid: string | undefined): Promise<boolean> {
  if (!oid) return false;
  try {
    return (await objects(['rev-parse', '--verify', '--quiet', '--end-of-options', `${oid}^{commit}`])).trim() === oid;
  } catch (error) {
    if (error instanceof GitCommandError && error.exitCode === 1) return false;
    throw error;
  }
}

async function readLog(objects: ObjectRunner, tip: string, limit: number, exclude?: string, offset = 0): Promise<WorktreeReviewWindow> {
  // `-z` frames the records. Use NULs for the individual well-formed Git
  // fields, so ordinary Unicode, newlines and other controls are not separators.
  const output = await objects(['log', '--topo-order', '--no-show-signature', `--skip=${offset}`, '-n', String(limit + 1), '-z',
    '--format=%H%x00%h%x00%aI%x00%an%x00%s', tip, ...(exclude ? [`^${exclude}`] : []), '--']);
  const fields = output.split('\0');
  const commits: WorktreeReviewCommit[] = [];
  for (let index = 0; index + 4 < fields.length; index += 5) {
    const [hash, shortHash, date, author, subject] = fields.slice(index, index + 5) as [string, string, string, string, string];
    if (!commitOid(hash)) throw new Error('Git returned invalid Worktree Review history.');
    commits.push({ hash, shortHash, subject, author, date });
  }
  return { commits: commits.slice(0, limit), hasMore: commits.length > limit };
}

async function baselineIsAncestor(objects: ObjectRunner, baseline: string, head: string): Promise<boolean> {
  try {
    await objects(['merge-base', '--is-ancestor', baseline, head]);
    return true;
  } catch (error) {
    if (error instanceof GitCommandError && error.exitCode === 1) return false;
    throw error;
  }
}

async function readComparison(scope: Scope, entry: WorktreeReviewEntry, previous: string | undefined, limit: number): Promise<WorktreeReviewData> {
  const head = commitOid(entry.head);
  const baseline = commitOid(previous);
  if (!head) {
    if (entry.head !== undefined) throw new Error('The reviewed HEAD is not a valid commit.');
    return { mode: previous === undefined ? 'recent' : 'baseline-unavailable', commits: [], hasMore: false };
  }
  const objects = objectRunner(scope);
  if (!await commitExists(objects, head)) throw new Error('The reviewed HEAD is no longer available in this repository.');
  const withLog = async (mode: WorktreeReviewData['mode'], exclude?: string): Promise<WorktreeReviewData> => ({
    mode, range: Object.freeze(exclude === undefined ? { tip: head } : { tip: head, exclude }),
    ...await readLog(objects, head, limit, exclude)
  });
  if (previous === undefined) return withLog('recent');
  if (baseline === head) return { mode: 'since', commits: [], hasMore: false };
  if (!baseline || !await commitExists(objects, baseline)) return withLog('baseline-unavailable');
  if (!await baselineIsAncestor(objects, baseline, head)) return withLog('rewritten');
  return withLog('since', baseline);
}

function matchingEntry(entries: Entry[], expected: WorktreeReviewEntry): Entry {
  const matches = entries.filter(entry => entry.observation.id === expected.id);
  const known = matches[0];
  if (matches.length !== 1 || !known?.admin || known.observation.bare || known.observation.prunable !== undefined) {
    throw new Error(worktreeUnavailable);
  }
  const observed = known.observation;
  if (!path.isAbsolute(expected.path) || !sameWorktreePath(observed.path, expected.path) || observed.head !== expected.head ||
      observed.branch !== expected.branch || !!observed.detached !== !!expected.detached) throw new Error(worktreeChanged);
  return known;
}

async function verifyTarget(scope: Scope, known: Entry): Promise<DirectoryIdentity> {
  const expected = known.observation;
  const admin = known.admin!;
  if (!(await fs.lstat(expected.path)).isDirectory()) throw new Error(worktreeUnavailable);
  const target = await directoryIdentity(expected.path);
  const relative = path.relative(scope.common.path, target.path);
  if (!relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))) throw new Error(worktreeUnavailable);
  const forward = path.join(target.path, '.git');
  if (known.linked || !(await fs.lstat(forward)).isDirectory()) {
    const value = await pointer(forward);
    if (!value.startsWith('gitdir: ') || !sameWorktreePath(path.resolve(target.path, value.slice(8)), admin.path)) throw new Error(worktreeUnavailable);
  } else if (!sameWorktreePath(forward, admin.path)) throw new Error(worktreeUnavailable);
  if (known.linked) {
    const backward = path.resolve(admin.path, await pointer(path.join(admin.path, 'gitdir')));
    if (!sameWorktreePath(backward, forward) && !sameWorktreePath(backward, path.join(expected.path, '.git'))) throw new Error(worktreeUnavailable);
  }
  const [live, gitDir] = await Promise.all([
    readScope(target.path), run(target.path, ['rev-parse', '--absolute-git-dir']).then(output => directoryIdentity(gitLine(output)))
  ]);
  if (live.root.id !== target.id || live.common.id !== scope.common.id || gitDir.id !== admin.id) throw new Error(worktreeUnavailable);
  return target;
}

async function readStatus(root: string, scope: Scope, inventory: WorktreeReviewInventory, expected: WorktreeReviewEntry): Promise<GitChange[]> {
  const known = matchingEntry(await readEntries(scope), expected);
  const target = await verifyTarget(scope, known);
  // Pin both identities rather than allowing Git to discover a new repository
  // if the directory changes after the previous checks. No checkout or writes.
  const output = await run(target.path, [`--git-dir=${known.admin!.path}`, `--work-tree=${target.path}`,
    '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', 'status', '--porcelain=v2', '--branch', '--no-ahead-behind',
    '-z', '--untracked-files=all', '--ignore-submodules=dirty']);
  const status = parsePorcelainV2(output);
  if (commitOid(status.headOid) !== expected.head || status.branch !== (expected.detached ? '(detached)' : expected.branch)) {
    throw new Error(worktreeChanged);
  }
  const currentScope = await checkScope(root, inventory);
  const current = matchingEntry(await readEntries(currentScope), expected);
  if ((await verifyTarget(currentScope, current)).id !== target.id) throw new Error(worktreeChanged);
  return status.changes;
}

export async function readWorktreeReviewData(root: string, inventory: WorktreeReviewInventory, entry: WorktreeReviewEntry,
  previousReviewHead?: string, limit = defaultLimit): Promise<WorktreeReviewData> {
  const scope = await checkScope(root, inventory);
  const [history, status] = await Promise.all([
    readComparison(scope, entry, previousReviewHead, listLimit(limit)),
    readStatus(root, scope, inventory, entry).then(changes => ({ changes })).catch(error => ({
      statusError: error instanceof Error && [worktreeUnavailable, worktreeChanged].includes(error.message) ? error.message : worktreeUnavailable
    }))
  ]);
  await checkScope(root, inventory);
  return { ...history, ...status };
}

export async function readWorktreeReviewPage(root: string, inventory: WorktreeReviewInventory, range: WorktreeReviewRange,
  offset: number, limit = defaultLimit): Promise<WorktreeReviewWindow> {
  if (!Number.isInteger(offset) || offset < 0 || offset > maximumGitOffset) throw new Error('Invalid Worktree Review page offset.');
  const tip = commitOid(range?.tip);
  const exclude = commitOid(range?.exclude);
  if (!tip || (range.exclude !== undefined && !exclude)) throw new Error('Invalid Worktree Review history range.');
  const scope = await checkScope(root, inventory);
  const objects = objectRunner(scope);
  const [hasTip, hasExclude] = await Promise.all([commitExists(objects, tip), exclude === undefined || commitExists(objects, exclude)]);
  if (!hasTip || !hasExclude) throw new Error('The Worktree Review history range is no longer available in this repository.');
  const page = await readLog(objects, tip, listLimit(limit), exclude, offset);
  await checkScope(root, inventory);
  return page;
}

function targetLabel(ref: string): string | undefined {
  return /^refs\/(?:heads|remotes)\/(.+)$/.exec(ref)?.[1];
}

export async function readWorktreeReviewTargets(root: string, inventory: WorktreeReviewInventory): Promise<WorktreeReviewTarget[]> {
  const scope = await checkScope(root, inventory);
  // Full refs avoid local/remote ambiguity. Ignore symbolic aliases such as
  // refs/remotes/origin/HEAD and list only refs pointing directly to a commit.
  const output = await objectRunner(scope)(['for-each-ref', '--sort=refname',
    '--format=%(refname)%00%(objectname)%00%(objecttype)%00%(symref)', 'refs/heads/', 'refs/remotes/']);
  const targets: WorktreeReviewTarget[] = [];
  const labelCounts = new Map<string, number>();
  for (const line of output.split(/\r?\n/)) {
    const [ref, object, type, symbolic] = line.split('\0');
    const oid = commitOid(object);
    const label = ref && targetLabel(ref);
    if (!ref || !label || !oid || type !== 'commit' || symbolic !== '') continue;
    targets.push({ ref, label, oid });
    labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
  }
  await checkScope(root, inventory);
  return targets.map(target => labelCounts.get(target.label) === 1 ? target : { ...target, label: target.ref });
}

async function readDeliveryBase(objects: ObjectRunner, target: string, head: string): Promise<string> {
  let output: string;
  try {
    output = await objects(['merge-base', '--all', target, head]);
  } catch (error) {
    if (error instanceof GitCommandError && error.exitCode === 1) {
      throw new Error('The comparison target and reviewed HEAD have no common merge base.');
    }
    throw error;
  }
  const bases = gitLine(output).split(/\r?\n/);
  if (bases.length > 1) throw new Error('The comparison target and reviewed HEAD have multiple merge bases.');
  const base = commitOid(bases[0]);
  if (!base) throw new Error('Git returned an invalid Worktree Review merge base.');
  return base;
}

function parseDeliveryFiles(output: string, base: string, head: string): WorkflowFile[] {
  const tokens = output.split('\0');
  const invalid = 'Git returned an invalid Worktree Review file list.';
  if (tokens.pop() !== '') throw new Error(invalid);
  const files: WorkflowFile[] = [];
  for (let index = 0; index < tokens.length;) {
    const change = tokens[index++]!;
    if (!/^(?:[ADMTUXB]|[MCR]\d{1,3})$/.test(change)) throw new Error(invalid);
    const status = change[0]!;
    const renamedOrCopied = status === 'R' || status === 'C';
    const originalPath = renamedOrCopied ? tokens[index++] : undefined;
    const file = tokens[index++];
    if (!file || (renamedOrCopied && !originalPath)) throw new Error(invalid);
    files.push({ path: file, ...(originalPath ? { originalPath } : {}), status, oldRevision: base, newRevision: head });
  }
  return files;
}

export async function readWorktreeReviewDelivery(root: string, inventory: WorktreeReviewInventory, entry: WorktreeReviewEntry,
  target: WorktreeReviewTarget): Promise<WorktreeReviewDelivery> {
  const scope = await checkScope(root, inventory);
  const objects = objectRunner(scope);
  const head = commitOid(entry.head);
  const oid = commitOid(target?.oid);
  const ref = target?.ref;
  const label = target?.label;
  if (!head || !await commitExists(objects, head)) throw new Error('The reviewed HEAD is no longer available in this repository.');
  if (!oid || typeof ref !== 'string' || !targetLabel(ref) || typeof label !== 'string' || !await commitExists(objects, oid)) {
    throw new Error('The comparison target is no longer available in this repository.');
  }
  // Neither branch is resolved again: compare the captured OIDs, even if a
  // ref moved. Diffing the unique base to HEAD excludes target-only changes.
  const base = await readDeliveryBase(objects, oid, head);
  const output = await objects(['diff-tree', '-r', '--no-commit-id', '--name-status', '-z', '-M', '-l0',
    '--no-color', '--no-ext-diff', '--no-textconv', '--no-relative', '--ignore-submodules=none', base, head, '--']);
  await checkScope(root, inventory);
  return { target: { ref, label, oid }, head, base, files: parseDeliveryFiles(output, base, head) };
}

export async function compareWorktreeReviewTarget(root: string, inventory: WorktreeReviewInventory, entry: WorktreeReviewEntry,
  targetOid: string, limit = defaultLimit): Promise<{ ahead: WorktreeReviewWindow; behind: WorktreeReviewWindow }> {
  const scope = await checkScope(root, inventory);
  const objects = objectRunner(scope);
  const head = commitOid(entry.head);
  const target = commitOid(targetOid);
  if (!head || !await commitExists(objects, head)) throw new Error('The reviewed HEAD is no longer available in this repository.');
  if (!target || !await commitExists(objects, target)) throw new Error('The comparison target is no longer available in this repository.');
  const count = listLimit(limit);
  const [ahead, behind] = await Promise.all([readLog(objects, head, count, target), readLog(objects, target, count, head)]);
  await checkScope(root, inventory);
  return { ahead, behind };
}
