const vscode = acquireVsCodeApi();
const app = document.querySelector('#app');
const toastRegion = document.querySelector('#toast-region');
const persisted = vscode.getState?.() || {};

const ui = {
  snapshot: undefined,
  emptyMessage: undefined,
  tab: persisted.tab === 'log' || persisted.tab === 'graph' ? 'graph' : 'changes',
  selected: new Set(persisted.selected || []),
  collapsed: new Set(persisted.collapsed || []),
  branchOpen: false,
  branchQuery: '',
  busy: false,
  operationKind: undefined,
  operationId: 0,
  syncPhase: 'idle',
  lastFetchedAt: undefined,
  syncError: undefined,
  branchMotion: undefined,
  listMenuId: undefined,
  focusedPath: persisted.focusedPath,
  selectionAnchor: undefined,
  commitMessage: persisted.commitMessage || '',
  graphQuery: persisted.graphQuery || '',
  graphBranchFilter: persisted.graphBranchFilter || '',
  graphAuthorFilter: persisted.graphAuthorFilter || '',
  graphAgeFilter: persisted.graphAgeFilter || 'all',
  graphLoadingMore: false,
  pullMenuOpen: false,
  selectedCommitHash: persisted.selectedCommitHash,
  focusedCommitHash: persisted.focusedCommitHash || persisted.selectedCommitHash,
  commitDetails: undefined,
  commitDetailsLoading: false,
  commitDetailsError: undefined
};
let lastSnapshot = '';
let previewTimer;
let commitDetailTimer;
let dragAvatar;
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
    tab: ui.tab,
    selected: [...ui.selected],
    collapsed: [...ui.collapsed],
    focusedPath: ui.focusedPath,
    commitMessage: ui.commitMessage,
    graphQuery: ui.graphQuery,
    graphBranchFilter: ui.graphBranchFilter,
    graphAuthorFilter: ui.graphAuthorFilter,
    graphAgeFilter: ui.graphAgeFilter,
    selectedCommitHash: ui.selectedCommitHash,
    focusedCommitHash: ui.focusedCommitHash
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
    const branchMatches = !ui.graphBranchFilter || reachable?.has(commit.hash);
    const authorMatches = !ui.graphAuthorFilter || commit.author === ui.graphAuthorFilter;
    const ageMatches = !after || new Date(commit.date).getTime() >= after;
    return textMatches && branchMatches && authorMatches && ageMatches;
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
  const target = document.createElement('div');
  target.innerHTML = html;
  const pool = new Map([...app.querySelectorAll('[data-path], [data-list-id], [data-checkout], [data-hash]')].map((node) => [keyFor(node), node]));
  const before = new Map([...app.querySelectorAll('.file-row')].map((node) => [node.dataset.path, node.getBoundingClientRect()]));
  const counters = new Map([...app.querySelectorAll('.count, .sync-chip strong, .tool-tabs .tab span')].map((node) => [node, node.textContent]));
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
  const changeCount = s.changes.length;
  const hasUpstream = Boolean(s.upstream);
  const syncLabel = ui.syncPhase === 'fetching'
    ? 'Checking remote…'
    : ui.syncError
      ? 'Sync needs attention'
      : ui.lastFetchedAt
        ? updatedLabel(new Date(ui.lastFetchedAt).toISOString())
        : 'Remote not checked';
  patchApp(`
    <header class="tool-window-toolbar ${ui.syncError ? 'has-error' : ''}" aria-label="Git tool window controls" aria-busy="${ui.syncPhase === 'fetching'}">
      <span class="repository-context" title="${escapeHtml(s.root)}">${icon('repo')}<span>${escapeHtml(s.repositoryName)}</span></span>
      <button class="branch-pill" data-action="branches" aria-label="Git branches, current branch ${escapeHtml(s.branch)}" aria-haspopup="dialog" aria-expanded="${ui.branchOpen}">
        ${icon('git-branch', 'branch-symbol')}<span class="branch-name">${escapeHtml(s.branch)}</span>${icon('chevron-down', 'chevron')}
      </button>
      <span class="toolbar-divider" aria-hidden="true"></span>
      <span class="upstream" title="${escapeHtml(s.upstream || 'This branch has no upstream')}">${icon(hasUpstream ? 'cloud' : 'warning')}<span>${hasUpstream ? escapeHtml(s.upstream) : 'No upstream'}</span></span>
      <div class="toolbar-actions">
        <button class="icon-button fetch-button ${ui.syncPhase === 'fetching' || ui.operationKind === 'fetch' ? 'working' : ''}" aria-label="${ui.syncPhase === 'fetching' ? 'Checking remote' : 'Fetch remote updates'}" title="Fetch remote updates" data-action="fetch" ${ui.busy || ui.syncPhase === 'fetching' ? 'disabled' : ''}>${icon(ui.syncPhase === 'fetching' || ui.operationKind === 'fetch' ? 'loading' : 'refresh', ui.syncPhase === 'fetching' || ui.operationKind === 'fetch' ? 'codicon-modifier-spin' : '')}</button>
        <div class="sync-action-wrap">
          <button class="sync-chip incoming ${s.behind ? 'has-count' : ''} ${ui.operationKind === 'pull' ? 'working' : ''}" data-action="pull-menu" aria-haspopup="menu" aria-expanded="${ui.pullMenuOpen}" aria-label="${s.behind} commits available to pull" title="Choose how to pull ${s.behind} incoming commit${s.behind === 1 ? '' : 's'}" ${!hasUpstream || !s.behind || ui.busy || ui.syncPhase === 'fetching' ? 'disabled' : ''}>${icon('arrow-down')}<strong>${s.behind}</strong><span>Pull</span>${icon('chevron-down', 'sync-chevron')}</button>
          <div class="sync-menu ${ui.pullMenuOpen ? 'open' : ''}" role="menu" ${ui.pullMenuOpen ? '' : 'inert'}>
            <div class="sync-menu-title">Pull strategy</div>
            <button role="menuitem" data-pull-strategy="ff-only" ${ui.busy ? 'disabled' : ''}><strong>Fast-forward only</strong><small>Safest · refuse divergence</small></button>
            <button role="menuitem" data-pull-strategy="rebase" ${ui.busy ? 'disabled' : ''}><strong>Rebase</strong><small>Replay local commits on top</small></button>
            <button role="menuitem" data-pull-strategy="merge" ${ui.busy ? 'disabled' : ''}><strong>Merge</strong><small>Create a merge commit if needed</small></button>
          </div>
        </div>
        <button class="sync-chip outgoing ${s.ahead ? 'has-count' : ''} ${ui.operationKind === 'push' ? 'working' : ''}" data-action="push" aria-label="${s.ahead} commits ready to push" title="Push ${s.ahead} outgoing commit${s.ahead === 1 ? '' : 's'}" ${!hasUpstream || !s.ahead || ui.busy || ui.syncPhase === 'fetching' ? 'disabled' : ''}>${icon('arrow-up')}<strong>${s.ahead}</strong><span>Push</span></button>
      </div>
      <span class="toolbar-spacer"></span>
      <span class="sync-freshness" aria-live="polite" title="${escapeHtml(ui.syncError || syncLabel)}">${ui.syncError ? icon('warning') : kivoIcon('sync', 'sync-symbol')}${escapeHtml(syncLabel)}</span>
    </header>
    <nav class="tool-tabs" aria-label="Git tool window tabs" role="tablist">
      <button class="tab ${ui.tab === 'changes' ? 'active' : ''}" data-tab="changes" role="tab" aria-selected="${ui.tab === 'changes'}">Local Changes <span>${changeCount}</span></button>
      <button class="tab ${ui.tab === 'graph' ? 'active' : ''}" data-tab="graph" role="tab" aria-selected="${ui.tab === 'graph'}">Log</button>
    </nav>
    <section class="content" aria-busy="${ui.busy}">
      ${ui.tab === 'changes' ? renderChanges(s) : renderGraph(s)}
    </section>
    ${renderBranchPopup(s)}
  `);
  const textarea = app.querySelector('#commit-message');
  if (textarea && document.activeElement !== textarea && textarea.value !== ui.commitMessage) textarea.value = ui.commitMessage;
  const search = app.querySelector('#branch-search');
  if (search && (!ui.branchOpen || document.activeElement !== search) && search.value !== ui.branchQuery) search.value = ui.branchQuery;
  app.querySelectorAll('[data-select]').forEach((input) => { input.checked = ui.selected.has(input.dataset.select); });
  app.querySelectorAll('[data-select-list]').forEach((input) => {
    const list = s.changelists.find((candidate) => candidate.id === input.dataset.selectList);
    const selected = list?.changes.filter((change) => ui.selected.has(change.path)).length ?? 0;
    input.checked = Boolean(list?.changes.length && selected === list.changes.length);
    input.indeterminate = selected > 0 && selected < (list?.changes.length ?? 0);
  });
  bind();
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
        ${icon('chevron-down', 'disclosure')}<span class="active-dot" title="${list.active ? 'Active changelist' : ''}"></span><span class="list-name">${escapeHtml(list.name)}</span>${list.active ? '<span class="active-label">Active</span>' : ''}<span class="count">${list.changes.length}</span>
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
  return `
    <div class="section-toolbar"><span>LOCAL CHANGES</span><button class="text-button" data-action="new-list" ${ui.busy ? 'disabled' : ''}>${icon('add')} Changelist</button></div>
    <div class="lists">${lists}</div>
    <footer class="commit-panel">
      <textarea id="commit-message" rows="3" placeholder="Commit message…" spellcheck="true" ${ui.operationKind === 'commit' ? 'disabled' : ''}>${escapeHtml(ui.commitMessage)}</textarea>
      <div class="commit-meta"><span>${selectedCount || 'No'} file${selectedCount === 1 ? '' : 's'} selected</span><span class="shortcut">${commandKey} Enter</span></div>
      <button class="primary-button ${ui.operationKind === 'commit' ? 'working' : ''}" data-action="commit" ${!selectedCount || ui.busy ? 'disabled' : ''}>${ui.operationKind === 'commit' ? `${icon('loading', 'codicon-modifier-spin button-spinner')}<span class="button-label">Committing…</span>` : `<span class="button-label">Commit</span>${icon('chevron-down', 'button-arrow')}`}</button>
    </footer>`;
}

function renderFile(change) {
  const checked = ui.selected.has(change.path);
  const filename = change.path.split('/').pop();
  const parent = change.path.includes('/') ? change.path.slice(0, change.path.lastIndexOf('/')) : '';
  return `<div class="file-row ${checked ? 'selected' : ''} ${ui.focusedPath === change.path ? 'focused' : ''}" draggable="${!ui.busy}" data-path="${escapeHtml(change.path)}" title="${escapeHtml(change.path)}">
    <label class="check"><input type="checkbox" aria-label="Select ${escapeHtml(change.path)}" data-select="${escapeHtml(change.path)}" ${checked ? 'checked' : ''} ${ui.busy ? 'disabled' : ''}><span></span></label>
    <button class="file-main" data-diff="${escapeHtml(change.path)}" data-original-path="${escapeHtml(change.originalPath || '')}" data-kind="${escapeHtml(change.kind)}" tabindex="${ui.focusedPath === change.path ? '0' : '-1'}" aria-label="Preview diff for ${escapeHtml(change.path)}">
      <span class="file-name">${escapeHtml(filename)}</span>${parent ? `<span class="file-parent">${escapeHtml(parent)}</span>` : ''}
    </button>
    <span class="status ${change.kind}">${iconFor(change.kind)}</span>
  </div>`;
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
  const graphWidth = Math.max(80, laneCount * laneWidth + 26);
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

function renderCommitDetails(s) {
  if (!ui.selectedCommitHash) {
    return `<aside class="commit-detail commit-detail-empty" aria-label="Commit details"><div class="detail-empty-mark">${icon('git-commit')}</div><strong>Select a commit</strong><span>Review its message, refs, parents, and changed files here.</span></aside>`;
  }
  const commit = s.commits.find((item) => item.hash === ui.selectedCommitHash);
  if (!commit) return '';
  const details = ui.commitDetails?.hash === commit.hash ? ui.commitDetails : undefined;
  const files = details?.files || [];
  return `<aside class="commit-detail" aria-label="Commit details">
    <div class="commit-detail-head"><div><span class="detail-kicker">COMMIT DETAILS</span><strong>${escapeHtml(commit.subject)}</strong></div><button class="icon-button" data-action="close-commit" aria-label="Close commit details">${icon('close')}</button></div>
    <div class="commit-detail-meta"><span>${escapeHtml(commit.author)} · ${relativeTime(commit.date)}</span><code>${escapeHtml(commit.hash)}</code></div>
    <div class="commit-detail-refs">${commit.refs.map(renderRef).join('') || '<span class="detail-muted">No branch label</span>'}</div>
    ${ui.commitDetailsLoading && !details ? `<div class="detail-loading">${icon('loading', 'codicon-modifier-spin')} Loading changed files…</div>` : ''}
    ${ui.commitDetailsError && !details ? `<div class="detail-error" role="alert">${icon('error')}<span>${escapeHtml(ui.commitDetailsError)}</span><button class="text-button" data-action="retry-commit">Retry</button></div>` : ''}
    ${details?.body && details.body !== details.subject ? `<p class="commit-body">${escapeHtml(details.body)}</p>` : ''}
    ${details?.parents?.length ? `<div class="detail-parents"><span>Parents</span>${details.parents.map((parent) => `<code>${escapeHtml(parent.slice(0, 8))}</code>`).join('')}</div>` : ''}
    ${details ? `<div class="commit-files"><span class="detail-kicker">CHANGED FILES <b>${details.files.length}</b></span>${files.length ? files.map((file) => `<button class="commit-file" data-commit-file="${escapeHtml(file.path)}" data-commit-kind="${escapeHtml(file.status)}" data-commit-original="${escapeHtml(file.originalPath || '')}" title="Open diff for ${escapeHtml(file.path)}"><span class="status ${file.status === 'D' ? 'deleted' : file.status === 'A' ? 'added' : 'modified'}">${escapeHtml(file.status)}</span><span>${escapeHtml(file.path)}</span>${icon('diff')}</button>`).join('') : '<span class="detail-muted">No file changes reported</span>'}</div>` : ''}
  </aside>`;
}

function renderLogBranchPane(s) {
  const groups = [
    { label: 'LOCAL', branches: s.branches.filter((branch) => !branch.remote) },
    { label: 'REMOTE', branches: s.branches.filter((branch) => branch.remote) }
  ].filter((group) => group.branches.length);
  const row = (branch) => `<button class="log-branch-row ${branch.current ? 'current' : ''} ${ui.graphBranchFilter === branch.name ? 'selected' : ''}" data-log-branch="${escapeHtml(branch.name)}" aria-pressed="${ui.graphBranchFilter === branch.name}" title="Show ${escapeHtml(branch.name)} history">
    ${icon(branch.remote ? 'cloud' : 'git-branch')}<span>${escapeHtml(branch.name)}</span>${branch.current ? '<small>HEAD</small>' : ''}
  </button>`;
  return `<aside class="log-branch-pane" aria-label="Log branches">
    <div class="log-branch-heading"><span>Branches</span><span>${s.branches.length}</span></div>
    <button class="log-branch-row all ${!ui.graphBranchFilter ? 'selected' : ''}" data-log-branch="" aria-pressed="${!ui.graphBranchFilter}">${icon('list-flat')}<span>All branches</span></button>
    ${groups.map((group) => `<section class="log-branch-group"><h3>${group.label}</h3>${group.branches.map(row).join('')}</section>`).join('')}
  </aside>`;
}

function renderGraph(s) {
  if (!s.commits.length) return '<div class="inline-empty">No commits yet</div>';
  const commits = graphCommits();
  const laneCount = Math.max(1, Math.max(...s.commits.flatMap((commit) => [commit.lane, ...(commit.incomingLanes || []), ...(commit.parentLanes || [])])) + 1);
  const graphWidth = Math.max(80, laneCount * 18 + 26);
  const focusHash = ui.focusedCommitHash && commits.some((commit) => commit.hash === ui.focusedCommitHash)
    ? ui.focusedCommitHash
    : commits[0]?.hash;
  const branchOptions = [...new Set(s.branches.map((branch) => branch.name))].sort((a, b) => a.localeCompare(b));
  const authorOptions = [...new Set(s.commits.map((commit) => commit.author))].sort((a, b) => a.localeCompare(b));
  const filtersActive = Boolean(ui.graphBranchFilter || ui.graphAuthorFilter || ui.graphAgeFilter !== 'all' || ui.graphQuery.trim());
  const countLabel = filtersActive ? `${commits.length} of ${s.commits.length}` : `${s.commits.length}`;
  return `<div class="graph-view log-view" role="tabpanel" aria-label="Git Log">
    <div class="log-filter-bar"><div class="graph-toolbar-head"><span class="log-result-count">${countLabel} commits</span>
      <div class="graph-filters" aria-label="History filters">
        <label class="graph-filter"><span>Branch</span><select data-graph-filter="branch" aria-label="Filter by branch"><option value="">All branches</option>${branchOptions.map((branch) => `<option value="${escapeHtml(branch)}" ${ui.graphBranchFilter === branch ? 'selected' : ''}>${escapeHtml(branch)}</option>`).join('')}</select></label>
        <label class="graph-filter"><span>User</span><select data-graph-filter="author" aria-label="Filter by author"><option value="">All users</option>${authorOptions.map((author) => `<option value="${escapeHtml(author)}" ${ui.graphAuthorFilter === author ? 'selected' : ''}>${escapeHtml(author)}</option>`).join('')}</select></label>
        <label class="graph-filter"><span>Date</span><select data-graph-filter="age" aria-label="Filter by date"><option value="all" ${ui.graphAgeFilter === 'all' ? 'selected' : ''}>All time</option><option value="7d" ${ui.graphAgeFilter === '7d' ? 'selected' : ''}>Last 7 days</option><option value="30d" ${ui.graphAgeFilter === '30d' ? 'selected' : ''}>Last 30 days</option><option value="90d" ${ui.graphAgeFilter === '90d' ? 'selected' : ''}>Last 90 days</option></select></label>
        ${filtersActive ? '<button class="text-button graph-clear" data-action="clear-graph-filters">Clear</button>' : ''}
      </div><label class="graph-search">${icon('search')}<input id="graph-search" aria-label="Search Log" placeholder="Search commits" value="${escapeHtml(ui.graphQuery)}"></label>
    </div></div>
    <div class="log-workspace">
      ${renderLogBranchPane(s)}
      <section class="log-history-pane" aria-label="Commit history">
        <div class="log-column-header" aria-hidden="true" style="--graph-width:${graphWidth}px"><span>GRAPH</span><span>COMMIT</span><span>AUTHOR</span><span>DATE</span></div>
        <div class="graph-list" role="listbox" aria-label="Commit history" style="--lane-count:${laneCount};--graph-width:${graphWidth}px">${commits.length ? commits.map((commit, index) => `<article class="graph-row ${commit.parents.length > 1 ? 'merge-row' : ''} ${ui.selectedCommitHash === commit.hash ? 'selected' : ''}" data-commit="${escapeHtml(commit.hash)}" data-hash="${escapeHtml(commit.hash)}" role="option" aria-selected="${ui.selectedCommitHash === commit.hash}" tabindex="${focusHash === commit.hash ? '0' : '-1'}" style="--delay:${Math.min(index * 5, 90)}ms">
          <div class="graph-canvas">${renderGraphSvg(commit, laneCount)}</div><div class="graph-commit"><div class="log-subject"><strong>${escapeHtml(commit.subject)}</strong>${(commit.refs || []).slice(0, 3).map(renderRef).join('')}</div><span class="log-meta"><code>${escapeHtml(commit.shortHash)}</code>${commit.parents?.length > 1 ? '<span class="merge-note">Merge</span>' : ''}</span></div><span class="log-author" title="${escapeHtml(commit.author)}">${escapeHtml(commit.author)}</span><time class="log-date" title="${escapeHtml(commit.date)}">${relativeTime(commit.date)}</time>
        </article>`).join('') : '<div class="inline-empty">No matching commits</div>'}</div>
        ${s.commitsHasMore ? `<button class="load-more ${ui.graphLoadingMore ? 'working' : ''}" data-action="load-more-commits" ${ui.busy || ui.graphLoadingMore ? 'disabled' : ''}>${ui.graphLoadingMore ? icon('loading', 'codicon-modifier-spin') : icon('history')}<span>${ui.graphLoadingMore ? 'Loading history…' : 'Load more history'}</span><small>Showing ${s.commits.length}</small></button>` : ''}
      </section>
      ${renderCommitDetails(s)}
    </div>
  </div>`;
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
  once('[data-tab]', 'click', (event) => { ui.tab = event.currentTarget.dataset.tab; persist(); render(); });
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
    setSelection(input.dataset.select, input.checked, event.shiftKey);
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
  if (action === 'commit') commit();
  if (action === 'close-commit') {
    clearTimeout(commitDetailTimer);
    ui.selectedCommitHash = undefined;
    ui.focusedCommitHash = undefined;
    ui.commitDetails = undefined;
    ui.commitDetailsError = undefined;
    ui.commitDetailsLoading = false;
    persist();
    render();
  }
  if (action === 'retry-commit' && ui.selectedCommitHash) selectCommit(ui.selectedCommitHash);
}

function commit() {
  if (!ui.selected.size || !ui.commitMessage.trim() || ui.busy) {
    if (!ui.commitMessage.trim()) toast('Write a commit message first', 'error');
    return;
  }
  post('commit', { message: ui.commitMessage, paths: [...ui.selected] });
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
  if (message.type === 'showTab') {
    ui.tab = message.tab === 'log' ? 'graph' : 'changes';
    persist();
    render();
    return;
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
    const valid = new Set(message.payload.changes.map((change) => change.path));
    ui.selected = new Set([...ui.selected].filter((path) => valid.has(path)));
    if (!valid.has(ui.focusedPath)) ui.focusedPath = message.payload.changes[0]?.path;
    persist();
    render();
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
