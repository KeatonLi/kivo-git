const vscode = acquireVsCodeApi();
const app = document.querySelector('#app');
const toastRegion = document.querySelector('#toast-region');
const persisted = vscode.getState?.() || {};
const surface = document.body.dataset.surface === 'history' ? 'history' : 'changes';
const LOG_BRANCH_MIN_WIDTH = 156;
const LOG_BRANCH_MAX_WIDTH = 420;
const LOG_BRANCH_DEFAULT_WIDTH = 240;
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const restoredBranchWidth = Number(persisted.logBranchWidth);

const ui = {
  snapshot: undefined,
  emptyMessage: undefined,
  selected: new Set(persisted.selected || []),
  collapsed: new Set(persisted.collapsed || []),
  branchOpen: false,
  branchQuery: '',
  logBranchQuery: persisted.logBranchQuery || '',
  logBranchWidth: Number.isFinite(restoredBranchWidth)
    ? clamp(restoredBranchWidth, LOG_BRANCH_MIN_WIDTH, LOG_BRANCH_MAX_WIDTH)
    : LOG_BRANCH_DEFAULT_WIDTH,
  busy: false,
  operationKind: undefined,
  operationId: 0,
  syncPhase: 'idle',
  lastFetchedAt: undefined,
  syncError: undefined,
  branchMotion: undefined,
  branchContextMenu: undefined,
  listMenuId: undefined,
  focusedPath: persisted.focusedPath,
  selectionAnchor: undefined,
  commitMessage: persisted.commitMessage || '',
  graphQuery: persisted.graphQuery || '',
  graphPathFilter: persisted.graphPathFilter || '',
  graphBranchFilter: persisted.graphBranchFilter || '',
  graphAuthorFilter: persisted.graphAuthorFilter || '',
  graphAgeFilter: persisted.graphAgeFilter || 'all',
  graphLoadingMore: false,
  pullMenuOpen: false,
  selectedCommitHash: persisted.selectedCommitHash,
  focusedCommitHash: persisted.focusedCommitHash || persisted.selectedCommitHash,
  commitDetailsDismissed: persisted.commitDetailsDismissed || false,
  commitDetails: undefined,
  commitDetailsLoading: false,
  commitDetailsError: undefined
};
let lastSnapshot = '';
let previewTimer;
let commitDetailTimer;
let dragAvatar;
let activeLogResize;
const commandKey = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

const escapeHtml = (value = '') => String(value)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#039;');

const iconFor = (kind) => ({ modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: '?', conflict: '!' })[kind] || 'M';
const icon = (name, classes = '') => `<span class="codicon codicon-${name} ${classes}" aria-hidden="true"></span>`;
const kivoIcon = (name, classes = '') => `<svg class="kivo-icon ${classes}" aria-hidden="true" focusable="false"><use href="#kivo-${name}"></use></svg>`;
const relativeTime = (date) => {
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (seconds < 60) return 'now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
};
const updatedLabel = (date) => {
  const relative = relativeTime(date);
  return relative === 'now' ? 'Updated just now' : `Updated ${relative} ago`;
};

function post(type, payload = {}) { vscode.postMessage({ type, ...payload }); }
function persist() {
  vscode.setState?.({
    selected: [...ui.selected],
    collapsed: [...ui.collapsed],
    focusedPath: ui.focusedPath,
    commitMessage: ui.commitMessage,
    graphQuery: ui.graphQuery,
    graphPathFilter: ui.graphPathFilter,
    graphBranchFilter: ui.graphBranchFilter,
    graphAuthorFilter: ui.graphAuthorFilter,
    graphAgeFilter: ui.graphAgeFilter,
    logBranchQuery: ui.logBranchQuery,
    logBranchWidth: ui.logBranchWidth,
    selectedCommitHash: ui.selectedCommitHash,
    focusedCommitHash: ui.focusedCommitHash,
    commitDetailsDismissed: ui.commitDetailsDismissed
  });
}

function graphCommits() {
  const commits = ui.snapshot?.commits ?? [];
  const query = ui.graphQuery.trim().toLowerCase();
  const ageDays = { all: 0, '7d': 7, '30d': 30, '90d': 90 }[ui.graphAgeFilter] || 0;
  const after = ageDays ? Date.now() - ageDays * 24 * 60 * 60 * 1000 : 0;
  const reachable = ui.graphBranchFilter ? reachableCommitHashes(commits, ui.graphBranchFilter) : undefined;
  return commits.filter((commit) => {
    const textMatches = !query || [commit.subject, commit.author, commit.hash, commit.shortHash, ...(commit.refs || []).map((ref) => ref.name)]
      .join(' ').toLowerCase().includes(query);
    const pathMatches = !ui.graphPathFilter.trim() || (commit.paths || []).some((path) => path.toLowerCase().includes(ui.graphPathFilter.trim().toLowerCase()));
    const branchMatches = !ui.graphBranchFilter || reachable?.has(commit.hash);
    const authorMatches = !ui.graphAuthorFilter || commit.author === ui.graphAuthorFilter;
    const ageMatches = !after || new Date(commit.date).getTime() >= after;
    return textMatches && pathMatches && branchMatches && authorMatches && ageMatches;
  });
}

function reachableCommitHashes(commits, branch) {
  const byHash = new Map(commits.map((commit) => [commit.hash, commit]));
  const queue = commits
    .filter((commit) => (commit.refs || []).some((ref) => ref.name === branch))
    .map((commit) => commit.hash);
  const reachable = new Set(queue);
  while (queue.length) {
    const hash = queue.pop();
    const commit = byHash.get(hash);
    for (const parent of commit?.parents || []) {
      if (!byHash.has(parent) || reachable.has(parent)) continue;
      reachable.add(parent);
      queue.push(parent);
    }
  }
  return reachable;
}

function postCommitDetails(hash, immediate = true) {
  clearTimeout(commitDetailTimer);
  const request = () => {
    if (ui.selectedCommitHash === hash) post('commitDetails', { hash });
  };
  if (immediate) request();
  else commitDetailTimer = setTimeout(request, 90);
}

function selectCommit(hash, { focus = false, immediate = true } = {}) {
  if (!hash) return;
  ui.selectedCommitHash = hash;
  ui.focusedCommitHash = hash;
  ui.commitDetails = undefined;
  ui.commitDetailsError = undefined;
  ui.commitDetailsLoading = true;
  ui.commitDetailsDismissed = false;
  persist();
  render();
  if (focus) requestAnimationFrame(() => {
    const row = [...app.querySelectorAll('[data-commit]')].find((item) => item.dataset.commit === hash);
    row?.focus();
    row?.scrollIntoView({ block: 'nearest' });
  });
  postCommitDetails(hash, immediate);
}

function orderedPaths() {
  return ui.snapshot?.changelists.flatMap((list) => list.changes.map((change) => change.path)) ?? [];
}

function setSelection(path, checked, range = false) {
  const paths = orderedPaths();
  const anchorIndex = range ? paths.indexOf(ui.selectionAnchor) : -1;
  const pathIndex = paths.indexOf(path);
  const affected = anchorIndex >= 0 && pathIndex >= 0
    ? paths.slice(Math.min(anchorIndex, pathIndex), Math.max(anchorIndex, pathIndex) + 1)
    : [path];
  for (const affectedPath of affected) checked ? ui.selected.add(affectedPath) : ui.selected.delete(affectedPath);
  if (!range || anchorIndex < 0) ui.selectionAnchor = path;
  persist();
}

function postDiff(button, preview = false) {
  post('openDiff', {
    path: button.dataset.diff,
    originalPath: button.dataset.originalPath || undefined,
    kind: button.dataset.kind,
    preview
  });
}

function focusFile(path) {
  ui.focusedPath = path;
  persist();
  render();
  requestAnimationFrame(() => app.querySelectorAll('[data-diff]').forEach((button) => {
    if (button.dataset.diff === path) button.focus();
  }));
}

function moveOptimistically(paths, targetId) {
  const target = ui.snapshot?.changelists.find((list) => list.id === targetId);
  if (!target) return false;
  const moving = new Set(paths);
  const moved = [];
  for (const list of ui.snapshot.changelists) {
    if (list.id === targetId) continue;
    const remaining = [];
    for (const change of list.changes) moving.has(change.path) ? moved.push(change) : remaining.push(change);
    list.changes = remaining;
  }
  if (!moved.length) return false;
  target.changes.push(...moved);
  render();
  return true;
}

function clearDragFeedback() {
  app.querySelectorAll('.dragging, .drag-over').forEach((node) => node.classList.remove('dragging', 'drag-over'));
  dragAvatar?.remove();
  dragAvatar = undefined;
}

// Keep the actual controls alive across snapshots: input focus, selection and scroll
// are browser state, not something a fresh innerHTML string can reproduce reliably.
function keyFor(node) {
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  if (node.dataset.path) return `file:${node.dataset.path}`;
  if (node.dataset.listId) return `list:${node.dataset.listId}`;
  if (node.dataset.checkout) return `branch:${node.dataset.checkout}`;
  if (node.dataset.hash) return `commit:${node.dataset.hash}`;
  return null;
}

function patchNode(current, desired, pool) {
  if (current.nodeType === Node.TEXT_NODE) {
    if (current.textContent !== desired.textContent) current.textContent = desired.textContent;
    return;
  }
  if (current.nodeType !== Node.ELEMENT_NODE) return;
  for (const attribute of [...current.attributes]) {
    if (attribute.name === 'data-bound') continue;
    if (!desired.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
  }
  for (const attribute of desired.attributes) {
    if (current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
  }
  const desiredChildren = [...desired.childNodes];
  for (let index = 0; index < desiredChildren.length; index += 1) {
    const wanted = desiredChildren[index];
    const key = keyFor(wanted);
    let child = key ? pool.get(key) : current.childNodes[index];
    if (child && (child.nodeType !== wanted.nodeType || child.nodeName !== wanted.nodeName || (keyFor(child) && keyFor(child) !== key))) child = null;
    if (!child) child = wanted.cloneNode(true);
    if (child !== current.childNodes[index]) current.insertBefore(child, current.childNodes[index] || null);
    if (child !== wanted) patchNode(child, wanted, pool);
    if (key) pool.delete(key);
  }
  while (current.childNodes.length > desiredChildren.length) current.lastChild.remove();
}

function patchApp(html) {
  // Patch the app root against the same element shape. Using a generic div here
  // would strip #app on the first snapshot and collapse the flex-height tool
  // window after every webview reload.
  const target = document.createElement('main');
  target.id = 'app';
  target.innerHTML = html;
  const pool = new Map([...app.querySelectorAll('[data-path], [data-list-id], [data-checkout], [data-hash]')].map((node) => [keyFor(node), node]));
  const before = new Map([...app.querySelectorAll('.file-row')].map((node) => [node.dataset.path, node.getBoundingClientRect()]));
  const counters = new Map([...app.querySelectorAll('.count, .sync-chip strong')].map((node) => [node, node.textContent]));
  patchNode(app, target, pool);
  if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    for (const row of app.querySelectorAll('.file-row')) {
      const old = before.get(row.dataset.path);
      if (!old) continue;
      const next = row.getBoundingClientRect();
      const dx = old.left - next.left;
      const dy = old.top - next.top;
      if ((dx || dy) && Math.abs(dy) < 1200) row.animate([
        { transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }
      ], { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)' });
    }
    for (const [node, value] of counters) {
      if (node.isConnected && node.textContent !== value) node.animate([
        { transform: 'translateY(3px) scale(.88)', opacity: .45 },
        { transform: 'translateY(0) scale(1)', opacity: 1 }
      ], { duration: 180, easing: 'cubic-bezier(.2,.8,.2,1)' });
    }
  }
}

function render() {
  const s = ui.snapshot;
  if (!s) {
    const hasError = Boolean(ui.emptyMessage);
    app.innerHTML = `<section class="empty-state"><div class="empty-mark">${icon(hasError ? 'error' : 'source-control')}</div><h2>${hasError ? 'Kivo Git needs attention' : 'Open a Git repository'}</h2><p>${escapeHtml(ui.emptyMessage || 'Kivo Git will appear here when the workspace is ready.')}</p><button data-action="refresh">${icon('refresh')} ${hasError ? 'Retry' : 'Refresh'}</button></section>`;
    bind();
    return;
  }
  patchApp(`
    <section class="content ${surface}-content" aria-busy="${ui.busy}">
      ${surface === 'changes' ? renderChanges(s) : renderGraph(s)}
    </section>
    ${surface === 'changes' ? renderBranchPopup(s) : ''}
  `);
  const textarea = app.querySelector('#commit-message');
  if (textarea && document.activeElement !== textarea && textarea.value !== ui.commitMessage) textarea.value = ui.commitMessage;
  const search = app.querySelector('#branch-search');
  if (search && (!ui.branchOpen || document.activeElement !== search) && search.value !== ui.branchQuery) search.value = ui.branchQuery;
  const logBranchSearch = app.querySelector('#log-branch-search');
  if (logBranchSearch && document.activeElement !== logBranchSearch && logBranchSearch.value !== ui.logBranchQuery) logBranchSearch.value = ui.logBranchQuery;
  app.querySelectorAll('[data-select]').forEach((input) => { input.checked = ui.selected.has(input.dataset.select); });
  app.querySelectorAll('[data-select-list]').forEach((input) => {
    const list = s.changelists.find((candidate) => candidate.id === input.dataset.selectList);
    const selected = list?.changes.filter((change) => ui.selected.has(change.path)).length ?? 0;
    input.checked = Boolean(list?.changes.length && selected === list.changes.length);
    input.indeterminate = selected > 0 && selected < (list?.changes.length ?? 0);
  });
  bind();
}

function renderPullMenu() {
  return `<div class="sync-menu ${ui.pullMenuOpen ? 'open' : ''}" role="menu" ${ui.pullMenuOpen ? '' : 'inert'}>
    <div class="sync-menu-title">Pull strategy</div>
    <button role="menuitem" data-pull-strategy="ff-only" ${ui.busy ? 'disabled' : ''}><strong>Fast-forward only</strong><small>Safest · refuse divergence</small></button>
    <button role="menuitem" data-pull-strategy="rebase" ${ui.busy ? 'disabled' : ''}><strong>Rebase</strong><small>Replay local commits on top</small></button>
    <button role="menuitem" data-pull-strategy="merge" ${ui.busy ? 'disabled' : ''}><strong>Merge</strong><small>Create a merge commit if needed</small></button>
  </div>`;
}

function renderCommitToolbar(s) {
  const syncing = ui.syncPhase === 'fetching';
  const fetchIcon = syncing || ui.operationKind === 'fetch' ? 'loading' : 'refresh';
  const hasUpstream = Boolean(s.upstream);
  const pullTitle = s.behind ? `Pull ${s.behind} incoming commit${s.behind === 1 ? '' : 's'}` : 'No incoming commits';
  const pushTitle = s.ahead ? `Push ${s.ahead} outgoing commit${s.ahead === 1 ? '' : 's'}` : 'No commits to push';
  return `<header class="commit-toolbar" aria-label="Commit tool window actions" aria-busy="${syncing}">
    <button class="idea-toolbar-button" data-action="refresh" aria-label="Refresh changes" title="Refresh changes" ${ui.busy ? 'disabled' : ''}>${icon('refresh')}</button>
    <span class="idea-toolbar-divider" aria-hidden="true"></span>
    <button class="idea-toolbar-button" data-action="show-log" aria-label="Open Kivo Git History in the bottom panel" title="Open Kivo Git History">${icon('history')}</button>
    <button class="idea-toolbar-button" data-action="branches" aria-label="Git branches, current branch ${escapeHtml(s.branch)}" title="Branches: ${escapeHtml(s.branch)}" aria-haspopup="dialog" aria-expanded="${ui.branchOpen}">${icon('git-branch')}</button>
    <button class="idea-toolbar-button ${syncing ? 'working' : ''}" data-action="fetch" aria-label="${syncing ? 'Checking remote' : 'Fetch remote updates'}" title="${syncing ? 'Checking remote' : 'Fetch remote updates'}" ${ui.busy || syncing ? 'disabled' : ''}>${icon(fetchIcon, syncing || ui.operationKind === 'fetch' ? 'codicon-modifier-spin' : '')}</button>
    <div class="sync-action-wrap compact-sync-action">
      <button class="idea-toolbar-button ${s.behind ? 'has-count' : ''}" data-action="pull-menu" aria-label="${escapeHtml(pullTitle)}" title="${escapeHtml(pullTitle)}" aria-haspopup="menu" aria-expanded="${ui.pullMenuOpen}" ${!hasUpstream || !s.behind || ui.busy || syncing ? 'disabled' : ''}>${icon('arrow-down')}${s.behind ? `<span class="tool-count">${s.behind}</span>` : ''}</button>
      ${renderPullMenu()}
    </div>
    <button class="idea-toolbar-button ${s.ahead ? 'has-count' : ''}" data-action="push" aria-label="${escapeHtml(pushTitle)}" title="${escapeHtml(pushTitle)}" ${!hasUpstream || !s.ahead || ui.busy || syncing ? 'disabled' : ''}>${icon('arrow-up')}${s.ahead ? `<span class="tool-count">${s.ahead}</span>` : ''}</button>
    <span class="toolbar-spacer"></span>
    <button class="idea-toolbar-button" data-action="new-list" aria-label="Create changelist" title="Create changelist" ${ui.busy ? 'disabled' : ''}>${icon('add')}</button>
    <button class="idea-toolbar-button" data-action="collapse-all" aria-label="Collapse all changelists" title="Collapse all">${icon('chevron-up')}</button>
    <button class="idea-toolbar-button" data-action="expand-all" aria-label="Expand all changelists" title="Expand all">${icon('chevron-down')}</button>
  </header>`;
}

function renderChanges(s) {
  const visiblePaths = s.changelists
    .filter((list) => !ui.collapsed.has(list.id))
    .flatMap((list) => list.changes.map((change) => change.path));
  if (!visiblePaths.includes(ui.focusedPath)) ui.focusedPath = visiblePaths[0];
  const lists = s.changelists.map((list) => {
    const collapsed = ui.collapsed.has(list.id);
    const selected = list.changes.filter((change) => ui.selected.has(change.path)).length;
    const allSelected = list.changes.length > 0 && selected === list.changes.length;
    return `<section class="changelist ${collapsed ? 'collapsed' : ''} ${list.active ? 'active-list' : ''}" data-list-id="${escapeHtml(list.id)}">
      <div class="list-heading"><label class="list-check check"><input type="checkbox" data-select-list="${escapeHtml(list.id)}" aria-label="Select all files in ${escapeHtml(list.name)}" ${allSelected ? 'checked' : ''} ${ui.busy || !list.changes.length ? 'disabled' : ''}><span></span></label><button class="list-collapse" data-collapse="${escapeHtml(list.id)}" aria-expanded="${!collapsed}">
        ${icon('chevron-down', 'disclosure')}<span class="active-dot" title="${list.active ? 'Active changelist' : ''}"></span><span class="list-name">${escapeHtml(list.name)}</span><span class="count">${list.changes.length}</span>
      </button><button class="list-more" data-list-menu="${escapeHtml(list.id)}" aria-label="Actions for ${escapeHtml(list.name)}" aria-expanded="${ui.listMenuId === list.id}">${icon('more')}</button></div>
      <div class="file-list-shell"><div class="file-list" data-drop-list="${escapeHtml(list.id)}">
        ${list.changes.length ? list.changes.map(renderFile).join('') : '<div class="drop-hint">Drop files here</div>'}
      </div></div><div class="list-menu ${ui.listMenuId === list.id ? 'open' : ''}" role="menu" ${ui.listMenuId === list.id ? '' : 'inert'}>
        ${list.active ? '' : `<button role="menuitem" data-list-action="active" data-list-id="${escapeHtml(list.id)}">Set Active</button>`}
        <button role="menuitem" data-list-action="rename" data-list-id="${escapeHtml(list.id)}" data-list-name="${escapeHtml(list.name)}">Rename</button>
        ${list.id === 'default' ? '' : `<button role="menuitem" class="danger" data-list-action="delete" data-list-id="${escapeHtml(list.id)}" data-list-name="${escapeHtml(list.name)}">Delete</button>`}
      </div>
    </section>`;
  }).join('');
  const selectedCount = ui.selected.size;
  const canCommit = Boolean(selectedCount && !ui.busy);
  return `
    ${renderCommitToolbar(s)}
    <div class="commit-changes-heading" role="heading" aria-level="2"><span>Changes</span><small>${s.changes.length || ''}</small></div>
    <div class="lists commit-changes-tree">${lists || '<div class="commit-empty-list">No changes</div>'}</div>
    <footer class="commit-panel">
      <div class="amend-row" title="Amend is intentionally disabled until the selective amend workflow is implemented.">
        <label class="amend-toggle"><input type="checkbox" disabled><span></span><strong>Amend</strong></label>
        <button class="last-commit-link" disabled aria-disabled="true">last commit ${icon('chevron-down')}</button>
        <span class="amend-spacer"></span>${icon('history', 'amend-history')}
      </div>
      <textarea id="commit-message" rows="4" placeholder="Commit Message" aria-label="Commit Message" spellcheck="true" ${ui.operationKind === 'commit' ? 'disabled' : ''}>${escapeHtml(ui.commitMessage)}</textarea>
      <div class="commit-actions">
        <button class="primary-button ${ui.operationKind === 'commit' ? 'working' : ''}" data-action="commit" title="Commit selected files (${commandKey}+Enter)" ${!canCommit ? 'disabled' : ''}>${ui.operationKind === 'commit' ? `${icon('loading', 'codicon-modifier-spin button-spinner')}<span>Committing…</span>` : '<span>Commit</span>'}</button>
        <button class="commit-push-button ${ui.operationKind === 'push' ? 'working' : ''}" data-action="commit-and-push" title="Commit selected files and push" ${!canCommit ? 'disabled' : ''}>${ui.operationKind === 'push' ? `${icon('loading', 'codicon-modifier-spin button-spinner')}<span>Pushing…</span>` : '<span>Commit and Push…</span>'}</button>
        <button class="idea-toolbar-button commit-settings" data-action="open-settings" aria-label="Kivo Git settings" title="Kivo Git settings">${icon('gear')}</button>
      </div>
    </footer>`;
}

function renderFile(change) {
  const checked = ui.selected.has(change.path);
  const filename = change.path.split('/').pop();
  const parent = change.path.includes('/') ? change.path.slice(0, change.path.lastIndexOf('/')) : '';
  return `<div class="file-row ${checked ? 'selected' : ''} ${ui.focusedPath === change.path ? 'focused' : ''}" draggable="${!ui.busy}" data-path="${escapeHtml(change.path)}" title="${escapeHtml(change.path)}">
    <label class="check"><input type="checkbox" aria-label="Select ${escapeHtml(change.path)}" data-select="${escapeHtml(change.path)}" ${checked ? 'checked' : ''} ${ui.busy ? 'disabled' : ''}><span></span></label>
    <button class="file-main" data-diff="${escapeHtml(change.path)}" data-original-path="${escapeHtml(change.originalPath || '')}" data-kind="${escapeHtml(change.kind)}" tabindex="${ui.focusedPath === change.path ? '0' : '-1'}" aria-label="Preview diff for ${escapeHtml(change.path)}">
      ${renderFileTypeIcon(change)}<span class="file-name">${escapeHtml(filename)}</span>${parent ? `<span class="file-parent">${escapeHtml(parent)}</span>` : ''}
    </button>
    <span class="status ${change.kind}">${iconFor(change.kind)}</span>
  </div>`;
}

function renderFileTypeIcon(change) {
  const fileIcon = ui.snapshot?.fileIcons?.[change.path];
  if (fileIcon?.kind === 'image' && fileIcon.uri) {
    return `<img class="file-type-icon" src="${escapeHtml(fileIcon.uri)}" alt="" aria-hidden="true">`;
  }
  if (fileIcon?.kind === 'font' && fileIcon.character && /^[a-zA-Z0-9_-]+$/.test(fileIcon.fontFamily || '')) {
    const color = /^#[0-9a-f]{3,8}$/i.test(fileIcon.color || '') ? `color:${fileIcon.color};` : '';
    const fontSize = /^\d+(?:\.\d+)?%$/.test(fileIcon.fontSize || '') ? `font-size:${fileIcon.fontSize};` : '';
    return `<span class="file-type-icon file-type-glyph" aria-hidden="true" style="font-family:${fileIcon.fontFamily};${color}${fontSize}">${escapeHtml(fileIcon.character)}</span>`;
  }
  return icon('file-code', 'file-type-icon file-type-icon-fallback');
}

function renderRef(ref) {
  const kind = ref.kind === 'remote' ? 'remote' : ref.kind === 'tag' ? 'tag' : 'local';
  return `<span class="graph-ref ${kind} ${ref.current ? 'current' : ''}">${icon(ref.kind === 'tag' ? 'tag' : ref.kind === 'remote' ? 'cloud' : 'git-branch')}<span>${ref.current ? 'HEAD · ' : ''}${escapeHtml(ref.name)}</span></span>`;
}

function graphPoint(lane, laneWidth = 18) {
  return 13 + lane * laneWidth;
}

function renderGraphSvg(commit, laneCount, laneWidth = 18, rowHeight = 30) {
  const lines = [];
  const graphWidth = Math.max(64, laneCount * laneWidth + 20);
  const midpoint = rowHeight / 2;
  const transitions = commit.laneTransitions || [];
  const throughTransitions = transitions.filter((transition) => transition.kind === 'through');
  const parentTransitions = transitions.filter((transition) => transition.kind === 'parent');
  if (throughTransitions.length || parentTransitions.length || commit.hasIncoming !== undefined) {
    for (const transition of throughTransitions) {
      const from = graphPoint(transition.from, laneWidth);
      const to = graphPoint(transition.to, laneWidth);
      lines.push(`<path class="graph-edge through graph-lane-${transition.from % 6}" d="M ${from} 0 C ${from} ${midpoint * .58}, ${to} ${midpoint * 1.42}, ${to} ${rowHeight}"/>`);
    }
    if (commit.hasIncoming) {
      const x = graphPoint(commit.lane, laneWidth);
      lines.push(`<path class="graph-edge incoming graph-lane-${commit.lane % 6}" d="M ${x} 0 L ${x} ${midpoint}"/>`);
    }
    for (const transition of parentTransitions) {
      const from = graphPoint(commit.lane, laneWidth);
      const to = graphPoint(transition.to, laneWidth);
      lines.push(`<path class="graph-edge outgoing graph-lane-${transition.to % 6}" d="M ${from} ${midpoint} C ${from} ${midpoint + midpoint * .44}, ${to} ${midpoint + midpoint * .52}, ${to} ${rowHeight}"/>`);
    }
  } else {
    for (const incomingLane of commit.incomingLanes || []) {
      const from = graphPoint(incomingLane, laneWidth);
      const to = graphPoint(commit.lane, laneWidth);
      lines.push(`<path class="graph-edge incoming graph-lane-${incomingLane % 6}" d="M ${from} 0 C ${from} ${midpoint * .48}, ${to} ${midpoint * .56}, ${to} ${midpoint}"/>`);
    }
    for (const parentLane of commit.parentLanes || []) {
      const from = graphPoint(commit.lane, laneWidth);
      const to = graphPoint(parentLane, laneWidth);
      lines.push(`<path class="graph-edge outgoing graph-lane-${parentLane % 6}" d="M ${from} ${midpoint} C ${from} ${midpoint + midpoint * .44}, ${to} ${midpoint + midpoint * .52}, ${to} ${rowHeight}"/>`);
    }
  }
  lines.push(`<circle class="graph-node graph-lane-${commit.lane % 6} ${commit.parents?.length > 1 ? 'merge' : ''}" cx="${graphPoint(commit.lane, laneWidth)}" cy="${midpoint}" r="${commit.parents?.length > 1 ? '4.5' : '3.6'}"/>`);
  return `<svg class="graph-svg" viewBox="0 0 ${graphWidth} ${rowHeight}" preserveAspectRatio="none" aria-hidden="true">${lines.join('')}</svg>`;
}

function buildPathTree(items) {
  const root = { directories: new Map(), leaves: [] };
  for (const item of items) {
    const segments = String(item.path || item.name || '').split('/').filter(Boolean);
    const leaf = segments.pop();
    if (!leaf) continue;
    let node = root;
    for (const segment of segments) {
      if (!node.directories.has(segment)) node.directories.set(segment, { directories: new Map(), leaves: [] });
      node = node.directories.get(segment);
    }
    node.leaves.push({ ...item, leaf });
  }
  return root;
}

function renderCommitFileTree(node, depth = 0) {
  const folders = [...node.directories.entries()].sort(([left], [right]) => left.localeCompare(right));
  return `${folders.map(([name, child]) => `<div class="commit-file-folder" style="--tree-indent:${depth * 13}px">${icon('chevron-down')} ${icon('folder')}<span>${escapeHtml(name)}</span></div>${renderCommitFileTree(child, depth + 1)}`).join('')}${node.leaves.sort((left, right) => left.leaf.localeCompare(right.leaf)).map((file) => {
    const kind = file.status === 'D' ? 'deleted' : file.status === 'A' ? 'added' : 'modified';
    return `<button class="commit-file tree-file" style="--tree-indent:${depth * 13}px" data-commit-file="${escapeHtml(file.path)}" data-commit-kind="${escapeHtml(file.status)}" data-commit-original="${escapeHtml(file.originalPath || '')}" title="Open diff for ${escapeHtml(file.path)}"><span class="status ${kind}">${escapeHtml(file.status)}</span>${icon('file-code')}<span>${escapeHtml(file.leaf)}</span></button>`;
  }).join('')}`;
}

function renderCommitDetails(s) {
  const toolbar = `<div class="commit-detail-toolbar"><button class="idea-toolbar-button" data-action="refresh" aria-label="Refresh History" title="Refresh History">${icon('refresh')}</button><span class="toolbar-spacer"></span>${ui.selectedCommitHash ? `<button class="idea-toolbar-button" data-action="close-commit" aria-label="Clear selected commit" title="Clear selection">${icon('close')}</button>` : ''}</div>`;
  if (!ui.selectedCommitHash) {
    return `<aside class="commit-detail commit-detail-empty" aria-label="Commit details">${toolbar}<div class="commit-detail-empty-copy"><div class="detail-empty-mark">${icon('git-commit')}</div><strong>Select a commit</strong><span>Its changed files and commit message appear here.</span></div></aside>`;
  }
  const commit = s.commits.find((item) => item.hash === ui.selectedCommitHash);
  if (!commit) return '';
  const details = ui.commitDetails?.hash === commit.hash ? ui.commitDetails : undefined;
  return `<aside class="commit-detail" aria-label="Commit details">
    ${toolbar}
    <div class="commit-files-panel">
      <div class="details-section-heading"><span>Changed Files</span><span class="details-count">${details ? details.files.length : ''}</span></div>
      ${ui.commitDetailsLoading && !details ? `<div class="detail-loading">${icon('loading', 'codicon-modifier-spin')} Loading changed files…</div>` : ''}
      ${ui.commitDetailsError && !details ? `<div class="detail-error" role="alert">${icon('error')}<span>${escapeHtml(ui.commitDetailsError)}</span><button class="text-button" data-action="retry-commit">Retry</button></div>` : ''}
      ${details ? `<div class="commit-files file-tree">${details.files.length ? renderCommitFileTree(buildPathTree(details.files)) : '<span class="detail-muted">No file changes reported</span>'}</div>` : ''}
    </div>
    <div class="commit-metadata">
      <div class="commit-detail-head"><div><span class="detail-kicker">${escapeHtml(commit.shortHash)}</span><strong>${escapeHtml(commit.subject)}</strong></div></div>
      <div class="commit-detail-meta"><span>${escapeHtml(commit.author)} · ${relativeTime(commit.date)}</span><code>${escapeHtml(commit.hash)}</code></div>
      <div class="commit-detail-refs">${commit.refs.map(renderRef).join('') || '<span class="detail-muted">No branch label</span>'}</div>
      ${details?.body && details.body !== details.subject ? `<p class="commit-body">${escapeHtml(details.body)}</p>` : ''}
      ${details?.parents?.length ? `<div class="detail-parents"><span>Parents</span>${details.parents.map((parent) => `<code>${escapeHtml(parent.slice(0, 8))}</code>`).join('')}</div>` : ''}
    </div>
  </aside>`;
}

function renderLogBranchRow(branch, depth = 0) {
  const kind = branch.kind === 'tag' ? 'tag' : 'branch';
  const label = branch.leaf || branch.name;
  return `<button class="log-branch-row ${branch.current ? 'current' : ''} ${ui.graphBranchFilter === branch.name ? 'selected' : ''}" style="--tree-indent:${depth * 13}px" data-log-branch="${escapeHtml(branch.name)}" data-branch-ref="${escapeHtml(branch.name)}" data-branch-remote="${branch.remote ? 'true' : 'false'}" data-branch-kind="${kind}" aria-pressed="${ui.graphBranchFilter === branch.name}" aria-haspopup="menu" title="Show ${escapeHtml(branch.name)} history · Right-click for ${kind} actions">${icon(branch.remote ? 'cloud' : kind === 'tag' ? 'tag' : 'git-branch')}<span>${escapeHtml(label)}</span>${branch.current ? '<small>HEAD</small>' : ''}</button>`;
}

function renderLogBranchTree(node, depth = 0) {
  const folders = [...node.directories.entries()].sort(([left], [right]) => left.localeCompare(right));
  return `${folders.map(([name, child]) => `<div class="log-branch-folder" style="--tree-indent:${depth * 13}px">${icon('chevron-down')} ${icon('folder')}<span>${escapeHtml(name)}</span></div>${renderLogBranchTree(child, depth + 1)}`).join('')}${node.leaves.sort((left, right) => left.leaf.localeCompare(right.leaf)).map((branch) => renderLogBranchRow(branch, depth)).join('')}`;
}

function renderLogBranchPane(s) {
  const query = ui.logBranchQuery.trim().toLowerCase();
  const matches = (item) => !query || item.name.toLowerCase().includes(query);
  const local = s.branches.filter((branch) => !branch.remote && matches(branch));
  const remote = s.branches.filter((branch) => branch.remote && matches(branch));
  const tags = (s.tags || []).filter(matches).map((tag) => ({ ...tag, path: tag.name, name: tag.name, remote: false, kind: 'tag' }));
  const current = s.branches.find((branch) => branch.current && !branch.remote);
  const root = current && matches(current) ? renderLogBranchRow({ ...current, leaf: current.name }) : '';
  const group = (label, tree, emptyLabel) => `<section class="log-branch-group"><div class="log-branch-group-title">${icon('chevron-down')}<span>${label}</span></div>${tree || `<div class="branch-tree-empty">${emptyLabel}</div>`}</section>`;
  return `<aside class="log-branch-pane" id="kivo-log-branches" aria-label="History branches">
    <label class="log-branch-search">${icon('search')}<input id="log-branch-search" aria-label="Branch or tag" placeholder="Branch or tag" value="${escapeHtml(ui.logBranchQuery)}"></label>
    <div class="log-branch-tree">
      <section class="log-branch-group log-head-group"><div class="log-branch-group-title"><span>HEAD (Current Branch)</span></div>${root || '<div class="branch-tree-empty">No current branch</div>'}</section>
      ${group('Local', renderLogBranchTree(buildPathTree(local)), 'No local branches')}
      ${group('Remote', renderLogBranchTree(buildPathTree(remote)), 'No remote branches')}
      ${tags.length ? group('Tags', renderLogBranchTree(buildPathTree(tags)), 'No tags') : ''}
    </div>
  </aside>`;
}

function renderBranchContextMenu() {
  const menu = ui.branchContextMenu;
  if (!menu) return '';
  const width = 248;
  const height = menu.kind === 'tag' || menu.current ? 106 : 138;
  const left = clamp(menu.x, 8, Math.max(8, window.innerWidth - width - 8));
  const top = clamp(menu.y, 8, Math.max(8, window.innerHeight - height - 8));
  const refLabel = menu.kind === 'tag' ? 'tag' : 'branch';
  return `<div class="branch-context-menu" data-branch-context role="menu" aria-label="Actions for ${escapeHtml(menu.ref)}" style="left:${left}px;top:${top}px">
    <div class="branch-context-title"><span>${icon(menu.remote ? 'cloud' : menu.kind === 'tag' ? 'tag' : 'git-branch')}</span><strong title="${escapeHtml(menu.ref)}">${escapeHtml(menu.ref)}</strong></div>
    <button role="menuitem" data-branch-context-action="new" ${ui.busy ? 'disabled' : ''}>${icon('git-branch-create')}<span>New Branch from this ${refLabel}…</span></button>
    ${menu.kind === 'branch' && !menu.current ? `<button role="menuitem" data-branch-context-action="checkout" ${ui.busy ? 'disabled' : ''}>${icon('check')}<span>Checkout</span></button>` : ''}
    <button role="menuitem" data-branch-context-action="filter">${icon('filter')}<span>Show History</span></button>
  </div>`;
}

function renderLogActionRail() {
  return `<aside class="log-action-rail" aria-label="History actions">
    <button class="idea-toolbar-button" data-action="show-changes" aria-label="Open Commit tool window" title="Open Commit tool window">${icon('source-control')}</button>
    <button class="idea-toolbar-button" data-action="refresh" aria-label="Refresh History" title="Refresh History">${icon('refresh')}</button>
    <button class="idea-toolbar-button" data-action="fetch" aria-label="Fetch remote updates" title="Fetch remote updates" ${ui.busy || ui.syncPhase === 'fetching' ? 'disabled' : ''}>${icon(ui.syncPhase === 'fetching' ? 'loading' : 'cloud-download', ui.syncPhase === 'fetching' ? 'codicon-modifier-spin' : '')}</button>
    <span class="idea-toolbar-divider" aria-hidden="true"></span>
    <button class="idea-toolbar-button" data-action="clear-graph-filters" aria-label="Clear History filters" title="Clear History filters">${icon('clear-all')}</button>
  </aside>`;
}

function renderLogFilterBar(s, commits, filtersActive) {
  const branchOptions = [...new Set(s.branches.map((branch) => branch.name))].sort((a, b) => a.localeCompare(b));
  const authorOptions = [...new Set(s.commits.map((commit) => commit.author))].sort((a, b) => a.localeCompare(b));
  const countLabel = filtersActive ? `${commits.length} of ${s.commits.length}` : `${s.commits.length}`;
  return `<div class="log-filter-bar"><div class="graph-toolbar-head">
    <label class="graph-search log-search">${icon('search')}<input id="graph-search" aria-label="Search by text or hash" placeholder="Text or hash" value="${escapeHtml(ui.graphQuery)}"></label>
    <div class="graph-filters" aria-label="History filters">
      <label class="graph-filter"><span>Branch:</span><select data-graph-filter="branch" aria-label="Filter by branch"><option value="">All branches</option>${branchOptions.map((branch) => `<option value="${escapeHtml(branch)}" ${ui.graphBranchFilter === branch ? 'selected' : ''}>${escapeHtml(branch)}</option>`).join('')}</select></label>
      <label class="graph-filter"><span>User</span><select data-graph-filter="author" aria-label="Filter by author"><option value="">All</option>${authorOptions.map((author) => `<option value="${escapeHtml(author)}" ${ui.graphAuthorFilter === author ? 'selected' : ''}>${escapeHtml(author)}</option>`).join('')}</select></label>
      <label class="graph-filter"><span>Date</span><select data-graph-filter="age" aria-label="Filter by date"><option value="all" ${ui.graphAgeFilter === 'all' ? 'selected' : ''}>All</option><option value="7d" ${ui.graphAgeFilter === '7d' ? 'selected' : ''}>7 days</option><option value="30d" ${ui.graphAgeFilter === '30d' ? 'selected' : ''}>30 days</option><option value="90d" ${ui.graphAgeFilter === '90d' ? 'selected' : ''}>90 days</option></select></label>
      <label class="graph-filter path-filter"><span>Paths</span><input id="graph-path" aria-label="Filter by path" placeholder="Any" value="${escapeHtml(ui.graphPathFilter)}"></label>
      ${filtersActive ? '<button class="text-button graph-clear" data-action="clear-graph-filters">Clear</button>' : ''}
    </div><span class="log-result-count" aria-live="polite">${countLabel}</span>
  </div></div>`;
}

function renderGraph(s) {
  const commits = graphCommits();
  const lanes = s.commits.flatMap((commit) => [commit.lane, ...(commit.incomingLanes || []), ...(commit.parentLanes || [])]);
  const laneCount = lanes.length ? Math.max(1, Math.max(...lanes) + 1) : 1;
  const graphWidth = Math.max(64, laneCount * 16 + 20);
  const focusHash = ui.focusedCommitHash && commits.some((commit) => commit.hash === ui.focusedCommitHash)
    ? ui.focusedCommitHash
    : commits[0]?.hash;
  const filtersActive = Boolean(ui.graphBranchFilter || ui.graphAuthorFilter || ui.graphAgeFilter !== 'all' || ui.graphQuery.trim() || ui.graphPathFilter.trim());
  const branchWidth = Math.round(clamp(ui.logBranchWidth, LOG_BRANCH_MIN_WIDTH, LOG_BRANCH_MAX_WIDTH));
  return `<div class="graph-view log-view" role="tabpanel" aria-label="Kivo Git History">
    <div class="log-workspace" style="--log-branch-width:${branchWidth}px">
      ${renderLogActionRail()}
      ${renderLogBranchPane(s)}
      <div class="log-splitter" data-log-splitter role="separator" aria-label="Resize History branch tree" aria-controls="kivo-log-branches kivo-log-history" aria-orientation="vertical" aria-valuemin="${LOG_BRANCH_MIN_WIDTH}" aria-valuemax="${LOG_BRANCH_MAX_WIDTH}" aria-valuenow="${branchWidth}" tabindex="0" title="Drag to resize the branch tree. Double-click to reset."></div>
      <section class="log-history-pane" id="kivo-log-history" aria-label="Commit history">
        ${renderLogFilterBar(s, commits, filtersActive)}
        <div class="log-column-header" aria-hidden="true" style="--graph-width:${graphWidth}px"><span>AUTHOR</span><span>GRAPH</span><span>COMMIT</span><span>DATE</span></div>
        <div class="graph-list" role="listbox" aria-label="Commit history" style="--lane-count:${laneCount};--graph-width:${graphWidth}px">${commits.length ? commits.map((commit, index) => `<article class="graph-row ${commit.parents.length > 1 ? 'merge-row' : ''} ${ui.selectedCommitHash === commit.hash ? 'selected' : ''}" data-commit="${escapeHtml(commit.hash)}" data-hash="${escapeHtml(commit.hash)}" role="option" aria-selected="${ui.selectedCommitHash === commit.hash}" tabindex="${focusHash === commit.hash ? '0' : '-1'}" style="--delay:${Math.min(index * 5, 90)}ms">
          <span class="log-author" title="${escapeHtml(commit.author)}">${escapeHtml(commit.author)}</span><div class="graph-canvas">${renderGraphSvg(commit, laneCount, 16, 26)}</div><div class="graph-commit"><div class="log-subject"><strong>${escapeHtml(commit.subject)}</strong>${(commit.refs || []).slice(0, 3).map(renderRef).join('')}</div><span class="log-meta"><code>${escapeHtml(commit.shortHash)}</code>${commit.parents?.length > 1 ? '<span class="merge-note">Merge</span>' : ''}</span></div><time class="log-date" title="${escapeHtml(commit.date)}">${relativeTime(commit.date)}</time>
        </article>`).join('') : `<div class="inline-empty">${s.commits.length ? 'No matching commits' : 'No commits yet'}</div>`}</div>
        ${s.commitsHasMore ? `<button class="load-more ${ui.graphLoadingMore ? 'working' : ''}" data-action="load-more-commits" ${ui.busy || ui.graphLoadingMore ? 'disabled' : ''}>${ui.graphLoadingMore ? icon('loading', 'codicon-modifier-spin') : icon('history')}<span>${ui.graphLoadingMore ? 'Loading history…' : 'Load more history'}</span><small>Showing ${s.commits.length}</small></button>` : ''}
      </section>
      ${renderCommitDetails(s)}
    </div>
    ${renderBranchContextMenu()}
  </div>`;
}

function logBranchBounds(splitter) {
  const workspace = splitter.closest('.log-workspace');
  const compact = window.matchMedia('(max-width: 860px)').matches;
  const narrow = window.matchMedia('(max-width: 1180px)').matches;
  const railWidth = compact || narrow ? 30 : 32;
  const detailWidth = compact ? 0 : narrow ? 222 : 274;
  const historyMinimum = compact ? 220 : 300;
  const availableWidth = workspace?.clientWidth || 0;
  const maximum = availableWidth
    ? Math.min(LOG_BRANCH_MAX_WIDTH, Math.max(LOG_BRANCH_MIN_WIDTH, availableWidth - railWidth - 6 - detailWidth - historyMinimum))
    : LOG_BRANCH_MAX_WIDTH;
  return { minimum: LOG_BRANCH_MIN_WIDTH, maximum };
}

function applyLogBranchWidth(splitter, width) {
  const workspace = splitter.closest('.log-workspace');
  const { minimum, maximum } = logBranchBounds(splitter);
  const next = Math.round(clamp(width, minimum, maximum));
  ui.logBranchWidth = next;
  workspace?.style.setProperty('--log-branch-width', `${next}px`);
  splitter.setAttribute('aria-valuemin', String(minimum));
  splitter.setAttribute('aria-valuemax', String(maximum));
  splitter.setAttribute('aria-valuenow', String(next));
  return next;
}

function finishLogResize(commit = true) {
  const resize = activeLogResize;
  if (!resize) return;
  resize.splitter.removeEventListener('pointermove', resize.move);
  resize.splitter.removeEventListener('pointerup', resize.complete);
  resize.splitter.removeEventListener('pointercancel', resize.cancel);
  if (resize.splitter.hasPointerCapture?.(resize.pointerId)) resize.splitter.releasePointerCapture?.(resize.pointerId);
  document.body.classList.remove('log-resizing');
  activeLogResize = undefined;
  if (commit) persist();
  else applyLogBranchWidth(resize.splitter, resize.initialWidth);
}

function startLogResize(event) {
  if (event.button !== 0 || activeLogResize) return;
  const splitter = event.currentTarget;
  const workspace = splitter.closest('.log-workspace');
  if (!workspace || getComputedStyle(splitter).display === 'none') return;
  event.preventDefault();
  const initialWidth = applyLogBranchWidth(splitter, ui.logBranchWidth);
  const pointerId = event.pointerId;
  const move = (pointerEvent) => {
    if (pointerEvent.pointerId !== pointerId) return;
    const railWidth = app.querySelector('.log-action-rail')?.getBoundingClientRect().width || 32;
    const dividerWidth = splitter.getBoundingClientRect().width || 6;
    applyLogBranchWidth(splitter, pointerEvent.clientX - workspace.getBoundingClientRect().left - railWidth - dividerWidth / 2);
  };
  const complete = (pointerEvent) => {
    if (pointerEvent.pointerId === pointerId) finishLogResize(true);
  };
  const cancel = (pointerEvent) => {
    if (pointerEvent.pointerId === pointerId) finishLogResize(false);
  };
  activeLogResize = { splitter, pointerId, initialWidth, move, complete, cancel };
  splitter.setPointerCapture?.(pointerId);
  splitter.addEventListener('pointermove', move);
  splitter.addEventListener('pointerup', complete);
  splitter.addEventListener('pointercancel', cancel);
  document.body.classList.add('log-resizing');
}

function resetLogBranchWidth(event) {
  const splitter = event.currentTarget;
  applyLogBranchWidth(splitter, LOG_BRANCH_DEFAULT_WIDTH);
  persist();
}

function openBranchContextMenu(event) {
  event.preventDefault();
  const row = event.currentTarget;
  const ref = row.dataset.branchRef;
  if (!ref) return;
  ui.branchContextMenu = {
    ref,
    remote: row.dataset.branchRemote === 'true',
    current: row.classList.contains('current'),
    kind: row.dataset.branchKind === 'tag' ? 'tag' : 'branch',
    x: event.clientX,
    y: event.clientY
  };
  render();
  requestAnimationFrame(() => app.querySelector('[data-branch-context-action="new"]')?.focus());
}

function runBranchContextAction(event) {
  event.preventDefault();
  event.stopPropagation();
  const menu = ui.branchContextMenu;
  const action = event.currentTarget.dataset.branchContextAction;
  if (!menu || !action) return;
  ui.branchContextMenu = undefined;
  if (action === 'new' && !ui.busy) post('createBranch', { startPoint: menu.ref });
  if (action === 'checkout' && !ui.busy) post('checkout', { branch: menu.ref, remote: menu.remote });
  if (action === 'filter') {
    ui.graphBranchFilter = menu.ref;
    persist();
  }
  render();
}

function adjustLogBranchWidth(event) {
  const splitter = event.currentTarget;
  const { minimum, maximum } = logBranchBounds(splitter);
  const step = event.shiftKey ? 24 : 12;
  let width;
  if (event.key === 'ArrowLeft') width = ui.logBranchWidth - step;
  if (event.key === 'ArrowRight') width = ui.logBranchWidth + step;
  if (event.key === 'Home') width = minimum;
  if (event.key === 'End') width = maximum;
  if (width === undefined) return;
  event.preventDefault();
  applyLogBranchWidth(splitter, width);
  persist();
}

function renderBranchPopup(s) {
  const query = ui.branchQuery.toLowerCase();
  const filtered = s.branches.filter((branch) => branch.name.toLowerCase().includes(query));
  const local = filtered.filter((branch) => !branch.remote);
  const remote = filtered.filter((branch) => branch.remote);
  const rows = (items) => items.map((branch) => `<button class="branch-row ${branch.current ? 'current' : ''}" data-checkout="${escapeHtml(branch.name)}" data-remote="${branch.remote}" ${ui.busy ? 'disabled' : ''}>
      ${icon(branch.current ? 'check' : branch.remote ? 'cloud' : 'git-branch')}<span class="branch-row-name">${escapeHtml(branch.name)}</span>${branch.tracking ? `<small>${escapeHtml(branch.tracking)}</small>` : ''}
    </button>`).join('');
  return `<div class="branch-overlay ${ui.branchOpen ? 'open' : ''}" ${ui.branchOpen ? '' : 'inert'} aria-hidden="${!ui.branchOpen}"><div class="scrim" data-action="close-branches"></div><aside class="branch-popup" role="dialog" aria-modal="true" aria-label="Git branches">
    <div class="popup-title"><strong>Git Branches</strong><button class="icon-button" aria-label="Close branches" data-action="close-branches">${icon('close')}</button></div>
    <div class="search-wrap">${icon('search')}<input id="branch-search" aria-label="Search branches" placeholder="Search branches" value="${escapeHtml(ui.branchQuery)}"></div>
    <div class="branch-groups"><h3>LOCAL BRANCHES</h3>${rows(local) || '<p class="no-results">No local branches</p>'}<h3>REMOTE BRANCHES</h3>${rows(remote) || '<p class="no-results">No remote branches</p>'}</div>
  </aside></div>`;
}

function bind() {
  const once = (selector, event, handler) => app.querySelectorAll(selector).forEach((node) => {
    const token = `${selector}:${event}`;
    if (!node.__ideaGitListeners) node.__ideaGitListeners = new Set();
    if (node.__ideaGitListeners.has(token)) return;
    node.__ideaGitListeners.add(token);
    node.addEventListener(event, handler);
  });
  once('[data-action]', 'click', (event) => handleAction(event.currentTarget.dataset.action));
  once('[data-commit]', 'click', (event) => selectCommit(event.currentTarget.dataset.commit));
  once('[data-commit]', 'keydown', (event) => {
    if (['Enter', ' '].includes(event.key)) {
      event.preventDefault();
      event.currentTarget.click();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const rows = [...app.querySelectorAll('[data-commit]')];
    if (!rows.length) return;
    event.preventDefault();
    const current = rows.indexOf(event.currentTarget);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : current + (event.key === 'ArrowDown' ? 1 : -1);
    const target = rows[Math.max(0, Math.min(rows.length - 1, next))];
    if (target && target !== event.currentTarget) selectCommit(target.dataset.commit, { focus: true, immediate: false });
  });
  once('[data-commit-file]', 'click', (event) => {
    const button = event.currentTarget;
    if (!ui.selectedCommitHash) return;
    post('openCommitDiff', {
      hash: ui.selectedCommitHash,
      path: button.dataset.commitFile,
      originalPath: button.dataset.commitOriginal || undefined,
      kind: button.dataset.commitKind
    });
  });
  const graphSearch = app.querySelector('#graph-search');
  if (graphSearch && !graphSearch.__ideaGitListeners) {
    graphSearch.__ideaGitListeners = new Set(['search']);
    graphSearch.addEventListener('input', () => {
      ui.graphQuery = graphSearch.value;
      persist();
      render();
      requestAnimationFrame(() => {
        const input = app.querySelector('#graph-search');
        input?.focus();
        input?.setSelectionRange(ui.graphQuery.length, ui.graphQuery.length);
      });
      });
  }
  const graphPath = app.querySelector('#graph-path');
  if (graphPath && !graphPath.__ideaGitListeners) {
    graphPath.__ideaGitListeners = new Set(['path-search']);
    graphPath.addEventListener('input', () => {
      ui.graphPathFilter = graphPath.value;
      persist();
      render();
      requestAnimationFrame(() => {
        const input = app.querySelector('#graph-path');
        input?.focus();
        input?.setSelectionRange(ui.graphPathFilter.length, ui.graphPathFilter.length);
      });
    });
  }
  const logBranchSearch = app.querySelector('#log-branch-search');
  if (logBranchSearch && !logBranchSearch.__ideaGitListeners) {
    logBranchSearch.__ideaGitListeners = new Set(['branch-tree-search']);
    logBranchSearch.addEventListener('input', () => {
      ui.logBranchQuery = logBranchSearch.value;
      persist();
      render();
      requestAnimationFrame(() => {
        const input = app.querySelector('#log-branch-search');
        input?.focus();
        input?.setSelectionRange(ui.logBranchQuery.length, ui.logBranchQuery.length);
      });
    });
  }
  once('[data-graph-filter]', 'change', (event) => {
    const select = event.currentTarget;
    if (select.dataset.graphFilter === 'branch') ui.graphBranchFilter = select.value;
    if (select.dataset.graphFilter === 'author') ui.graphAuthorFilter = select.value;
    if (select.dataset.graphFilter === 'age') ui.graphAgeFilter = select.value || 'all';
    persist();
    render();
  });
  once('[data-log-branch]', 'click', (event) => {
    ui.graphBranchFilter = event.currentTarget.dataset.logBranch || '';
    persist();
    render();
  });
  once('[data-log-branch]', 'contextmenu', openBranchContextMenu);
  once('[data-branch-context-action]', 'click', runBranchContextAction);
  once('[data-log-splitter]', 'pointerdown', startLogResize);
  once('[data-log-splitter]', 'dblclick', resetLogBranchWidth);
  once('[data-log-splitter]', 'keydown', adjustLogBranchWidth);
  once('[data-pull-strategy]', 'click', (event) => {
    event.stopPropagation();
    if (ui.busy) return;
    const strategy = event.currentTarget.dataset.pullStrategy;
    ui.pullMenuOpen = false;
    render();
    post('pull', { strategy });
  });
  once('[data-pull-strategy]', 'keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      ui.pullMenuOpen = false;
      render();
      app.querySelector('[data-action="pull-menu"]')?.focus();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const items = [...app.querySelectorAll('[data-pull-strategy]:not(:disabled)')];
    const current = items.indexOf(event.currentTarget);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[Math.max(0, next)]?.focus();
  });
  once('[data-list-menu]', 'click', (event) => {
    event.stopPropagation();
    const id = event.currentTarget.dataset.listMenu;
    ui.listMenuId = ui.listMenuId === id ? undefined : id;
    render();
    if (ui.listMenuId) requestAnimationFrame(() => {
      const section = [...app.querySelectorAll('.changelist')].find((item) => item.dataset.listId === id);
      section?.querySelector('.list-menu.open button')?.focus();
    });
  });
  once('[data-list-action]', 'click', (event) => {
    event.stopPropagation();
    const button = event.currentTarget;
    const type = button.dataset.listAction;
    ui.listMenuId = undefined;
    if (type === 'active') post('setActiveChangelist', { id: button.dataset.listId });
    if (type === 'rename') post('renameChangelist', { id: button.dataset.listId, name: button.dataset.listName });
    if (type === 'delete') post('deleteChangelist', { id: button.dataset.listId, name: button.dataset.listName });
    render();
  });
  once('[data-collapse]', 'click', (event) => {
    const button = event.currentTarget;
    const id = button.dataset.collapse;
    ui.collapsed.has(id) ? ui.collapsed.delete(id) : ui.collapsed.add(id);
    persist();
    render();
  });
  once('[data-select]', 'click', (event) => {
    const input = event.currentTarget;
    input.dataset.selectionFromClick = 'true';
    setSelection(input.dataset.select, input.checked, event.shiftKey);
    render();
  });
  once('[data-select]', 'change', (event) => {
    const input = event.currentTarget;
    if (input.dataset.selectionFromClick === 'true') {
      delete input.dataset.selectionFromClick;
      return;
    }
    setSelection(input.dataset.select, input.checked);
    render();
  });
  once('[data-select-list]', 'change', (event) => {
    const input = event.currentTarget;
    const list = ui.snapshot?.changelists.find((candidate) => candidate.id === input.dataset.selectList);
    if (!list) return;
    for (const change of list.changes) input.checked ? ui.selected.add(change.path) : ui.selected.delete(change.path);
    persist();
    render();
  });
  once('[data-diff]', 'click', (event) => {
    const button = event.currentTarget;
    ui.focusedPath = button.dataset.diff;
    ui.selectionAnchor = button.dataset.diff;
    persist();
    render();
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => postDiff(button, true), 140);
  });
  once('[data-diff]', 'dblclick', (event) => {
    clearTimeout(previewTimer);
    postDiff(event.currentTarget);
  });
  once('[data-diff]', 'keydown', (event) => {
    const button = event.currentTarget;
    if (event.key === 'Enter') {
      event.preventDefault();
      postDiff(button);
      return;
    }
    if (event.key === ' ') {
      event.preventDefault();
      setSelection(button.dataset.diff, !ui.selected.has(button.dataset.diff), event.shiftKey);
      focusFile(button.dataset.diff);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const buttons = [...app.querySelectorAll('[data-diff]')].filter((item) => !item.closest('.collapsed'));
    const current = buttons.indexOf(button);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : current + (event.key === 'ArrowDown' ? 1 : -1);
    const target = buttons[Math.max(0, Math.min(buttons.length - 1, next))];
    if (!target) return;
    if (event.shiftKey) {
      if (!ui.selectionAnchor) ui.selectionAnchor = button.dataset.diff;
      setSelection(target.dataset.diff, true, true);
    } else {
      ui.selectionAnchor = target.dataset.diff;
    }
    focusFile(target.dataset.diff);
  });
  once('[data-checkout]', 'click', (event) => {
    const button = event.currentTarget;
    if (button.classList.contains('current') || ui.busy) return;
    const source = button.getBoundingClientRect();
    const target = app.querySelector('.branch-pill')?.getBoundingClientRect();
    const branch = button.dataset.remote === 'true' ? button.dataset.checkout.split('/').slice(1).join('/') : button.dataset.checkout;
    if (target) ui.branchMotion = { branch, x: source.left - target.left, y: source.top - target.top };
    ui.branchOpen = false;
    ui.branchQuery = '';
    post('checkout', { branch: button.dataset.checkout, remote: button.dataset.remote === 'true' });
    render();
  });
  once('[draggable="true"]', 'dragstart', (event) => {
    if (ui.busy) { event.preventDefault(); return; }
    const row = event.currentTarget;
    const paths = ui.selected.has(row.dataset.path) ? [...ui.selected] : [row.dataset.path];
    event.dataTransfer.setData('application/x-ideagit-paths', JSON.stringify(paths));
    event.dataTransfer.effectAllowed = 'move';
    row.classList.add('dragging');
    dragAvatar = document.createElement('div');
    dragAvatar.className = 'drag-avatar';
    dragAvatar.textContent = paths.length === 1 ? paths[0].split('/').pop() : `${paths.length} files`;
    document.body.append(dragAvatar);
    event.dataTransfer.setDragImage(dragAvatar, 16, 14);
  });
  once('[draggable="true"]', 'dragend', clearDragFeedback);
  once('[data-drop-list]', 'dragover', (event) => { event.preventDefault(); event.currentTarget.classList.add('drag-over'); });
  once('[data-drop-list]', 'dragleave', (event) => {
    if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.classList.remove('drag-over');
  });
  once('[data-drop-list]', 'drop', (event) => {
      const zone = event.currentTarget;
      event.preventDefault();
      clearDragFeedback();
      const paths = JSON.parse(event.dataTransfer.getData('application/x-ideagit-paths') || '[]');
      if (paths.length && moveOptimistically(paths, zone.dataset.dropList)) post('moveFiles', { paths, listId: zone.dataset.dropList });
  });
  once('.list-menu', 'keydown', (event) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const items = [...event.currentTarget.querySelectorAll('button')];
    const current = items.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : current + (event.key === 'ArrowDown' ? 1 : -1);
    items[(next + items.length) % items.length]?.focus();
  });
  const textarea = app.querySelector('#commit-message');
  if (textarea) {
    if (!textarea.__ideaGitListeners) textarea.__ideaGitListeners = new Set();
    if (!textarea.__ideaGitListeners.has('commit')) {
      textarea.__ideaGitListeners.add('commit');
      textarea.addEventListener('input', () => { ui.commitMessage = textarea.value; persist(); });
      textarea.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); commit(); }
      });
    }
  }
  const search = app.querySelector('#branch-search');
  if (search && !search.__ideaGitListeners) {
    search.__ideaGitListeners = new Set(['search']);
    search.addEventListener('input', () => {
      ui.branchQuery = search.value;
      app.querySelectorAll('[data-checkout]').forEach((row) => { row.hidden = !row.dataset.checkout.toLowerCase().includes(ui.branchQuery.toLowerCase()); });
    });
    search.addEventListener('keydown', (event) => {
      if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
      event.preventDefault();
      const rows = [...app.querySelectorAll('[data-checkout]:not([hidden])')];
      (event.key === 'ArrowDown' ? rows[0] : rows.at(-1))?.focus();
    });
  }
  once('[data-checkout]', 'keydown', (event) => {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    const rows = [...app.querySelectorAll('[data-checkout]:not([hidden])')];
    const next = rows.indexOf(event.currentTarget) + (event.key === 'ArrowDown' ? 1 : -1);
    (rows[next] || app.querySelector('#branch-search'))?.focus();
  });
}

function handleAction(action) {
  if (action === 'refresh') post('refresh');
  if (action === 'show-log') post('showLog');
  if (action === 'show-changes') post('showChanges');
  if (action === 'open-settings') post('openSettings');
  if ((action === 'fetch' || action === 'push') && !ui.busy && ui.syncPhase !== 'fetching') post(action);
  if (action === 'pull-menu' && !ui.busy && ui.syncPhase !== 'fetching') {
    ui.pullMenuOpen = !ui.pullMenuOpen;
    render();
    if (ui.pullMenuOpen) requestAnimationFrame(() => app.querySelector('[data-pull-strategy]:not(:disabled)')?.focus());
  }
  if (action === 'load-more-commits' && !ui.busy && !ui.graphLoadingMore) {
    ui.graphLoadingMore = true;
    render();
    post('loadMoreCommits');
  }
  if (action === 'clear-graph-filters') {
    ui.graphQuery = '';
    ui.graphPathFilter = '';
    ui.graphBranchFilter = '';
    ui.graphAuthorFilter = '';
    ui.graphAgeFilter = 'all';
    persist();
    render();
  }
  if (action === 'branches') {
    ui.branchOpen = !ui.branchOpen;
    if (!ui.branchOpen) ui.branchQuery = '';
    render();
    if (ui.branchOpen) setTimeout(() => app.querySelector('#branch-search')?.focus(), 30);
  }
  if (action === 'close-branches') { ui.branchOpen = false; ui.branchQuery = ''; render(); app.querySelector('[data-action="branches"]')?.focus(); }
  if (action === 'new-list') {
    post('createChangelist');
  }
  if (action === 'collapse-all') {
    for (const list of ui.snapshot?.changelists || []) ui.collapsed.add(list.id);
    persist();
    render();
  }
  if (action === 'expand-all') {
    ui.collapsed.clear();
    persist();
    render();
  }
  if (action === 'commit') commit();
  if (action === 'commit-and-push') commit(true);
  if (action === 'close-commit') {
    clearTimeout(commitDetailTimer);
    ui.selectedCommitHash = undefined;
    ui.focusedCommitHash = undefined;
    ui.commitDetails = undefined;
    ui.commitDetailsError = undefined;
    ui.commitDetailsLoading = false;
    ui.commitDetailsDismissed = true;
    persist();
    render();
  }
  if (action === 'retry-commit' && ui.selectedCommitHash) selectCommit(ui.selectedCommitHash);
}

function commit(andPush = false) {
  if (!ui.selected.size || !ui.commitMessage.trim() || ui.busy) {
    if (!ui.commitMessage.trim()) toast('Write a commit message first', 'error');
    return;
  }
  post(andPush ? 'commitAndPush' : 'commit', { message: ui.commitMessage, paths: [...ui.selected] });
}

function toast(message, phase = 'success') {
  const element = document.createElement('div');
  element.className = `toast ${phase}`;
  element.innerHTML = `${icon(phase === 'success' ? 'check' : phase === 'loading' ? 'loading' : 'error', phase === 'loading' ? 'codicon-modifier-spin' : '')}<p>${escapeHtml(message)}</p>`;
  toastRegion.append(element);
  if (phase !== 'loading') setTimeout(() => dismissToast(element), 2800);
  return element;
}

function dismissToast(element) {
  if (!element?.isConnected || element.classList.contains('leaving')) return;
  element.classList.add('leaving');
  element.addEventListener('animationend', () => element.remove(), { once: true });
  setTimeout(() => element.remove(), 240);
}

window.addEventListener('message', (event) => {
  const message = event.data;
  if (message.type === 'fileIconCss') {
    const style = document.querySelector('#kivo-file-icon-fonts');
    if (style) style.textContent = typeof message.css === 'string' ? message.css : '';
  }
  if (message.type === 'snapshot') {
    const fingerprint = JSON.stringify(message.payload);
    if (fingerprint === lastSnapshot) return;
    lastSnapshot = fingerprint;
    ui.emptyMessage = undefined;
    ui.snapshot = message.payload;
    ui.graphLoadingMore = false;
    if (ui.selectedCommitHash && !message.payload.commits.some((commit) => commit.hash === ui.selectedCommitHash)) {
      clearTimeout(commitDetailTimer);
      ui.selectedCommitHash = undefined;
      ui.focusedCommitHash = undefined;
      ui.commitDetails = undefined;
      ui.commitDetailsError = undefined;
      ui.commitDetailsLoading = false;
    }
    let autoSelectedCommit;
    if (surface === 'history' && !ui.selectedCommitHash && !ui.commitDetailsDismissed && message.payload.commits[0]) {
      autoSelectedCommit = message.payload.commits[0].hash;
      ui.selectedCommitHash = autoSelectedCommit;
      ui.focusedCommitHash = autoSelectedCommit;
      ui.commitDetails = undefined;
      ui.commitDetailsError = undefined;
      ui.commitDetailsLoading = true;
    }
    const valid = new Set(message.payload.changes.map((change) => change.path));
    ui.selected = new Set([...ui.selected].filter((path) => valid.has(path)));
    if (!valid.has(ui.focusedPath)) ui.focusedPath = message.payload.changes[0]?.path;
    persist();
    render();
    if (autoSelectedCommit) postCommitDetails(autoSelectedCommit);
    if (ui.branchMotion && message.payload.branch === ui.branchMotion.branch) {
      if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        const { x, y } = ui.branchMotion;
        app.querySelector('.branch-pill')?.animate([
          { transform: `translate(${x}px, ${y}px) scale(.96)`, opacity: .55 },
          { transform: 'translate(0, 0) scale(1)', opacity: 1 }
        ], { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)' });
      }
      ui.branchMotion = undefined;
    }
  }
  if (message.type === 'empty') { ui.snapshot = undefined; ui.emptyMessage = message.message; ui.graphLoadingMore = false; lastSnapshot = ''; render(); }
  if (message.type === 'operation') {
    if (message.id && message.id < ui.operationId) return;
    if (message.id) ui.operationId = message.id;
    document.querySelectorAll('.toast.loading').forEach((item) => dismissToast(item));
    ui.busy = message.phase === 'loading';
    ui.operationKind = message.phase === 'loading' ? message.kind : undefined;
    if (message.phase === 'loading') ui.pullMenuOpen = false;
    if (message.phase === 'success' && message.clearsCommit) { ui.commitMessage = ''; ui.selected.clear(); persist(); }
    toast(message.message, message.phase);
    render();
    if (message.phase === 'success' && message.clearsCommit) {
      const textarea = app.querySelector('#commit-message');
      if (textarea) textarea.value = '';
    }
    if (message.phase === 'error') ui.branchMotion = undefined;
  }
  if (message.type === 'syncStatus') {
    ui.syncPhase = message.phase;
    ui.lastFetchedAt = message.lastFetchedAt;
    ui.syncError = message.error;
    render();
  }
  if (message.type === 'commitDetails') {
    if (message.payload?.hash !== ui.selectedCommitHash) return;
    ui.commitDetails = message.payload;
    ui.commitDetailsError = undefined;
    ui.commitDetailsLoading = false;
    render();
  }
  if (message.type === 'commitDetailsError') {
    if (message.hash !== ui.selectedCommitHash) return;
    ui.commitDetails = undefined;
    ui.commitDetailsLoading = false;
    ui.commitDetailsError = message.message || 'Unable to load commit details.';
    render();
  }
  if (message.type === 'notice') toast(message.message, message.phase || 'error');
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (activeLogResize) {
    event.preventDefault();
    finishLogResize(false);
    return;
  }
  if (ui.branchContextMenu) {
    event.preventDefault();
    ui.branchContextMenu = undefined;
    render();
    return;
  }
  if (ui.pullMenuOpen) {
    event.preventDefault();
    ui.pullMenuOpen = false;
    render();
    app.querySelector('[data-action="pull-menu"]')?.focus();
    return;
  }
  if (ui.listMenuId) {
    event.preventDefault();
    const id = ui.listMenuId;
    ui.listMenuId = undefined;
    render();
    requestAnimationFrame(() => [...app.querySelectorAll('[data-list-menu]')].find((button) => button.dataset.listMenu === id)?.focus());
    return;
  }
  if (ui.selectedCommitHash && !ui.branchOpen) {
    event.preventDefault();
    clearTimeout(commitDetailTimer);
    ui.selectedCommitHash = undefined;
    ui.focusedCommitHash = undefined;
    ui.commitDetails = undefined;
    ui.commitDetailsError = undefined;
    ui.commitDetailsLoading = false;
    persist();
    render();
    return;
  }
  if (!ui.branchOpen) return;
  event.preventDefault();
  ui.branchOpen = false;
  ui.branchQuery = '';
  render();
  app.querySelector('[data-action="branches"]')?.focus();
});

document.addEventListener('click', (event) => {
  if (ui.branchContextMenu && !event.target.closest('[data-branch-context]')) {
    ui.branchContextMenu = undefined;
    render();
    return;
  }
  if (ui.pullMenuOpen && !event.target.closest('.sync-action-wrap')) {
    ui.pullMenuOpen = false;
    render();
    return;
  }
  if (!ui.listMenuId || event.target.closest('.list-menu, .list-more')) return;
  ui.listMenuId = undefined;
  render();
});

setInterval(() => {
  if (ui.snapshot && ui.lastFetchedAt && ui.syncPhase !== 'fetching') render();
}, 60000);

post('ready');
render();
