const vscode = acquireVsCodeApi();
const app = document.querySelector('#app');
const toastRegion = document.querySelector('#toast-region');
const persisted = vscode.getState?.() || {};
const repositoryStates = persisted.repositoryStates && typeof persisted.repositoryStates === 'object'
  ? { ...persisted.repositoryStates }
  : {};
const legacyRepositoryState = persisted.repositoryStates ? undefined : persisted;
const initialRepositoryState = persisted.activeRoot && repositoryStates[persisted.activeRoot]
  ? repositoryStates[persisted.activeRoot]
  : legacyRepositoryState || {};
const surface = document.body.dataset.surface === 'history' ? 'history' : 'changes';
const LOG_BRANCH_MIN_WIDTH = 156;
const LOG_BRANCH_MAX_WIDTH = 420;
const LOG_BRANCH_DEFAULT_WIDTH = 240;
const LOG_DETAIL_MIN_WIDTH = 220;
const LOG_DETAIL_MAX_WIDTH = 520;
const LOG_DETAIL_DEFAULT_WIDTH = 306;
const LOG_DETAIL_MIN_HEIGHT = 112;
const LOG_DETAIL_DEFAULT_HEIGHT = 190;
const COMMIT_METADATA_MIN_HEIGHT = 96;
const COMMIT_METADATA_DEFAULT_HEIGHT = 180;
const COMMIT_PANEL_MIN_HEIGHT = 124;
const COMMIT_PANEL_MAX_HEIGHT = 220;
const COMMIT_PANEL_LEGACY_DEFAULT_HEIGHT = 188;
const COMMIT_PANEL_DEFAULT_HEIGHT = 144;
const COMMIT_ZONE_DEFAULT_PERCENT = window.innerHeight < 720 ? 47 : 40;
const BRANCH_PAGE_SIZE = 36;
const GRAPH_MAX_WIDTH = 176;
const GRAPH_MIN_WIDTH = 64;
const GRAPH_ROW_HEIGHT = 30;
const GRAPH_LOAD_THRESHOLD = 180;
const GRAPH_VIRTUAL_OVERSCAN = 12;
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const restoredBranchWidth = Number(initialRepositoryState.logBranchWidth);
const restoredDetailWidth = Number(initialRepositoryState.logDetailWidth);
const restoredDetailHeight = Number(initialRepositoryState.logDetailHeight);
const restoredCommitMetadataHeight = Number(initialRepositoryState.commitMetadataHeight);
const restoredCommitPanelHeight = Number(initialRepositoryState.commitPanelHeight);

const ui = {
  snapshot: undefined,
  emptyMessage: undefined,
  selected: new Set(initialRepositoryState.selected || []),
  collapsed: new Set(initialRepositoryState.collapsed || []),
  branchOpen: false,
  branchQuery: '',
  changeQuery: initialRepositoryState.changeQuery || '',
  changeKindFilter: initialRepositoryState.changeKindFilter || 'all',
  changeSearchOpen: false,
  logBranchQuery: initialRepositoryState.logBranchQuery || '',
  logBranchWidth: Number.isFinite(restoredBranchWidth)
    ? clamp(restoredBranchWidth, LOG_BRANCH_MIN_WIDTH, LOG_BRANCH_MAX_WIDTH)
    : LOG_BRANCH_DEFAULT_WIDTH,
  logDetailWidth: Number.isFinite(restoredDetailWidth)
    ? clamp(restoredDetailWidth, LOG_DETAIL_MIN_WIDTH, LOG_DETAIL_MAX_WIDTH)
    : LOG_DETAIL_DEFAULT_WIDTH,
  logDetailHeight: Number.isFinite(restoredDetailHeight)
    ? Math.max(LOG_DETAIL_MIN_HEIGHT, restoredDetailHeight)
    : LOG_DETAIL_DEFAULT_HEIGHT,
  commitMetadataHeight: Number.isFinite(restoredCommitMetadataHeight)
    ? Math.max(COMMIT_METADATA_MIN_HEIGHT, restoredCommitMetadataHeight)
    : COMMIT_METADATA_DEFAULT_HEIGHT,
  commitPanelHeight: Number.isFinite(restoredCommitPanelHeight)
    ? clamp(restoredCommitPanelHeight === COMMIT_PANEL_LEGACY_DEFAULT_HEIGHT ? COMMIT_PANEL_DEFAULT_HEIGHT : restoredCommitPanelHeight, COMMIT_PANEL_MIN_HEIGHT, COMMIT_PANEL_MAX_HEIGHT)
    : COMMIT_PANEL_DEFAULT_HEIGHT,
  commitZonePercent: clamp(Number(initialRepositoryState.commitZonePercent) || COMMIT_ZONE_DEFAULT_PERCENT, 35, 75),
  branchGroupsExpanded: {
    local: initialRepositoryState.branchGroupsExpanded?.local !== false,
    remote: initialRepositoryState.branchGroupsExpanded?.remote !== false,
    tags: initialRepositoryState.branchGroupsExpanded?.tags === true
  },
  collapsedLogBranchFolders: new Set(initialRepositoryState.collapsedLogBranchFolders || []),
  branchVisibleCounts: { local: BRANCH_PAGE_SIZE, remote: BRANCH_PAGE_SIZE, tags: BRANCH_PAGE_SIZE },
  branchPopupVisibleCounts: { local: BRANCH_PAGE_SIZE, remote: BRANCH_PAGE_SIZE },
  busy: false,
  operationKind: undefined,
  operationId: 0,
  syncPhase: 'idle',
  lastFetchedAt: undefined,
  syncError: undefined,
  branchMotion: undefined,
  branchContextMenu: undefined,
  commitContextMenu: undefined,
  fileContextMenu: undefined,
  listMenuId: undefined,
  focusedPath: initialRepositoryState.focusedPath,
  selectionAnchor: undefined,
  commitMessage: initialRepositoryState.commitMessage || '',
  graphQuery: initialRepositoryState.graphQuery || '',
  graphPathFilter: initialRepositoryState.graphPathFilter || '',
  graphBranchFilter: initialRepositoryState.graphBranchFilter || '',
  graphAuthorFilter: initialRepositoryState.graphAuthorFilter || '',
  graphAgeFilter: initialRepositoryState.graphAgeFilter || 'all',
  graphLoadingMore: false,
  historyRefLoading: false,
  graphViewportWidth: 0,
  graphViewportHeight: 0,
  graphScrollTop: Number(initialRepositoryState.graphScrollTop) || 0,
  pullMenuOpen: false,
  selectedCommitHash: initialRepositoryState.selectedCommitHash,
  focusedCommitHash: initialRepositoryState.focusedCommitHash || initialRepositoryState.selectedCommitHash,
  commitDetailsDismissed: initialRepositoryState.commitDetailsDismissed || false,
  commitDetails: undefined,
  commitDetailsLoading: false,
  commitDetailsError: undefined
};
let lastSnapshot = '';
let previewTimer;
let commitDetailTimer;
let dragAvatar;
let activeLogResize;
let activeLogDetailResize;
let activeCommitDetailResize;
let activeCommitPanelResize;
let activeCommitZoneResize;
let graphResizeObserver;
let observedGraphList;
let graphViewportFrame;
let graphScrollFrame;
const commandKey = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

const escapeHtml = (value = '') => String(value)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#039;');

const iconFor = (kind) => ({ modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: '?', conflict: '!' })[kind] || 'M';
const describeFileState = (status) => ({ '.': 'unchanged', M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', U: 'conflicted', '?': 'untracked' })[status] || 'changed';
function fileStateLabel(change) {
  if (change.kind === 'untracked') return '??';
  return `${change.indexStatus === '.' ? '·' : change.indexStatus}${change.workingTreeStatus === '.' ? '·' : change.workingTreeStatus}`;
}
function fileStateTitle(change) {
  if (change.kind === 'untracked') return 'Untracked; not staged in the index';
  return `Index: ${describeFileState(change.indexStatus)} · Working tree: ${describeFileState(change.workingTreeStatus)}`;
}
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
function serializeRepositoryState() {
  return {
    selected: [...ui.selected],
    collapsed: [...ui.collapsed],
    focusedPath: ui.focusedPath,
    changeQuery: ui.changeQuery,
    changeKindFilter: ui.changeKindFilter,
    changeSearchOpen: ui.changeSearchOpen,
    commitMessage: ui.commitMessage,
    graphQuery: ui.graphQuery,
    graphPathFilter: ui.graphPathFilter,
    graphBranchFilter: ui.graphBranchFilter,
    graphAuthorFilter: ui.graphAuthorFilter,
    graphAgeFilter: ui.graphAgeFilter,
    logBranchQuery: ui.logBranchQuery,
    logBranchWidth: ui.logBranchWidth,
    logDetailWidth: ui.logDetailWidth,
    logDetailHeight: ui.logDetailHeight,
    commitMetadataHeight: ui.commitMetadataHeight,
    commitPanelHeight: ui.commitPanelHeight,
    commitZonePercent: ui.commitZonePercent,
    branchGroupsExpanded: ui.branchGroupsExpanded,
    collapsedLogBranchFolders: [...ui.collapsedLogBranchFolders],
    graphScrollTop: ui.graphScrollTop,
    selectedCommitHash: ui.selectedCommitHash,
    focusedCommitHash: ui.focusedCommitHash,
    commitDetailsDismissed: ui.commitDetailsDismissed
  };
}

function saveRepositoryState(root = ui.snapshot?.root) {
  if (!root) return;
  repositoryStates[root] = serializeRepositoryState();
}

function persist() {
  const root = ui.snapshot?.root || persisted.activeRoot;
  saveRepositoryState(root);
  vscode.setState?.({ activeRoot: root, repositoryStates });
}

function restoreRepositoryState(root, state = {}) {
  const branchWidth = Number(state.logBranchWidth);
  const detailWidth = Number(state.logDetailWidth);
  const detailHeight = Number(state.logDetailHeight);
  const metadataHeight = Number(state.commitMetadataHeight);
  const panelHeight = Number(state.commitPanelHeight);
  ui.selected = new Set(state.selected || []);
  ui.collapsed = new Set(state.collapsed || []);
  ui.focusedPath = state.focusedPath;
  ui.changeQuery = state.changeQuery || '';
  ui.changeKindFilter = ['all', 'modified', 'added', 'deleted', 'renamed', 'untracked', 'conflict'].includes(state.changeKindFilter)
    ? state.changeKindFilter
    : 'all';
  ui.changeSearchOpen = state.changeSearchOpen === true;
  ui.selectionAnchor = undefined;
  ui.commitMessage = state.commitMessage || '';
  ui.graphQuery = state.graphQuery || '';
  ui.graphPathFilter = state.graphPathFilter || '';
  ui.graphBranchFilter = state.graphBranchFilter || '';
  ui.graphAuthorFilter = state.graphAuthorFilter || '';
  ui.graphAgeFilter = state.graphAgeFilter || 'all';
  ui.logBranchQuery = state.logBranchQuery || '';
  ui.logBranchWidth = Number.isFinite(branchWidth) ? clamp(branchWidth, LOG_BRANCH_MIN_WIDTH, LOG_BRANCH_MAX_WIDTH) : LOG_BRANCH_DEFAULT_WIDTH;
  ui.logDetailWidth = Number.isFinite(detailWidth) ? clamp(detailWidth, LOG_DETAIL_MIN_WIDTH, LOG_DETAIL_MAX_WIDTH) : LOG_DETAIL_DEFAULT_WIDTH;
  ui.logDetailHeight = Number.isFinite(detailHeight) ? Math.max(LOG_DETAIL_MIN_HEIGHT, detailHeight) : LOG_DETAIL_DEFAULT_HEIGHT;
  ui.commitMetadataHeight = Number.isFinite(metadataHeight) ? Math.max(COMMIT_METADATA_MIN_HEIGHT, metadataHeight) : COMMIT_METADATA_DEFAULT_HEIGHT;
  ui.commitPanelHeight = Number.isFinite(panelHeight)
    ? clamp(panelHeight === COMMIT_PANEL_LEGACY_DEFAULT_HEIGHT ? COMMIT_PANEL_DEFAULT_HEIGHT : panelHeight, COMMIT_PANEL_MIN_HEIGHT, COMMIT_PANEL_MAX_HEIGHT)
    : COMMIT_PANEL_DEFAULT_HEIGHT;
  ui.commitZonePercent = clamp(Number(state.commitZonePercent) || COMMIT_ZONE_DEFAULT_PERCENT, 35, 75);
  ui.branchGroupsExpanded = {
    local: state.branchGroupsExpanded?.local !== false,
    remote: state.branchGroupsExpanded?.remote !== false,
    tags: state.branchGroupsExpanded?.tags === true
  };
  ui.collapsedLogBranchFolders = new Set(state.collapsedLogBranchFolders || []);
  ui.branchVisibleCounts = { local: BRANCH_PAGE_SIZE, remote: BRANCH_PAGE_SIZE, tags: BRANCH_PAGE_SIZE };
  ui.branchPopupVisibleCounts = { local: BRANCH_PAGE_SIZE, remote: BRANCH_PAGE_SIZE };
  ui.graphScrollTop = Number(state.graphScrollTop) || 0;
  ui.graphViewportWidth = 0;
  ui.graphViewportHeight = 0;
  ui.historyRefLoading = false;
  ui.selectedCommitHash = state.selectedCommitHash;
  ui.focusedCommitHash = state.focusedCommitHash || state.selectedCommitHash;
  ui.commitDetailsDismissed = state.commitDetailsDismissed || false;
  ui.commitDetails = undefined;
  ui.commitDetailsLoading = false;
  ui.commitDetailsError = undefined;
  ui.branchOpen = false;
  ui.branchQuery = '';
  ui.branchContextMenu = undefined;
  ui.commitContextMenu = undefined;
  ui.fileContextMenu = undefined;
  ui.listMenuId = undefined;
  ui.pullMenuOpen = false;
  repositoryStates[root] = serializeRepositoryState();
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

function reconcileHistorySelection() {
  if (surface !== 'history' || !ui.snapshot || ui.historyRefLoading) return;
  const commits = graphCommits();
  if (commits.some((commit) => commit.hash === ui.selectedCommitHash)) {
    if (!ui.commitDetails && !ui.commitDetailsLoading && !ui.commitDetailsError && !ui.commitDetailsDismissed) {
      ui.commitDetailsLoading = true;
      postCommitDetails(ui.selectedCommitHash, false);
    }
    return;
  }
  clearTimeout(commitDetailTimer);
  ui.selectedCommitHash = undefined;
  ui.focusedCommitHash = undefined;
  ui.commitDetails = undefined;
  ui.commitDetailsError = undefined;
  ui.commitDetailsLoading = false;
  if (!ui.commitDetailsDismissed && commits[0]) {
    ui.selectedCommitHash = commits[0].hash;
    ui.focusedCommitHash = commits[0].hash;
    ui.commitDetailsLoading = true;
    postCommitDetails(commits[0].hash, false);
  }
}

function setHistoryRef(branch) {
  if (ui.graphBranchFilter === branch) return;
  ui.graphBranchFilter = branch;
  ui.graphScrollTop = 0;
  ui.historyRefLoading = true;
  clearTimeout(commitDetailTimer);
  ui.selectedCommitHash = undefined;
  ui.focusedCommitHash = undefined;
  ui.commitDetails = undefined;
  ui.commitDetailsLoading = false;
  persist();
  render();
  post('setHistoryRef', { branch });
}

function graphWidthBudget() {
  if (!ui.graphViewportWidth) return GRAPH_MAX_WIDTH;
  const compact = window.matchMedia('(max-width: 620px)').matches;
  const narrow = window.matchMedia('(max-width: 1180px)').matches;
  const authorWidth = compact ? 0 : narrow ? 80 : 108;
  const dateWidth = compact ? 80 : narrow ? 106 : 142;
  const commitMinimum = compact ? 132 : narrow ? 180 : 240;
  return clamp(ui.graphViewportWidth - authorWidth - dateWidth - commitMinimum - 8, GRAPH_MIN_WIDTH, GRAPH_MAX_WIDTH);
}

function graphLayoutFor(commits) {
  const layout = globalThis.KivoGraphLayout?.layout;
  if (typeof layout === 'function') return layout(commits, { maximumWidth: graphWidthBudget() });
  const lanes = commits.flatMap((commit) => [commit.lane, ...(commit.incomingLanes || []), ...(commit.parentLanes || [])]);
  const laneCount = lanes.length ? Math.max(1, Math.max(...lanes) + 1) : 1;
  const graphWidth = Math.min(GRAPH_MAX_WIDTH, Math.max(GRAPH_MIN_WIDTH, laneCount * 16 + 20));
  return { laneCount, laneWidth: 16, graphWidth, nodeRadius: 3.6, mergeNodeRadius: 4.5, compressed: graphWidth < laneCount * 16 + 20 };
}

function graphRenderWindow(commits) {
  const visibleRange = globalThis.KivoGraphLayout?.visibleRange;
  const options = {
    scrollTop: ui.graphScrollTop,
    viewportHeight: ui.graphViewportHeight || GRAPH_ROW_HEIGHT * 18,
    rowHeight: GRAPH_ROW_HEIGHT,
    overscan: GRAPH_VIRTUAL_OVERSCAN
  };
  if (typeof visibleRange === 'function') return visibleRange(commits.length, options);
  const firstVisible = Math.floor(Math.max(0, options.scrollTop) / GRAPH_ROW_HEIGHT);
  const visibleRows = Math.max(1, Math.ceil(options.viewportHeight / GRAPH_ROW_HEIGHT));
  const start = Math.max(0, firstVisible - GRAPH_VIRTUAL_OVERSCAN);
  const end = Math.min(commits.length, firstVisible + visibleRows + GRAPH_VIRTUAL_OVERSCAN);
  return {
    start,
    end,
    topSpacer: start * GRAPH_ROW_HEIGHT,
    bottomSpacer: Math.max(0, commits.length - end) * GRAPH_ROW_HEIGHT,
    totalHeight: commits.length * GRAPH_ROW_HEIGHT
  };
}

function restoreGraphScroll(scrollTop) {
  if (!Number.isFinite(scrollTop)) return;
  requestAnimationFrame(() => {
    const list = app.querySelector('[data-graph-list]');
    if (list) list.scrollTop = scrollTop;
  });
}

function requestMoreHistory(scrollTop) {
  if (!ui.snapshot?.commitsHasMore || ui.graphLoadingMore || ui.historyRefLoading || ui.busy) return false;
  ui.graphLoadingMore = true;
  render();
  restoreGraphScroll(scrollTop);
  post('loadMoreCommits');
  return true;
}

function requestOlderHistoryForHash() {
  const hashPrefix = ui.graphQuery.trim().toLowerCase();
  if (surface !== 'history' || !/^[0-9a-f]{7,40}$/.test(hashPrefix)) return false;
  const snapshot = ui.snapshot;
  if (!snapshot?.commitsHasMore || snapshot.commits.some((commit) => commit.hash.toLowerCase().startsWith(hashPrefix))) return false;
  return requestMoreHistory(ui.graphScrollTop);
}

function syncGraphViewport(list) {
  if (!list?.isConnected) return;
  const nextWidth = Math.round(list.clientWidth);
  const nextHeight = Math.round(list.clientHeight);
  if (!nextWidth || !nextHeight) return;
  const widthChanged = Math.abs(nextWidth - ui.graphViewportWidth) >= 4;
  const heightChanged = Math.abs(nextHeight - ui.graphViewportHeight) >= GRAPH_ROW_HEIGHT;
  if (!widthChanged && !heightChanged) return;
  const scrollTop = list.scrollTop;
  ui.graphViewportWidth = nextWidth;
  ui.graphViewportHeight = nextHeight;
  ui.graphScrollTop = scrollTop;
  render();
  restoreGraphScroll(scrollTop);
}

function scheduleGraphViewportWidth(list) {
  if (graphViewportFrame) cancelAnimationFrame(graphViewportFrame);
  graphViewportFrame = requestAnimationFrame(() => {
    graphViewportFrame = undefined;
    syncGraphViewport(list);
  });
}

function bindGraphViewport() {
  const list = app.querySelector('[data-graph-list]');
  if (!list) {
    graphResizeObserver?.disconnect();
    graphResizeObserver = undefined;
    observedGraphList = undefined;
    return;
  }
  if (typeof ResizeObserver !== 'undefined' && observedGraphList !== list) {
    graphResizeObserver?.disconnect();
    graphResizeObserver = new ResizeObserver(() => scheduleGraphViewportWidth(list));
    graphResizeObserver.observe(list);
    observedGraphList = list;
  }
  scheduleGraphViewportWidth(list);
}

function onGraphScroll(event) {
  const list = event.currentTarget;
  const scrollTop = list.scrollTop;
  if (Math.abs(scrollTop - ui.graphScrollTop) >= GRAPH_ROW_HEIGHT) {
    ui.graphScrollTop = scrollTop;
    if (!graphScrollFrame) {
      graphScrollFrame = requestAnimationFrame(() => {
        graphScrollFrame = undefined;
        if (!list.isConnected) return;
        const currentScrollTop = list.scrollTop;
        ui.graphScrollTop = currentScrollTop;
        render();
        restoreGraphScroll(currentScrollTop);
      });
    }
  }
  if (scrollTop + list.clientHeight >= list.scrollHeight - GRAPH_LOAD_THRESHOLD) requestMoreHistory(scrollTop);
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

function revealGraphCommit(hash) {
  if (surface !== 'history') return undefined;
  const commits = graphCommits();
  const index = commits.findIndex((commit) => commit.hash === hash);
  if (index < 0) return undefined;
  const list = app.querySelector('[data-graph-list]');
  const viewportHeight = list?.clientHeight || ui.graphViewportHeight || GRAPH_ROW_HEIGHT * 18;
  const currentTop = list?.scrollTop ?? ui.graphScrollTop;
  const rowTop = index * GRAPH_ROW_HEIGHT;
  const rowBottom = rowTop + GRAPH_ROW_HEIGHT;
  const viewportBottom = currentTop + viewportHeight;
  const maximum = Math.max(0, commits.length * GRAPH_ROW_HEIGHT - viewportHeight);
  const nextTop = rowTop < currentTop
    ? rowTop
    : rowBottom > viewportBottom
      ? rowBottom - viewportHeight
      : currentTop;
  ui.graphScrollTop = clamp(nextTop, 0, maximum);
  return ui.graphScrollTop;
}

function selectCommit(hash, { focus = false, immediate = true } = {}) {
  if (!hash) return;
  const revealScrollTop = focus ? revealGraphCommit(hash) : undefined;
  ui.selectedCommitHash = hash;
  ui.focusedCommitHash = hash;
  ui.commitDetails = undefined;
  ui.commitDetailsError = undefined;
  ui.commitDetailsLoading = true;
  ui.commitDetailsDismissed = false;
  persist();
  render();
  if (focus) requestAnimationFrame(() => {
    restoreGraphScroll(revealScrollTop);
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
    ${surface === 'changes' && ui.branchOpen ? renderBranchPopup(s) : ''}
    ${surface === 'changes' ? renderBranchContextMenu() : ''}
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
  const branchLabel = s.branch === '(detached)' ? 'Detached HEAD' : s.branch;
  const branchActionLabel = s.branch === '(detached)' ? 'Git branches, detached HEAD' : `Git branches, current branch ${s.branch}`;
  const fetchIcon = syncing || ui.operationKind === 'fetch' ? 'loading' : 'refresh';
  const hasUpstream = Boolean(s.upstream);
  const pullTitle = s.behind ? `Pull ${s.behind} incoming commit${s.behind === 1 ? '' : 's'}` : 'No incoming commits';
  const pushTitle = s.ahead ? `Push ${s.ahead} outgoing commit${s.ahead === 1 ? '' : 's'}` : 'No commits to push';
  return `<header class="commit-toolbar" aria-label="Commit tool window actions" aria-busy="${syncing}">
    <button class="idea-toolbar-button" data-action="refresh" aria-label="Refresh changes" title="Refresh changes" ${ui.busy ? 'disabled' : ''}>${icon('refresh')}</button>
    <span class="idea-toolbar-divider" aria-hidden="true"></span>
    <button class="idea-toolbar-button" data-action="show-log" aria-label="Open Kivo Git History in the bottom panel" title="Open Kivo Git History">${kivoIcon('graph', 'kivo-toolbar-mark')}</button>
    <button class="idea-toolbar-button" data-action="branches" aria-label="${escapeHtml(branchActionLabel)}" title="Branches: ${escapeHtml(branchLabel)}" aria-haspopup="dialog" aria-expanded="${ui.branchOpen}">${icon('git-branch')}</button>
    <button class="idea-toolbar-button ${syncing ? 'working' : ''}" data-action="fetch" aria-label="${syncing ? 'Checking remote' : 'Fetch remote updates'}" title="${syncing ? 'Checking remote' : 'Fetch remote updates'}" ${ui.busy || syncing ? 'disabled' : ''}>${icon(fetchIcon, syncing || ui.operationKind === 'fetch' ? 'codicon-modifier-spin' : '')}</button>
    <div class="sync-action-wrap compact-sync-action">
    <button class="idea-toolbar-button ${s.behind ? 'has-count incoming-count' : ''}" data-action="pull-menu" aria-label="${escapeHtml(pullTitle)}" title="${escapeHtml(pullTitle)}" aria-haspopup="menu" aria-expanded="${ui.pullMenuOpen}" ${!hasUpstream || !s.behind || ui.busy || syncing ? 'disabled' : ''}>${icon('arrow-down')}${s.behind ? `<span class="tool-count">${s.behind}</span>` : ''}</button>
      ${renderPullMenu()}
    </div>
    <button class="idea-toolbar-button ${s.ahead ? 'has-count outgoing-count' : ''}" data-action="push" aria-label="${escapeHtml(pushTitle)}" title="${escapeHtml(pushTitle)}" ${!hasUpstream || !s.ahead || ui.busy || syncing ? 'disabled' : ''}>${icon('arrow-up')}${s.ahead ? `<span class="tool-count">${s.ahead}</span>` : ''}</button>
    <span class="toolbar-spacer"></span>
    <button class="idea-toolbar-button" data-action="search-changes" aria-label="${ui.changeSearchOpen ? 'Close changed-file search' : 'Search changed files'}" title="${ui.changeSearchOpen ? 'Close changed-file search' : 'Search changed files'}" aria-expanded="${ui.changeSearchOpen}">${icon(ui.changeSearchOpen ? 'close' : 'search')}</button>
    <button class="idea-toolbar-button" data-action="new-list" aria-label="Create changelist" title="Create changelist" ${ui.busy ? 'disabled' : ''}>${icon('add')}</button>
    <button class="idea-toolbar-button" data-action="collapse-all" aria-label="Collapse all changelists" title="Collapse all">${icon('chevron-up')}</button>
    <button class="idea-toolbar-button" data-action="expand-all" aria-label="Expand all changelists" title="Expand all">${icon('chevron-down')}</button>
  </header>`;
}

function renderChanges(s) {
  const query = ui.changeQuery.trim().toLowerCase();
  const filtersActive = Boolean(query || ui.changeKindFilter !== 'all');
  const changesByList = new Map(s.changelists.map((list) => [list.id, list.changes.filter((change) =>
    (ui.changeKindFilter === 'all' || change.kind === ui.changeKindFilter)
      && (!query || `${change.path} ${change.kind} ${change.indexStatus} ${change.workingTreeStatus}`.toLowerCase().includes(query))
  )]));
  const filteredTotal = [...changesByList.values()].reduce((count, changes) => count + changes.length, 0);
  const visiblePaths = s.changelists
    .filter((list) => !ui.collapsed.has(list.id))
    .flatMap((list) => (changesByList.get(list.id) || []).map((change) => change.path));
  if (!visiblePaths.includes(ui.focusedPath)) ui.focusedPath = visiblePaths[0];
  const lists = s.changelists.filter((list) => !filtersActive || changesByList.get(list.id)?.length).map((list) => {
    const collapsed = ui.collapsed.has(list.id);
    const changes = changesByList.get(list.id) || [];
    const selected = list.changes.filter((change) => ui.selected.has(change.path)).length;
    const allSelected = list.changes.length > 0 && selected === list.changes.length;
    return `<section class="changelist ${collapsed ? 'collapsed' : ''} ${list.active ? 'active-list' : ''}" data-list-id="${escapeHtml(list.id)}">
      <div class="list-heading"><label class="list-check check"><input type="checkbox" data-select-list="${escapeHtml(list.id)}" aria-label="Select all files in ${escapeHtml(list.name)}" ${allSelected ? 'checked' : ''} ${ui.busy || !list.changes.length ? 'disabled' : ''}><span></span></label><button class="list-collapse" data-collapse="${escapeHtml(list.id)}" aria-expanded="${!collapsed}">
        ${icon('chevron-down', 'disclosure')}<span class="active-dot" title="${list.active ? 'Active changelist' : ''}"></span><span class="list-name">${escapeHtml(list.name)}</span><span class="count">${filtersActive ? `${changes.length}/${list.changes.length}` : list.changes.length}</span>
      </button><button class="list-more" data-list-menu="${escapeHtml(list.id)}" aria-label="Actions for ${escapeHtml(list.name)}" aria-expanded="${ui.listMenuId === list.id}">${icon('more')}</button></div>
      <div class="file-list-shell"><div class="file-list ${list.changes.length ? '' : 'empty'}" data-drop-list="${escapeHtml(list.id)}">
        ${changes.map((change) => renderFile(change, list.id)).join('')}
      </div></div><div class="list-menu ${ui.listMenuId === list.id ? 'open' : ''}" role="menu" ${ui.listMenuId === list.id ? '' : 'inert'}>
        ${list.active ? '' : `<button role="menuitem" data-list-action="active" data-list-id="${escapeHtml(list.id)}">Set Active</button>`}
        <button role="menuitem" data-list-action="rename" data-list-id="${escapeHtml(list.id)}" data-list-name="${escapeHtml(list.name)}">Rename</button>
        ${list.id === 'default' ? '' : `<button role="menuitem" class="danger" data-list-action="delete" data-list-id="${escapeHtml(list.id)}" data-list-name="${escapeHtml(list.name)}">Delete</button>`}
      </div>
    </section>`;
  }).join('');
  const selectedCount = ui.selected.size;
  const canCommit = Boolean(selectedCount && ui.commitMessage.trim() && !ui.busy);
  const commitHint = !selectedCount ? 'Select at least one changed file' : !ui.commitMessage.trim() ? 'Write a commit message' : 'Commit selected files';
  return `
    <div class="commit-upper" id="kivo-commit-upper" style="flex-basis:${ui.commitZonePercent}%">
      ${renderCommitToolbar(s)}
      <div class="commit-changes-heading" role="heading" aria-level="2"><span class="changes-heading-label">${kivoIcon('changes', 'changes-heading-icon')}<span>Changes</span></span><small>${filtersActive ? `${filteredTotal}/${s.changes.length}` : s.changes.length || ''}</small></div>
      ${ui.changeSearchOpen ? `<div class="commit-change-search"><input id="change-search" type="search" aria-label="Search changed files by path or status" placeholder="Path or status…" value="${escapeHtml(ui.changeQuery)}"><select id="change-kind-filter" aria-label="Filter changed files by type"><option value="all" ${ui.changeKindFilter === 'all' ? 'selected' : ''}>All types</option><option value="modified" ${ui.changeKindFilter === 'modified' ? 'selected' : ''}>Modified</option><option value="added" ${ui.changeKindFilter === 'added' ? 'selected' : ''}>Added</option><option value="deleted" ${ui.changeKindFilter === 'deleted' ? 'selected' : ''}>Deleted</option><option value="renamed" ${ui.changeKindFilter === 'renamed' ? 'selected' : ''}>Renamed</option><option value="untracked" ${ui.changeKindFilter === 'untracked' ? 'selected' : ''}>Untracked</option><option value="conflict" ${ui.changeKindFilter === 'conflict' ? 'selected' : ''}>Conflicts</option></select><kbd>Esc</kbd></div>` : ''}
      <div class="lists commit-changes-tree" id="kivo-commit-changes">${lists || `<div class="commit-empty-list">${filtersActive ? 'No changed files match the current filters' : 'No changes'}</div>`}</div>
      <div class="commit-panel-splitter" data-commit-panel-splitter role="separator" aria-label="Resize changes and commit message" aria-controls="kivo-commit-changes kivo-commit-message" aria-orientation="horizontal" aria-valuemin="${COMMIT_PANEL_MIN_HEIGHT}" aria-valuenow="${Math.round(ui.commitPanelHeight)}" tabindex="0" title="Drag to resize. Double-click to reset."></div>
      <footer class="commit-panel" id="kivo-commit-message" style="--commit-panel-height:${Math.round(ui.commitPanelHeight)}px">
      <textarea id="commit-message" rows="4" placeholder="Commit Message" aria-label="Commit Message" spellcheck="true" ${ui.operationKind === 'commit' ? 'disabled' : ''}>${escapeHtml(ui.commitMessage)}</textarea>
      <div class="commit-actions">
        <button class="primary-button ${ui.operationKind === 'commit' ? 'working' : ''}" data-action="commit" title="${escapeHtml(commitHint)} (${commandKey}+Enter)" ${!canCommit ? 'disabled' : ''}>${ui.operationKind === 'commit' ? `${icon('loading', 'codicon-modifier-spin button-spinner')}<span>Committing…</span>` : '<span>Commit</span>'}</button>
        <button class="commit-push-button ${ui.operationKind === 'push' ? 'working' : ''}" data-action="commit-and-push" title="${escapeHtml(canCommit ? 'Commit selected files and push' : commitHint)}" ${!canCommit ? 'disabled' : ''}>${ui.operationKind === 'push' ? `${icon('loading', 'codicon-modifier-spin button-spinner')}<span>Pushing…</span>` : '<span>Commit and Push…</span>'}</button>
        <button class="idea-toolbar-button commit-settings" data-action="open-settings" aria-label="Kivo Git settings" title="Kivo Git settings">${icon('gear')}</button>
      </div>
      </footer>
    </div>
    <div class="commit-zone-splitter" data-commit-zone-splitter role="separator" aria-label="Resize commit and insights sections" aria-controls="kivo-commit-upper kivo-commit-lower" aria-orientation="horizontal" aria-valuenow="${ui.commitZonePercent}" aria-valuemin="35" aria-valuemax="75" tabindex="0" title="Drag to resize. Double-click to reset."></div>
    <div class="commit-lower" id="kivo-commit-lower">
      ${renderRecentCommits(s)}
      ${renderCommitRepositoryContext(s)}
      ${renderCommitSummary(s)}
    </div>
    ${renderFileContextMenu()}`;
}

function renderRecentCommits(s) {
  const commits = (s.commits || []).slice(0, 2);
  return `<section class="commit-recent" aria-label="Recent commits">
    <div class="commit-lower-heading">${icon('history')}<span>Recent commits</span><button data-action="show-log" aria-label="Show all commit history">View all</button></div>
    <div class="commit-recent-list">${commits.length ? commits.map((commit) => `<button class="commit-recent-row" data-recent-commit="${escapeHtml(commit.hash)}" title="Open ${escapeHtml(commit.subject)} in History">
      ${icon('git-commit')}<span class="commit-recent-copy"><strong>${escapeHtml(commit.subject)}</strong><code>${escapeHtml(commit.shortHash)}</code></span><time title="${escapeHtml(commit.date)}">${relativeTime(commit.date)}</time>
    </button>`).join('') : '<div class="commit-recent-empty">No commits yet</div>'}</div>
  </section>`;
}

function renderCommitSummary(s) {
  const modified = s.changes.filter((change) => change.kind === 'modified').length;
  const added = s.changes.filter((change) => change.kind === 'added' || change.kind === 'untracked').length;
  const other = s.changes.length - modified - added;
  const listCount = s.changelists.length;
  const conflicts = s.changes.filter((change) => change.kind === 'conflict').length;
  return `<section class="commit-insight-card" aria-label="Change summary">
    <div class="commit-insight-title">${icon('diff')}<span>Change summary</span></div>
    <div class="commit-insight-total"><strong>${s.changes.length}</strong><span>changed ${s.changes.length === 1 ? 'file' : 'files'}</span></div>
    <div class="commit-insight-kinds"><span class="modified">${modified} modified</span><span class="added">${added} added</span>${other ? `<span>${other} other</span>` : ''}</div>
    <div class="commit-insight-footer"><span>Across changelists</span><strong>${listCount} ${listCount === 1 ? 'list' : 'lists'}</strong></div>
    <div class="commit-checks"><span>${icon(selectedCountForSummary(s) ? 'check' : 'circle-outline')} ${selectedCountForSummary(s)} selected</span><span data-commit-message-check class="${ui.commitMessage.trim() ? '' : 'pending'}">${icon(ui.commitMessage.trim() ? 'check' : 'circle-outline')} ${ui.commitMessage.trim() ? 'Message ready' : 'Message needed'}</span>${conflicts ? `<span class="pending">${icon('warning')} ${conflicts} ${conflicts === 1 ? 'conflict' : 'conflicts'}</span>` : ''}</div>
  </section>`;
}

function selectedCountForSummary(s) {
  return s.changes.filter((change) => ui.selected.has(change.path)).length;
}

function renderCommitRepositoryContext(s) {
  const detached = s.branch === '(detached)';
  const currentBranch = detached ? `Detached HEAD${s.headOid ? ` · ${s.headOid.slice(0, 8)}` : ''}` : s.branch || 'Unknown branch';
  const branchActionLabel = detached ? `Choose branch; ${currentBranch}` : `Choose branch, current branch ${currentBranch}`;
  const syncState = ui.syncPhase === 'error'
    ? 'Fetch failed'
    : ui.syncPhase === 'fetching'
      ? 'Checking remote'
      : s.upstream ? `Tracking ${s.upstream}` : 'No upstream';
  return `<section class="commit-repository-context" aria-label="Repository status">
    <div class="commit-insight-title">${icon('repo')}<span>Repository status</span></div>
    <div class="commit-repo-state">${icon(s.changes.length ? 'circle-filled' : 'check')}<span>${s.changes.length ? `Working tree has ${s.changes.length} ${s.changes.length === 1 ? 'change' : 'changes'}` : 'Working tree clean'}</span></div>
    <div class="commit-repo-meta"><button data-action="branches" aria-label="${escapeHtml(branchActionLabel)}" title="Choose branch" aria-haspopup="dialog" aria-expanded="${ui.branchOpen}" ${ui.busy ? 'disabled' : ''}>${icon('git-branch')} ${escapeHtml(currentBranch)}</button><span>·</span><span class="${ui.syncPhase === 'error' ? 'has-error' : ''}" title="${escapeHtml(ui.syncError || syncState)}">${escapeHtml(syncState)}</span></div>
    ${detached ? `<div class="commit-repo-warning" role="note">${icon('warning')}<span>New commits here have no branch name. Create a branch to keep them easy to find.</span><button data-action="save-detached-head" ${ui.busy ? 'disabled' : ''}>Create branch…</button></div>` : ''}
  </section>`;
}

function renderFile(change, listId) {
  const checked = ui.selected.has(change.path);
  const filename = change.path.split('/').pop();
  const parent = change.path.includes('/') ? change.path.slice(0, change.path.lastIndexOf('/')) : '';
  return `<div class="file-row ${checked ? 'selected' : ''} ${ui.focusedPath === change.path ? 'focused' : ''}" draggable="${!ui.busy}" data-file-row data-path="${escapeHtml(change.path)}" data-list-id="${escapeHtml(listId)}" title="${escapeHtml(change.path)}">
    <label class="check"><input type="checkbox" aria-label="Select ${escapeHtml(change.path)}" data-select="${escapeHtml(change.path)}" ${checked ? 'checked' : ''} ${ui.busy ? 'disabled' : ''}><span></span></label>
    <button class="file-main" data-diff="${escapeHtml(change.path)}" data-original-path="${escapeHtml(change.originalPath || '')}" data-kind="${escapeHtml(change.kind)}" tabindex="${ui.focusedPath === change.path ? '0' : '-1'}" aria-keyshortcuts="M" aria-label="Preview diff for ${escapeHtml(change.path)}; press M to move to another changelist" title="${escapeHtml(change.path)} · Press M to move to another changelist">
      ${renderFileTypeIcon(change)}<span class="file-name">${escapeHtml(filename)}</span>${parent ? `<span class="file-parent">${escapeHtml(parent)}</span>` : ''}
    </button>
    <span class="status ${change.kind}" title="${escapeHtml(fileStateTitle(change))}" aria-label="${escapeHtml(fileStateTitle(change))}">${escapeHtml(fileStateLabel(change))}</span>
    <button class="file-more" data-file-menu aria-label="More actions for ${escapeHtml(change.path)}" title="More actions" aria-haspopup="menu" aria-expanded="${ui.fileContextMenu?.path === change.path}">${icon('more')}</button>
  </div>`;
}

function renderFileTypeIcon(change, fileIcons = ui.snapshot?.fileIcons) {
  const fileIcon = fileIcons?.[change.path];
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

function renderFileContextMenu() {
  const menu = ui.fileContextMenu;
  if (!menu) return '';
  const change = ui.snapshot?.changes.find((candidate) => candidate.path === menu.path) || menu.change || { path: menu.path, kind: menu.kind || 'modified' };
  const filename = change.path.split('/').pop() || change.path;
  const list = ui.snapshot?.changelists.find((candidate) => candidate.id === menu.listId);
  const partialDiff = change.staged && change.kind !== 'conflict' && change.workingTreeStatus !== '.' && change.workingTreeStatus !== 'R';
  const width = 278;
  const height = (list?.changes.length && list.changes.length > 1 ? 278 : 248) + (partialDiff ? 52 : 0);
  const left = clamp(menu.x, 8, Math.max(8, window.innerWidth - width - 8));
  const top = clamp(menu.y, 8, Math.max(8, window.innerHeight - height - 8));
  const openFileDisabled = change.kind === 'deleted' || ui.busy;
  return `<div class="context-menu file-context-menu" data-file-context role="menu" aria-label="Actions for ${escapeHtml(change.path)}" style="left:${left}px;top:${top}px">
    <div class="context-menu-title file-context-title">
      <span class="file-context-icon">${renderFileTypeIcon(change)}</span>
      <span class="file-context-copy"><strong title="${escapeHtml(change.path)}">${escapeHtml(filename)}</strong><small title="${escapeHtml(change.path)}">${escapeHtml(change.path)}</small></span>
      <span class="file-context-status status ${change.kind}">${iconFor(change.kind)}</span>
    </div>
    <div class="context-menu-separator" role="separator"></div>
    <button role="menuitem" data-file-context-action="open-diff" ${ui.busy ? 'disabled' : ''}>${icon('diff')}<span>Open Diff</span><kbd>Enter</kbd></button>
    ${partialDiff ? `<button role="menuitem" data-file-context-action="open-staged-diff" ${ui.busy ? 'disabled' : ''}>${icon('diff')}<span>Staged Diff</span><kbd>HEAD → Index</kbd></button><button role="menuitem" data-file-context-action="open-unstaged-diff" ${ui.busy ? 'disabled' : ''}>${icon('diff')}<span>Unstaged Diff</span><kbd>Index → File</kbd></button>` : ''}
    <button role="menuitem" data-file-context-action="open-file" ${openFileDisabled ? 'disabled' : ''}>${icon('go-to-file')}<span>Open File</span></button>
    <button role="menuitem" data-file-context-action="history">${icon('history')}<span>Show File History</span></button>
    <button role="menuitem" data-file-context-action="reveal" ${change.kind === 'deleted' ? 'disabled' : ''}>${icon('folder-opened')}<span>Reveal in Explorer</span></button>
    <div class="context-menu-separator" role="separator"></div>
    <button role="menuitem" data-file-context-action="move" ${ui.busy ? 'disabled' : ''}>${icon('arrow-swap')}<span>Move to Changelist…</span></button>
    ${list?.changes.length && list.changes.length > 1 ? `<button role="menuitem" data-file-context-action="select-list" ${ui.busy ? 'disabled' : ''}>${icon('list-selection')}<span>Select All in Changelist</span></button>` : ''}
    <button role="menuitem" data-file-context-action="copy-path">${icon('copy')}<span>Copy Relative Path</span></button>
  </div>`;
}

function renderRef(ref) {
  const kind = ref.kind === 'remote' ? 'remote' : ref.kind === 'tag' ? 'tag' : 'local';
  return `<span class="graph-ref ${kind} ${ref.current ? 'current' : ''}">${icon(ref.kind === 'tag' ? 'tag' : ref.kind === 'remote' ? 'cloud' : 'git-branch')}<span>${ref.current ? 'HEAD · ' : ''}${escapeHtml(ref.name)}</span></span>`;
}

function graphPoint(lane, laneWidth = 18) {
  return 13 + lane * laneWidth;
}

function renderGraphSvg(commit, graph, rowHeight = GRAPH_ROW_HEIGHT) {
  const lines = [];
  const { laneWidth, graphWidth, nodeRadius, mergeNodeRadius } = graph;
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
  lines.push(`<circle class="graph-node graph-lane-${commit.lane % 6} ${commit.parents?.length > 1 ? 'merge' : ''}" cx="${graphPoint(commit.lane, laneWidth)}" cy="${midpoint}" r="${commit.parents?.length > 1 ? mergeNodeRadius : nodeRadius}"/>`);
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
    return `<button class="commit-file tree-file" style="--tree-indent:${depth * 13}px" data-commit-file="${escapeHtml(file.path)}" data-commit-kind="${escapeHtml(file.status)}" data-commit-original="${escapeHtml(file.originalPath || '')}" title="Open diff for ${escapeHtml(file.path)}">${renderFileTypeIcon(file, ui.commitDetails?.fileIcons)}<span class="commit-file-name">${escapeHtml(file.leaf)}</span><span class="status ${kind}">${escapeHtml(file.status)}</span></button>`;
  }).join('')}`;
}

function renderCommitDetails(s) {
  const toolbar = `<div class="commit-detail-toolbar"><button class="idea-toolbar-button" data-action="refresh" aria-label="Refresh History" title="Refresh History">${icon('refresh')}</button><span class="toolbar-spacer"></span>${ui.selectedCommitHash ? `<button class="idea-toolbar-button" data-action="close-commit" aria-label="Clear selected commit" title="Clear selection">${icon('close')}</button>` : ''}</div>`;
  if (!ui.selectedCommitHash) {
    return `<aside class="commit-detail commit-detail-empty" id="kivo-log-details" aria-label="Commit details">${toolbar}<div class="commit-detail-empty-copy"><div class="detail-empty-mark">${icon('git-commit')}</div><strong>Select a commit</strong><span>Its changed files and commit message appear here.</span></div></aside>`;
  }
  const commit = s.commits.find((item) => item.hash === ui.selectedCommitHash);
  if (!commit) return '';
  const details = ui.commitDetails?.hash === commit.hash ? ui.commitDetails : undefined;
  const metadataHeight = Math.round(Math.max(COMMIT_METADATA_MIN_HEIGHT, ui.commitMetadataHeight));
  return `<aside class="commit-detail" id="kivo-log-details" aria-label="Commit details" style="--commit-metadata-height:${metadataHeight}px">
    ${toolbar}
    <div class="commit-files-panel">
      <div class="details-section-heading"><span>Changed Files</span><span class="details-count">${details ? details.files.length : ''}</span></div>
      ${ui.commitDetailsLoading && !details ? `<div class="detail-loading">${icon('loading', 'codicon-modifier-spin')} Loading changed files…</div>` : ''}
      ${ui.commitDetailsError && !details ? `<div class="detail-error" role="alert">${icon('error')}<span>${escapeHtml(ui.commitDetailsError)}</span><button class="text-button" data-action="retry-commit">Retry</button></div>` : ''}
      ${details ? `<div class="commit-files file-tree">${details.files.length ? renderCommitFileTree(buildPathTree(details.files)) : '<span class="detail-muted">No file changes reported</span>'}</div>` : ''}
    </div>
    <div class="commit-detail-splitter" data-commit-detail-splitter role="separator" aria-label="Resize changed files and commit information" aria-orientation="horizontal" aria-valuemin="${COMMIT_METADATA_MIN_HEIGHT}" aria-valuenow="${metadataHeight}" tabindex="0" title="Drag to resize. Double-click to reset."></div>
    <div class="commit-metadata">
      <div class="commit-detail-head"><div><span class="detail-kicker">${escapeHtml(commit.shortHash)}</span><strong>${escapeHtml(commit.subject)}</strong></div></div>
      <div class="commit-detail-meta"><span>${escapeHtml(commit.author)} · ${relativeTime(commit.date)}</span><code>${escapeHtml(commit.hash)}</code></div>
      <div class="commit-detail-refs">${commit.refs.map(renderRef).join('') || '<span class="detail-muted">No branch label</span>'}</div>
      ${details?.body && details.body !== details.subject ? `<p class="commit-body">${escapeHtml(details.body)}</p>` : ''}
      ${details?.parents?.length ? `<div class="detail-parents"><span>Parents</span>${details.parents.map((parent) => `<code>${escapeHtml(parent.slice(0, 8))}</code>`).join('')}</div>` : ''}
    </div>
  </aside>`;
}

function renderLogBranchRow(branch, depth = 0, sync = '') {
  const kind = branch.kind === 'tag' ? 'tag' : 'branch';
  const label = branch.leaf || branch.name;
  return `<button class="log-branch-row ${branch.current ? 'current' : ''} ${ui.graphBranchFilter === branch.name ? 'selected' : ''}" style="--tree-indent:${depth * 13}px" data-log-branch="${escapeHtml(branch.name)}" data-branch-ref="${escapeHtml(branch.name)}" data-branch-remote="${branch.remote ? 'true' : 'false'}" data-branch-kind="${kind}" aria-pressed="${ui.graphBranchFilter === branch.name}" aria-haspopup="menu" title="Show ${escapeHtml(branch.name)} history · Right-click for ${kind} actions">${icon(branch.remote ? 'cloud' : kind === 'tag' ? 'tag' : 'git-branch')}<span>${escapeHtml(label)}</span>${sync}${branch.current ? '<small>HEAD</small>' : ''}</button>`;
}

function renderLogBranchTree(node, depth = 0, parentPath = '', forceExpanded = false) {
  const folders = [...node.directories.entries()].sort(([left], [right]) => left.localeCompare(right));
  return `${folders.map(([name, child]) => {
    const folderPath = parentPath ? `${parentPath}/${name}` : name;
    const expanded = forceExpanded || !ui.collapsedLogBranchFolders.has(folderPath);
    return `<div class="log-branch-folder-node ${expanded ? 'expanded' : 'collapsed'}" data-log-branch-folder-node="${escapeHtml(folderPath)}"><button class="log-branch-folder" style="--tree-indent:${depth * 13}px" data-log-folder-toggle="${escapeHtml(folderPath)}" aria-expanded="${expanded}" title="${expanded ? 'Collapse' : 'Expand'} ${escapeHtml(folderPath)}">${icon('chevron-right', 'branch-folder-chevron')}${icon('folder')}<span>${escapeHtml(name)}</span></button>${expanded ? `<div class="log-branch-folder-children">${renderLogBranchTree(child, depth + 1, folderPath, forceExpanded)}</div>` : ''}</div>`;
  }).join('')}${node.leaves.sort((left, right) => left.leaf.localeCompare(right.leaf)).map((branch) => renderLogBranchRow(branch, depth)).join('')}`;
}

function renderLogBranchPane(s) {
  const query = ui.logBranchQuery.trim().toLowerCase();
  const matches = (item) => !query || item.name.toLowerCase().includes(query);
  const current = s.branches.find((branch) => branch.current && !branch.remote);
  const local = s.branches.filter((branch) => !branch.remote && matches(branch))
    .sort((left, right) => Number(right.current) - Number(left.current) || left.name.localeCompare(right.name));
  const remote = s.branches.filter((branch) => branch.remote && matches(branch));
  const tags = (s.tags || []).filter(matches).map((tag) => ({ ...tag, path: tag.name, name: tag.name, remote: false, kind: 'tag' }));
  const tagCount = (s.tags || []).length;
  const syncTitle = s.upstream
    ? `${s.behind} incoming, ${s.ahead} outgoing · ${s.upstream}${ui.syncPhase === 'error' ? ' · Remote check failed' : ''}`
    : 'No upstream branch';
  const syncIcon = current
    ? `<span class="branch-current-sync ${s.behind || s.ahead ? 'has-count' : ''}" title="${escapeHtml(syncTitle)}" aria-label="${escapeHtml(syncTitle)}">${icon(ui.syncPhase === 'fetching' ? 'loading' : ui.syncPhase === 'error' ? 'warning' : s.upstream ? 'sync' : 'circle-slash', ui.syncPhase === 'fetching' ? 'codicon-modifier-spin' : '')}</span>`
    : '';
  const group = (key, label, items, emptyLabel) => {
    const expanded = Boolean(query) || ui.branchGroupsExpanded[key];
    const visibleCount = ui.branchVisibleCounts[key];
    const visible = expanded ? items.slice(0, visibleCount) : [];
    const remaining = Math.max(0, items.length - visible.length);
    const tree = key === 'local'
      ? visible.map((branch) => renderLogBranchRow(branch, 0, branch.current ? syncIcon : '')).join('')
      : visible.length ? renderLogBranchTree(buildPathTree(visible), 0, '', Boolean(query)) : '';
    return `<section class="log-branch-group ${expanded ? 'expanded' : 'collapsed'}" data-branch-group-section="${key}">
      <button class="log-branch-group-title" data-branch-group="${key}" aria-expanded="${expanded}">${icon('chevron-right', 'branch-group-chevron')}<span>${label}</span><small>${items.length}</small></button>
      ${expanded ? `<div class="log-branch-group-body">${tree || (key === 'local' && !query ? '' : `<div class="branch-tree-empty">${emptyLabel}</div>`)}${remaining ? `<button class="branch-load-more" data-branch-more="${key}">Show ${Math.min(BRANCH_PAGE_SIZE, remaining)} more</button>` : ''}</div>` : ''}
    </section>`;
  };
  return `<aside class="log-branch-pane" id="kivo-log-branches" aria-label="History branches">
    <label class="log-branch-search">${icon('search')}<input id="log-branch-search" aria-label="Branch or tag" placeholder="Branch or tag" value="${escapeHtml(ui.logBranchQuery)}"></label>
    <div class="log-branch-tree">
      ${group('local', 'Local', local, query ? 'No matching local branches' : 'No other local branches')}
      ${group('remote', 'Remote', remote, query ? 'No matching remote branches' : 'No remote branches')}
      ${tagCount || query ? group('tags', 'Tags', tags, query ? 'No matching tags' : 'No tags') : ''}
    </div>
  </aside>`;
}

function renderBranchContextMenu() {
  const menu = ui.branchContextMenu;
  if (!menu) return '';
  const width = 264;
  const actionCount = 3
    + (menu.kind === 'branch' && !menu.current ? 3 : 0)
    + (menu.kind === 'branch' && !menu.remote ? 1 : 0);
  const height = 40 + actionCount * 27 + 12;
  const left = clamp(menu.x, 8, Math.max(8, window.innerWidth - width - 8));
  const top = clamp(menu.y, 8, Math.max(8, window.innerHeight - height - 8));
  const refLabel = menu.kind === 'tag' ? 'tag' : 'branch';
  return `<div class="context-menu branch-context-menu" data-branch-context role="menu" aria-label="Actions for ${escapeHtml(menu.ref)}" style="left:${left}px;top:${top}px">
    <div class="context-menu-title branch-context-title"><span>${icon(menu.remote ? 'cloud' : menu.kind === 'tag' ? 'tag' : 'git-branch')}</span><strong title="${escapeHtml(menu.ref)}">${escapeHtml(menu.ref)}</strong></div>
    ${menu.kind === 'branch' && !menu.current ? `<button role="menuitem" data-branch-context-action="checkout" ${ui.busy ? 'disabled' : ''}>${icon('check')}<span>Checkout</span></button>` : ''}
    <button role="menuitem" data-branch-context-action="new" ${ui.busy ? 'disabled' : ''}>${icon('git-branch-create')}<span>New Branch from this ${refLabel}…</span></button>
    ${menu.kind === 'branch' && !menu.current ? `<button role="menuitem" data-branch-context-action="merge" ${ui.busy ? 'disabled' : ''}>${icon('git-merge')}<span>Merge into Current…</span></button>` : ''}
    ${menu.kind === 'branch' ? '<div class="context-menu-separator" role="separator"></div>' : ''}
    ${menu.kind === 'branch' && !menu.remote ? `<button role="menuitem" data-branch-context-action="rename" ${ui.busy ? 'disabled' : ''}>${icon('edit')}<span>Rename…</span></button>` : ''}
    ${menu.kind === 'branch' && !menu.current ? `<button class="danger-action" role="menuitem" data-branch-context-action="delete" ${ui.busy ? 'disabled' : ''}>${icon('trash')}<span>${menu.remote ? 'Delete Remote Branch…' : 'Delete…'}</span></button>` : ''}
    <div class="context-menu-separator" role="separator"></div>
    <button role="menuitem" data-branch-context-action="copy">${icon('copy')}<span>Copy ${menu.kind === 'tag' ? 'Tag' : 'Branch'} Name</span></button>
    <button role="menuitem" data-branch-context-action="filter">${icon('filter')}<span>Show History</span></button>
  </div>`;
}

function renderCommitContextMenu() {
  const menu = ui.commitContextMenu;
  if (!menu) return '';
  const commit = ui.snapshot?.commits.find((candidate) => candidate.hash === menu.hash);
  if (!commit) return '';
  const width = 270;
  const height = 244;
  const left = clamp(menu.x, 8, Math.max(8, window.innerWidth - width - 8));
  const top = clamp(menu.y, 8, Math.max(8, window.innerHeight - height - 8));
  return `<div class="context-menu commit-context-menu" data-commit-context role="menu" aria-label="Actions for commit ${escapeHtml(commit.shortHash)}" style="left:${left}px;top:${top}px">
    <div class="context-menu-title commit-context-title">${icon('git-commit')}<span><strong title="${escapeHtml(commit.subject)}">${escapeHtml(commit.subject)}</strong><code>${escapeHtml(commit.shortHash)}</code></span></div>
    <div class="context-menu-separator" role="separator"></div>
    <button role="menuitem" data-commit-context-action="details">${icon('preview')}<span>Show Commit Details</span></button>
    <button role="menuitem" data-commit-context-action="copy">${icon('copy')}<span>Copy Commit Hash</span></button>
    <button role="menuitem" data-commit-context-action="copy-subject">${icon('symbol-string')}<span>Copy Commit Subject</span></button>
    <div class="context-menu-separator" role="separator"></div>
    <button role="menuitem" data-commit-context-action="branch" ${ui.busy ? 'disabled' : ''}>${icon('git-branch-create')}<span>New Branch from Commit…</span></button>
    <button role="menuitem" data-commit-context-action="tag" ${ui.busy ? 'disabled' : ''}>${icon('tag')}<span>New Tag…</span></button>
    <button role="menuitem" data-commit-context-action="checkout" ${ui.busy ? 'disabled' : ''}>${icon('inspect')}<span>Checkout Revision…</span></button>
  </div>`;
}

function renderLogActionRail() {
  return `<aside class="log-action-rail" aria-label="History actions">
    <button class="idea-toolbar-button" data-action="show-changes" aria-label="Open Commit tool window" title="Open Commit tool window">${kivoIcon('changes', 'kivo-toolbar-mark')}</button>
    <button class="idea-toolbar-button" data-action="refresh" aria-label="Refresh History" title="Refresh History">${icon('refresh')}</button>
    <button class="idea-toolbar-button" data-action="fetch" aria-label="Fetch remote updates" title="Fetch remote updates" ${ui.busy || ui.syncPhase === 'fetching' ? 'disabled' : ''}>${icon(ui.syncPhase === 'fetching' ? 'loading' : 'cloud-download', ui.syncPhase === 'fetching' ? 'codicon-modifier-spin' : '')}</button>
    <span class="idea-toolbar-divider" aria-hidden="true"></span>
    <button class="idea-toolbar-button" data-action="clear-graph-filters" aria-label="Clear History filters" title="Clear History filters">${icon('clear-all')}</button>
  </aside>`;
}

function renderLogFilterBar(s, commits, filtersActive) {
  const branchOptions = [...new Set([...s.branches, ...(s.tags || [])].map((branch) => branch.name))].sort((a, b) => a.localeCompare(b));
  const authorOptions = [...new Set(s.commits.map((commit) => commit.author))].sort((a, b) => a.localeCompare(b));
  const countLabel = filtersActive ? `${commits.length} of ${s.commits.length}${s.commitsHasMore ? ' loaded' : ''}` : `${s.commits.length}${s.commitsHasMore ? '+ loaded' : ''}`;
  return `<div class="log-filter-bar"><div class="graph-toolbar-head">
    <label class="graph-search log-search">${icon('search')}<input id="graph-search" aria-label="Search by text or hash" placeholder="Search commits or hash" value="${escapeHtml(ui.graphQuery)}"></label>
    <div class="graph-filters" aria-label="History filters">
      <label class="graph-filter"><span>Ref</span><select data-graph-filter="branch" aria-label="Filter by branch or tag"><option value="">All refs</option>${branchOptions.map((branch) => `<option value="${escapeHtml(branch)}" ${ui.graphBranchFilter === branch ? 'selected' : ''}>${escapeHtml(branch)}</option>`).join('')}</select></label>
      <label class="graph-filter"><span>User</span><select data-graph-filter="author" aria-label="Filter by author"><option value="">All</option>${authorOptions.map((author) => `<option value="${escapeHtml(author)}" ${ui.graphAuthorFilter === author ? 'selected' : ''}>${escapeHtml(author)}</option>`).join('')}</select></label>
      <label class="graph-filter"><span>Date</span><select data-graph-filter="age" aria-label="Filter by date"><option value="all" ${ui.graphAgeFilter === 'all' ? 'selected' : ''}>All</option><option value="7d" ${ui.graphAgeFilter === '7d' ? 'selected' : ''}>7 days</option><option value="30d" ${ui.graphAgeFilter === '30d' ? 'selected' : ''}>30 days</option><option value="90d" ${ui.graphAgeFilter === '90d' ? 'selected' : ''}>90 days</option></select></label>
      <label class="graph-filter path-filter"><span>Paths</span><input id="graph-path" aria-label="Filter by path" placeholder="Any" value="${escapeHtml(ui.graphPathFilter)}"></label>
      ${filtersActive ? '<button class="text-button graph-clear" data-action="clear-graph-filters">Clear</button>' : ''}
    </div><span class="log-result-count" aria-live="polite">${countLabel}</span>
  </div></div>`;
}

function renderGraph(s) {
  const commits = graphCommits();
  const windowed = graphRenderWindow(commits);
  const visibleCommits = commits.slice(windowed.start, windowed.end);
  const graph = graphLayoutFor(visibleCommits);
  const { laneCount, graphWidth } = graph;
  const focusHash = ui.focusedCommitHash && commits.some((commit) => commit.hash === ui.focusedCommitHash)
    ? ui.focusedCommitHash
    : commits[0]?.hash;
  const filtersActive = Boolean(ui.graphBranchFilter || ui.graphAuthorFilter || ui.graphAgeFilter !== 'all' || ui.graphQuery.trim() || ui.graphPathFilter.trim());
  const searchingHash = /^[0-9a-f]{7,40}$/i.test(ui.graphQuery.trim());
  const branchWidth = Math.round(clamp(ui.logBranchWidth, LOG_BRANCH_MIN_WIDTH, LOG_BRANCH_MAX_WIDTH));
  const detailWidth = Math.round(clamp(ui.logDetailWidth, LOG_DETAIL_MIN_WIDTH, LOG_DETAIL_MAX_WIDTH));
  const detailHeight = Math.round(Math.max(LOG_DETAIL_MIN_HEIGHT, ui.logDetailHeight));
  const detailUsesRows = logDetailUsesRows();
  const detailSize = detailUsesRows ? detailHeight : detailWidth;
  const detailMinimum = detailUsesRows ? LOG_DETAIL_MIN_HEIGHT : LOG_DETAIL_MIN_WIDTH;
  const detailMaximum = detailUsesRows ? Math.max(LOG_DETAIL_DEFAULT_HEIGHT * 2, detailHeight) : LOG_DETAIL_MAX_WIDTH;
  return `<div class="graph-view log-view" role="tabpanel" aria-label="Kivo Git History">
    <div class="log-workspace" style="--log-branch-width:${branchWidth}px;--log-detail-width:${detailWidth}px;--log-detail-height:${detailHeight}px">
      ${renderLogActionRail()}
      ${renderLogBranchPane(s)}
      <div class="log-splitter" data-log-splitter role="separator" aria-label="Resize History branch tree" aria-controls="kivo-log-branches kivo-log-history" aria-orientation="vertical" aria-valuemin="${LOG_BRANCH_MIN_WIDTH}" aria-valuemax="${LOG_BRANCH_MAX_WIDTH}" aria-valuenow="${branchWidth}" tabindex="0" title="Drag to resize the branch tree. Double-click to reset."></div>
      <section class="log-history-pane" id="kivo-log-history" aria-label="Commit history">
        ${renderLogFilterBar(s, commits, filtersActive)}
        <div class="log-column-header" aria-hidden="true" style="--graph-width:${graphWidth}px"><span>AUTHOR</span><span>GRAPH</span><span>COMMIT</span><span>DATE</span></div>
        <div class="graph-list ${graph.compressed ? 'graph-compressed' : ''} ${ui.graphLoadingMore ? 'is-loading' : ''}" data-graph-list role="listbox" aria-label="Commit history${graph.compressed ? `, compact ${laneCount}-lane topology` : ''}" aria-busy="${ui.graphLoadingMore || ui.historyRefLoading}" aria-setsize="${commits.length}" style="--lane-count:${laneCount};--graph-width:${graphWidth}px;--graph-row-height:${GRAPH_ROW_HEIGHT}px">${ui.historyRefLoading ? `<div class="inline-empty" role="status">${icon('loading', 'codicon-modifier-spin')} Loading branch history…</div>` : commits.length ? `${windowed.topSpacer ? `<div class="graph-virtual-spacer" aria-hidden="true" style="height:${windowed.topSpacer}px"></div>` : ''}${visibleCommits.map((commit, index) => `<article class="graph-row ${commit.parents.length > 1 ? 'merge-row' : ''} ${ui.selectedCommitHash === commit.hash ? 'selected' : ''}" data-commit="${escapeHtml(commit.hash)}" data-hash="${escapeHtml(commit.hash)}" role="option" aria-selected="${ui.selectedCommitHash === commit.hash}" aria-posinset="${windowed.start + index + 1}" tabindex="${focusHash === commit.hash ? '0' : '-1'}">
          <span class="log-author" title="${escapeHtml(commit.author)}">${escapeHtml(commit.author)}</span><div class="graph-canvas">${renderGraphSvg(commit, graph)}</div><div class="graph-commit"><div class="log-subject"><strong title="${escapeHtml(commit.subject)}">${escapeHtml(commit.subject)}</strong>${(commit.refs || []).slice(0, 3).map(renderRef).join('')}</div><span class="log-meta"><code>${escapeHtml(commit.shortHash)}</code>${commit.parents?.length > 1 ? '<span class="merge-note">Merge</span>' : ''}</span></div><time class="log-date" title="${escapeHtml(commit.date)}">${relativeTime(commit.date)}</time>
        </article>`).join('')}${windowed.bottomSpacer ? `<div class="graph-virtual-spacer" aria-hidden="true" style="height:${windowed.bottomSpacer}px"></div>` : ''}` : `<div class="inline-empty" role="status">${ui.graphLoadingMore && searchingHash ? `Searching older history for ${escapeHtml(ui.graphQuery.trim())}…` : s.commitsHasMore ? `No matches in ${s.commits.length} loaded commits. Load more to search older history.` : s.commits.length ? 'No matching commits' : 'No commits yet'}</div>`}${ui.graphLoadingMore ? `<div class="graph-loading-row" role="status">${icon('loading', 'codicon-modifier-spin')}<span>Loading more history…</span></div>` : ''}</div>
        ${s.commitsHasMore && !ui.graphLoadingMore && !ui.historyRefLoading ? `<button class="load-more" data-action="load-more-commits" ${ui.busy ? 'disabled' : ''}>${icon('history')}<span>Load more history</span><small>Loaded ${s.commits.length} · Scroll for more</small></button>` : ''}
      </section>
      <div class="log-detail-splitter" data-log-detail-splitter role="separator" aria-label="Resize commit history and details" aria-controls="kivo-log-history kivo-log-details" aria-orientation="${detailUsesRows ? 'horizontal' : 'vertical'}" aria-valuemin="${detailMinimum}" aria-valuemax="${detailMaximum}" aria-valuenow="${detailSize}" tabindex="0" title="Drag to resize. Double-click to reset."></div>
      ${renderCommitDetails(s)}
    </div>
    ${renderBranchContextMenu()}
    ${renderCommitContextMenu()}
  </div>`;
}

function logBranchBounds(splitter) {
  const workspace = splitter.closest('.log-workspace');
  const compact = window.matchMedia('(max-width: 860px)').matches;
  const narrow = window.matchMedia('(max-width: 1180px)').matches;
  const railWidth = compact || narrow ? 30 : 32;
  const detailWidth = compact ? 0 : ui.logDetailWidth;
  const historyMinimum = compact ? 220 : narrow ? 300 : 430;
  const splitterWidth = compact ? 6 : 12;
  const availableWidth = workspace?.clientWidth || 0;
  const maximum = availableWidth
    ? Math.min(LOG_BRANCH_MAX_WIDTH, Math.max(LOG_BRANCH_MIN_WIDTH, availableWidth - railWidth - splitterWidth - detailWidth - historyMinimum))
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

function openFileContextMenu(event, targetRow = event.currentTarget) {
  event.preventDefault();
  event.stopPropagation();
  const row = targetRow;
  const path = row.dataset.path;
  if (!path) return;
  const change = ui.snapshot?.changes.find((candidate) => candidate.path === path);
  ui.branchContextMenu = undefined;
  ui.commitContextMenu = undefined;
  ui.listMenuId = undefined;
  ui.pullMenuOpen = false;
  const anchor = event.currentTarget?.closest?.('[data-file-menu]')?.getBoundingClientRect();
  ui.fileContextMenu = {
    path,
    listId: row.dataset.listId || row.closest('[data-list-id]')?.dataset.listId,
    kind: change?.kind || 'modified',
    originalPath: change?.originalPath,
    change,
    returnFocus: anchor ? 'menu' : 'file',
    x: anchor ? anchor.right - 8 : event.clientX,
    y: anchor ? anchor.bottom + 2 : event.clientY
  };
  render();
  requestAnimationFrame(() => app.querySelector('[data-file-context-action]:not(:disabled)')?.focus());
}

function runFileContextAction(event) {
  event.preventDefault();
  event.stopPropagation();
  const menu = ui.fileContextMenu;
  const action = event.currentTarget.dataset.fileContextAction;
  if (!menu || !action) return;
  const change = ui.snapshot?.changes.find((candidate) => candidate.path === menu.path) || menu.change;
  ui.fileContextMenu = undefined;
  if (!change) {
    render();
    return;
  }
  if (action === 'open-diff' && !ui.busy) {
    post('openDiff', { path: change.path, originalPath: change.originalPath, kind: change.kind, preview: false });
  }
  if (action === 'open-staged-diff' && !ui.busy) post('openStagedDiff', { path: change.path });
  if (action === 'open-unstaged-diff' && !ui.busy) post('openUnstagedDiff', { path: change.path });
  if (action === 'open-file' && !ui.busy && change.kind !== 'deleted') {
    post('openFile', { path: change.path });
  }
  if (action === 'history') post('showFileHistory', { path: change.path });
  if (action === 'reveal' && change.kind !== 'deleted') post('revealInExplorer', { path: change.path });
  if (action === 'move' && !ui.busy) {
    post('moveFileToChangelist', { path: change.path });
  }
  if (action === 'select-list') {
    const list = ui.snapshot?.changelists.find((candidate) => candidate.id === menu.listId);
    if (list) {
      for (const item of list.changes) ui.selected.add(item.path);
      ui.selectionAnchor = change.path;
      persist();
      toast(`Selected ${list.changes.length} files`, 'success');
    }
  }
  if (action === 'copy-path') post('copyPath', { path: change.path });
  render();
}

function openBranchContextMenu(event, targetRow = event.currentTarget) {
  event.preventDefault();
  event.stopPropagation();
  const row = targetRow;
  const ref = row.dataset.branchRef || row.dataset.checkout;
  if (!ref) return;
  ui.fileContextMenu = undefined;
  ui.commitContextMenu = undefined;
  ui.listMenuId = undefined;
  ui.pullMenuOpen = false;
  ui.branchContextMenu = {
    ref,
    remote: row.dataset.branchRemote === 'true' || row.dataset.remote === 'true',
    current: row.classList.contains('current'),
    kind: row.dataset.branchKind === 'tag' ? 'tag' : 'branch',
    fromPopup: Boolean(row.closest('.branch-popup')),
    x: event.clientX,
    y: event.clientY
  };
  render();
  requestAnimationFrame(() => app.querySelector('[data-branch-context-action]:not(:disabled)')?.focus());
}

function openCommitContextMenu(event, targetRow = event.currentTarget) {
  event.preventDefault();
  event.stopPropagation();
  const hash = targetRow.dataset.commit;
  if (!hash) return;
  ui.branchContextMenu = undefined;
  ui.fileContextMenu = undefined;
  ui.listMenuId = undefined;
  ui.pullMenuOpen = false;
  ui.commitContextMenu = { hash, x: event.clientX, y: event.clientY };
  render();
  requestAnimationFrame(() => app.querySelector('[data-commit-context-action]:not(:disabled)')?.focus());
}

// Context menus must survive snapshot patches and virtualized history updates.
// Binding only to the current row nodes is fragile: patchApp can preserve or
// replace those nodes while the repository refreshes. Capturing on document
// and resolving the composed event path prevents the native Cut/Copy/Paste
// menu from winning the race and works across every render.
function bindContextMenuDelegation() {
  if (document.__kivoContextMenuBound) return;
  document.__kivoContextMenuBound = true;
  document.addEventListener('contextmenu', (event) => {
    const target = event.target;
    const pathElement = event.composedPath?.().find((node) => node instanceof Element && (node.matches?.('[data-log-branch]') || node.matches?.('[data-checkout]') || node.matches?.('[data-file-row]') || node.matches?.('[data-commit]')));
    const element = pathElement || (target instanceof Element ? target : target?.parentElement);
    const branch = element?.closest('[data-log-branch], [data-checkout]');
    if (branch && app.contains(branch)) {
      openBranchContextMenu(event, branch);
      return;
    }
    const file = element?.closest('[data-file-row]');
    if (file && app.contains(file)) {
      openFileContextMenu(event, file);
      return;
    }
    const commit = element?.closest('[data-commit]');
    if (commit && app.contains(commit)) openCommitContextMenu(event, commit);
  }, true);
}

function runCommitContextAction(event) {
  event.preventDefault();
  event.stopPropagation();
  const menu = ui.commitContextMenu;
  const action = event.currentTarget.dataset.commitContextAction;
  if (!menu || !action) return;
  ui.commitContextMenu = undefined;
  if (action === 'details') selectCommit(menu.hash, { focus: true, immediate: true });
  if (action === 'copy') post('copyCommitHash', { hash: menu.hash });
  if (action === 'copy-subject') post('copyCommitSubject', { hash: menu.hash });
  if (action === 'branch' && !ui.busy) post('createBranch', { startPoint: menu.hash });
  if (action === 'tag' && !ui.busy) post('createTag', { hash: menu.hash });
  if (action === 'checkout' && !ui.busy) post('checkoutRevision', { hash: menu.hash });
  render();
}

function runBranchContextAction(event) {
  event.preventDefault();
  event.stopPropagation();
  const menu = ui.branchContextMenu;
  const action = event.currentTarget.dataset.branchContextAction;
  if (!menu || !action) return;
  ui.branchContextMenu = undefined;
  if (menu.fromPopup) {
    ui.branchOpen = false;
    ui.branchQuery = '';
  }
  if (action === 'new' && !ui.busy) post('createBranch', { startPoint: menu.ref });
  if (action === 'checkout' && !ui.busy) post('checkout', { branch: menu.ref, remote: menu.remote });
  if (action === 'merge' && !ui.busy) post('mergeBranch', { branch: menu.ref });
  if (action === 'rename' && !ui.busy) post('renameBranch', { branch: menu.ref });
  if (action === 'delete' && !ui.busy) post('deleteBranch', { branch: menu.ref, remote: menu.remote });
  if (action === 'copy') post('copyBranchName', { branch: menu.ref });
  if (action === 'filter') {
    if (menu.fromPopup) post('showBranchHistory', { branch: menu.ref });
    else {
      setHistoryRef(menu.ref);
      return;
    }
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

function logDetailUsesRows() {
  return window.matchMedia('(max-width: 860px)').matches;
}

function logDetailBounds(splitter) {
  const workspace = splitter.closest('.log-workspace');
  const usesRows = logDetailUsesRows();
  if (usesRows) {
    const maximum = workspace?.clientHeight
      ? Math.max(LOG_DETAIL_MIN_HEIGHT, workspace.clientHeight - 138)
      : LOG_DETAIL_DEFAULT_HEIGHT * 2;
    return { minimum: LOG_DETAIL_MIN_HEIGHT, maximum };
  }
  const railWidth = app.querySelector('.log-action-rail')?.getBoundingClientRect().width || 32;
  const branchWidth = app.querySelector('.log-branch-pane')?.getBoundingClientRect().width || ui.logBranchWidth;
  const historyMinimum = window.matchMedia('(max-width: 1180px)').matches ? 300 : 430;
  const availableWidth = workspace?.clientWidth || 0;
  const maximum = availableWidth
    ? Math.min(LOG_DETAIL_MAX_WIDTH, Math.max(LOG_DETAIL_MIN_WIDTH, availableWidth - railWidth - branchWidth - 12 - historyMinimum))
    : LOG_DETAIL_MAX_WIDTH;
  return { minimum: LOG_DETAIL_MIN_WIDTH, maximum };
}

function applyLogDetailSize(splitter, size) {
  const workspace = splitter.closest('.log-workspace');
  const usesRows = logDetailUsesRows();
  const { minimum, maximum } = logDetailBounds(splitter);
  const next = Math.round(clamp(size, minimum, maximum));
  if (usesRows) {
    ui.logDetailHeight = next;
    workspace?.style.setProperty('--log-detail-height', `${next}px`);
  } else {
    ui.logDetailWidth = next;
    workspace?.style.setProperty('--log-detail-width', `${next}px`);
  }
  splitter.setAttribute('aria-orientation', usesRows ? 'horizontal' : 'vertical');
  splitter.setAttribute('aria-valuemin', String(minimum));
  splitter.setAttribute('aria-valuemax', String(maximum));
  splitter.setAttribute('aria-valuenow', String(next));
  return next;
}

function finishLogDetailResize(commit = true) {
  const resize = activeLogDetailResize;
  if (!resize) return;
  resize.splitter.removeEventListener('pointermove', resize.move);
  resize.splitter.removeEventListener('pointerup', resize.complete);
  resize.splitter.removeEventListener('pointercancel', resize.cancel);
  if (resize.splitter.hasPointerCapture?.(resize.pointerId)) resize.splitter.releasePointerCapture?.(resize.pointerId);
  document.body.classList.remove('log-detail-resizing');
  delete document.body.dataset.resizeAxis;
  activeLogDetailResize = undefined;
  if (commit) persist();
  else applyLogDetailSize(resize.splitter, resize.initialSize);
}

function startLogDetailResize(event) {
  if (event.button !== 0 || activeLogDetailResize) return;
  const splitter = event.currentTarget;
  const workspace = splitter.closest('.log-workspace');
  if (!workspace || getComputedStyle(splitter).display === 'none') return;
  event.preventDefault();
  const usesRows = logDetailUsesRows();
  const initialSize = applyLogDetailSize(splitter, usesRows ? ui.logDetailHeight : ui.logDetailWidth);
  const pointerId = event.pointerId;
  const move = (pointerEvent) => {
    if (pointerEvent.pointerId !== pointerId) return;
    const bounds = workspace.getBoundingClientRect();
    applyLogDetailSize(splitter, usesRows ? bounds.bottom - pointerEvent.clientY : bounds.right - pointerEvent.clientX);
  };
  const complete = (pointerEvent) => {
    if (pointerEvent.pointerId === pointerId) finishLogDetailResize(true);
  };
  const cancel = (pointerEvent) => {
    if (pointerEvent.pointerId === pointerId) finishLogDetailResize(false);
  };
  activeLogDetailResize = { splitter, pointerId, initialSize, move, complete, cancel };
  splitter.setPointerCapture?.(pointerId);
  splitter.addEventListener('pointermove', move);
  splitter.addEventListener('pointerup', complete);
  splitter.addEventListener('pointercancel', cancel);
  document.body.classList.add('log-detail-resizing');
  document.body.dataset.resizeAxis = usesRows ? 'row' : 'column';
}

function adjustLogDetailSize(event) {
  const splitter = event.currentTarget;
  const usesRows = logDetailUsesRows();
  const { minimum, maximum } = logDetailBounds(splitter);
  const step = event.shiftKey ? 24 : 12;
  const current = usesRows ? ui.logDetailHeight : ui.logDetailWidth;
  let size;
  if (usesRows && event.key === 'ArrowUp') size = current + step;
  if (usesRows && event.key === 'ArrowDown') size = current - step;
  if (!usesRows && event.key === 'ArrowLeft') size = current + step;
  if (!usesRows && event.key === 'ArrowRight') size = current - step;
  if (event.key === 'Home') size = minimum;
  if (event.key === 'End') size = maximum;
  if (size === undefined) return;
  event.preventDefault();
  applyLogDetailSize(splitter, size);
  persist();
}

function resetLogDetailSize(event) {
  const splitter = event.currentTarget;
  applyLogDetailSize(splitter, logDetailUsesRows() ? LOG_DETAIL_DEFAULT_HEIGHT : LOG_DETAIL_DEFAULT_WIDTH);
  persist();
}

function commitMetadataBounds(splitter) {
  const details = splitter.closest('.commit-detail');
  const toolbarHeight = details?.querySelector('.commit-detail-toolbar')?.getBoundingClientRect().height || 38;
  const available = details?.clientHeight || 0;
  const maximum = available
    ? Math.max(COMMIT_METADATA_MIN_HEIGHT, available - toolbarHeight - 102)
    : COMMIT_METADATA_DEFAULT_HEIGHT * 2;
  return { minimum: COMMIT_METADATA_MIN_HEIGHT, maximum };
}

function applyCommitMetadataHeight(splitter, height) {
  const details = splitter.closest('.commit-detail');
  const { minimum, maximum } = commitMetadataBounds(splitter);
  const next = Math.round(clamp(height, minimum, maximum));
  ui.commitMetadataHeight = next;
  details?.style.setProperty('--commit-metadata-height', `${next}px`);
  splitter.setAttribute('aria-valuemin', String(minimum));
  splitter.setAttribute('aria-valuemax', String(maximum));
  splitter.setAttribute('aria-valuenow', String(next));
  return next;
}

function finishCommitDetailResize(commit = true) {
  const resize = activeCommitDetailResize;
  if (!resize) return;
  resize.splitter.removeEventListener('pointermove', resize.move);
  resize.splitter.removeEventListener('pointerup', resize.complete);
  resize.splitter.removeEventListener('pointercancel', resize.cancel);
  if (resize.splitter.hasPointerCapture?.(resize.pointerId)) resize.splitter.releasePointerCapture?.(resize.pointerId);
  document.body.classList.remove('commit-detail-resizing');
  activeCommitDetailResize = undefined;
  if (commit) persist();
  else applyCommitMetadataHeight(resize.splitter, resize.initialHeight);
}

function startCommitDetailResize(event) {
  if (event.button !== 0 || activeCommitDetailResize) return;
  const splitter = event.currentTarget;
  const details = splitter.closest('.commit-detail');
  if (!details) return;
  event.preventDefault();
  const initialHeight = applyCommitMetadataHeight(splitter, ui.commitMetadataHeight);
  const pointerId = event.pointerId;
  const move = (pointerEvent) => {
    if (pointerEvent.pointerId !== pointerId) return;
    applyCommitMetadataHeight(splitter, details.getBoundingClientRect().bottom - pointerEvent.clientY);
  };
  const complete = (pointerEvent) => {
    if (pointerEvent.pointerId === pointerId) finishCommitDetailResize(true);
  };
  const cancel = (pointerEvent) => {
    if (pointerEvent.pointerId === pointerId) finishCommitDetailResize(false);
  };
  activeCommitDetailResize = { splitter, pointerId, initialHeight, move, complete, cancel };
  splitter.setPointerCapture?.(pointerId);
  splitter.addEventListener('pointermove', move);
  splitter.addEventListener('pointerup', complete);
  splitter.addEventListener('pointercancel', cancel);
  document.body.classList.add('commit-detail-resizing');
}

function adjustCommitMetadataHeight(event) {
  if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
  const splitter = event.currentTarget;
  const { minimum, maximum } = commitMetadataBounds(splitter);
  const step = event.shiftKey ? 24 : 12;
  const height = event.key === 'Home'
    ? minimum
    : event.key === 'End'
      ? maximum
      : ui.commitMetadataHeight + (event.key === 'ArrowUp' ? step : -step);
  event.preventDefault();
  applyCommitMetadataHeight(splitter, height);
  persist();
}

function resetCommitMetadataHeight(event) {
  applyCommitMetadataHeight(event.currentTarget, COMMIT_METADATA_DEFAULT_HEIGHT);
  persist();
}

function commitPanelBounds(splitter) {
  const content = splitter.closest('.commit-upper') || splitter.closest('.changes-content');
  const toolbarHeight = content?.querySelector('.commit-toolbar')?.getBoundingClientRect().height || 31;
  const headingHeight = content?.querySelector('.commit-changes-heading')?.getBoundingClientRect().height || 26;
  const available = content?.clientHeight || 0;
  const maximum = Math.min(COMMIT_PANEL_MAX_HEIGHT, available
    ? Math.max(COMMIT_PANEL_MIN_HEIGHT, available - toolbarHeight - headingHeight - 82)
    : COMMIT_PANEL_MAX_HEIGHT);
  return { minimum: COMMIT_PANEL_MIN_HEIGHT, maximum };
}

function applyCommitPanelHeight(splitter, height) {
  const panel = splitter.parentElement?.querySelector('.commit-panel');
  const { minimum, maximum } = commitPanelBounds(splitter);
  const next = Math.round(clamp(height, minimum, maximum));
  ui.commitPanelHeight = next;
  panel?.style.setProperty('--commit-panel-height', `${next}px`);
  splitter.setAttribute('aria-valuemin', String(minimum));
  splitter.setAttribute('aria-valuemax', String(maximum));
  splitter.setAttribute('aria-valuenow', String(next));
  return next;
}

function finishCommitPanelResize(commit = true) {
  const resize = activeCommitPanelResize;
  if (!resize) return;
  resize.splitter.removeEventListener('pointermove', resize.move);
  resize.splitter.removeEventListener('pointerup', resize.complete);
  resize.splitter.removeEventListener('pointercancel', resize.cancel);
  if (resize.splitter.hasPointerCapture?.(resize.pointerId)) resize.splitter.releasePointerCapture?.(resize.pointerId);
  document.body.classList.remove('commit-panel-resizing');
  activeCommitPanelResize = undefined;
  if (commit) persist();
  else applyCommitPanelHeight(resize.splitter, resize.initialHeight);
}

function startCommitPanelResize(event) {
  if (event.button !== 0 || activeCommitPanelResize) return;
  const splitter = event.currentTarget;
  const content = splitter.closest('.changes-content');
  if (!content) return;
  event.preventDefault();
  const initialHeight = applyCommitPanelHeight(splitter, ui.commitPanelHeight);
  const pointerId = event.pointerId;
  const move = (pointerEvent) => {
    if (pointerEvent.pointerId !== pointerId) return;
    applyCommitPanelHeight(splitter, content.getBoundingClientRect().bottom - pointerEvent.clientY);
  };
  const complete = (pointerEvent) => {
    if (pointerEvent.pointerId === pointerId) finishCommitPanelResize(true);
  };
  const cancel = (pointerEvent) => {
    if (pointerEvent.pointerId === pointerId) finishCommitPanelResize(false);
  };
  activeCommitPanelResize = { splitter, pointerId, initialHeight, move, complete, cancel };
  splitter.setPointerCapture?.(pointerId);
  splitter.addEventListener('pointermove', move);
  splitter.addEventListener('pointerup', complete);
  splitter.addEventListener('pointercancel', cancel);
  document.body.classList.add('commit-panel-resizing');
}

function adjustCommitPanelHeight(event) {
  if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
  const { minimum, maximum } = commitPanelBounds(event.currentTarget);
  const step = event.shiftKey ? 24 : 12;
  const height = event.key === 'Home'
    ? minimum
    : event.key === 'End'
      ? maximum
      : ui.commitPanelHeight + (event.key === 'ArrowUp' ? step : -step);
  event.preventDefault();
  applyCommitPanelHeight(event.currentTarget, height);
  persist();
}

function resetCommitPanelHeight(event) {
  applyCommitPanelHeight(event.currentTarget, COMMIT_PANEL_DEFAULT_HEIGHT);
  persist();
}

function applyCommitZonePercent(splitter, percent) {
  const next = Math.round(clamp(percent, 35, 75));
  ui.commitZonePercent = next;
  splitter.parentElement?.querySelector('.commit-upper')?.style.setProperty('flex-basis', `${next}%`);
  splitter.setAttribute('aria-valuenow', String(next));
  return next;
}

function finishCommitZoneResize(save = true) {
  const resize = activeCommitZoneResize;
  if (!resize) return;
  resize.splitter.removeEventListener('pointermove', resize.move);
  resize.splitter.removeEventListener('pointerup', resize.complete);
  resize.splitter.removeEventListener('pointercancel', resize.cancel);
  if (resize.splitter.hasPointerCapture?.(resize.pointerId)) resize.splitter.releasePointerCapture?.(resize.pointerId);
  document.body.classList.remove('commit-zone-resizing');
  activeCommitZoneResize = undefined;
  if (save) persist();
  else applyCommitZonePercent(resize.splitter, resize.initialPercent);
}

function startCommitZoneResize(event) {
  if (event.button !== 0 || activeCommitZoneResize) return;
  const splitter = event.currentTarget;
  const content = splitter.closest('.commit-upper') || splitter.closest('.changes-content');
  if (!content?.clientHeight) return;
  event.preventDefault();
  const initialPercent = ui.commitZonePercent;
  const startY = event.clientY;
  const move = (pointerEvent) => {
    if (pointerEvent.pointerId !== event.pointerId) return;
    applyCommitZonePercent(splitter, initialPercent + (pointerEvent.clientY - startY) * 100 / content.clientHeight);
  };
  const complete = (pointerEvent) => { if (pointerEvent.pointerId === event.pointerId) finishCommitZoneResize(true); };
  const cancel = (pointerEvent) => { if (pointerEvent.pointerId === event.pointerId) finishCommitZoneResize(false); };
  activeCommitZoneResize = { splitter, pointerId: event.pointerId, initialPercent, move, complete, cancel };
  splitter.setPointerCapture?.(event.pointerId);
  splitter.addEventListener('pointermove', move);
  splitter.addEventListener('pointerup', complete);
  splitter.addEventListener('pointercancel', cancel);
  document.body.classList.add('commit-zone-resizing');
}

function adjustCommitZonePercent(event) {
  if (!['ArrowUp', 'ArrowDown', 'Home'].includes(event.key)) return;
  event.preventDefault();
  applyCommitZonePercent(event.currentTarget, event.key === 'Home' ? COMMIT_ZONE_DEFAULT_PERCENT : ui.commitZonePercent + (event.key === 'ArrowDown' ? 3 : -3));
  persist();
}

function renderBranchPopup(s) {
  const query = ui.branchQuery.trim().toLowerCase();
  const filtered = s.branches.filter((branch) => branch.name.toLowerCase().includes(query));
  const local = filtered.filter((branch) => !branch.remote);
  const remote = filtered.filter((branch) => branch.remote);
  const rows = (items) => items.map((branch) => `<button class="branch-row ${branch.current ? 'current' : ''}" data-checkout="${escapeHtml(branch.name)}" data-remote="${branch.remote}" ${ui.busy ? 'disabled' : ''}>
      ${icon(branch.current ? 'check' : branch.remote ? 'cloud' : 'git-branch')}<span class="branch-row-name">${escapeHtml(branch.name)}</span>${branch.tracking ? `<small>${escapeHtml(branch.tracking)}</small>` : ''}
    </button>`).join('');
  const popupGroup = (key, label, items) => {
    const count = ui.branchPopupVisibleCounts[key];
    const visible = items.slice(0, count);
    const remaining = Math.max(0, items.length - visible.length);
    return `<section class="branch-popup-group"><h3>${label}<span>${items.length}</span></h3>${rows(visible) || `<p class="no-results">No ${label.toLowerCase()}</p>`}${remaining ? `<button class="branch-popup-more" data-branch-popup-more="${key}">Show ${Math.min(BRANCH_PAGE_SIZE, remaining)} more</button>` : ''}</section>`;
  };
  return `<div class="branch-overlay ${ui.branchOpen ? 'open' : ''}" ${ui.branchOpen ? '' : 'inert'} aria-hidden="${!ui.branchOpen}"><div class="scrim" data-action="close-branches"></div><aside class="branch-popup" role="dialog" aria-modal="true" aria-label="Git branches">
    <div class="popup-title"><strong>Git Branches</strong><button class="icon-button" aria-label="Close branches" data-action="close-branches">${icon('close')}</button></div>
    <div class="search-wrap">${icon('search')}<input id="branch-search" aria-label="Search branches" placeholder="Search branches" value="${escapeHtml(ui.branchQuery)}"></div>
    <div class="branch-groups">${popupGroup('local', 'LOCAL BRANCHES', local)}${popupGroup('remote', 'REMOTE BRANCHES', remote)}</div>
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
  bindContextMenuDelegation();
  once('[data-action]', 'click', (event) => handleAction(event.currentTarget.dataset.action));
  once('[data-file-menu]', 'click', (event) => openFileContextMenu(event, event.currentTarget.closest('[data-file-row]')));
  once('[data-graph-list]', 'scroll', onGraphScroll);
  bindGraphViewport();
  once('[data-commit]', 'click', (event) => selectCommit(event.currentTarget.dataset.commit));
  once('[data-recent-commit]', 'click', (event) => post('showRecentCommit', { hash: event.currentTarget.dataset.recentCommit }));
  once('[data-commit]', 'keydown', (event) => {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      const bounds = event.currentTarget.getBoundingClientRect();
      openCommitContextMenu({
        preventDefault: () => event.preventDefault(),
        stopPropagation: () => event.stopPropagation(),
        clientX: bounds.left + Math.min(48, bounds.width / 2),
        clientY: bounds.top + Math.min(bounds.height, 24)
      }, event.currentTarget);
      return;
    }
    if (['Enter', ' '].includes(event.key)) {
      event.preventDefault();
      event.currentTarget.click();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const commits = graphCommits();
    if (!commits.length) return;
    event.preventDefault();
    const current = commits.findIndex((commit) => commit.hash === event.currentTarget.dataset.commit);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? commits.length - 1 : current + (event.key === 'ArrowDown' ? 1 : -1);
    const target = commits[Math.max(0, Math.min(commits.length - 1, next))];
    if (target && target.hash !== event.currentTarget.dataset.commit) selectCommit(target.hash, { focus: true, immediate: false });
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
      reconcileHistorySelection();
      persist();
      render();
      requestOlderHistoryForHash();
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
      reconcileHistorySelection();
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
      ui.branchVisibleCounts = { local: BRANCH_PAGE_SIZE, remote: BRANCH_PAGE_SIZE, tags: BRANCH_PAGE_SIZE };
      persist();
      render();
      requestAnimationFrame(() => {
        const input = app.querySelector('#log-branch-search');
        input?.focus();
        input?.setSelectionRange(ui.logBranchQuery.length, ui.logBranchQuery.length);
      });
    });
  }
  const changeSearch = app.querySelector('#change-search');
  if (changeSearch && !changeSearch.__ideaGitListeners) {
    changeSearch.__ideaGitListeners = new Set(['changed-file-search']);
    changeSearch.addEventListener('input', () => {
      ui.changeQuery = changeSearch.value;
      persist();
      render();
      requestAnimationFrame(() => {
        const input = app.querySelector('#change-search');
        input?.focus();
        input?.setSelectionRange(ui.changeQuery.length, ui.changeQuery.length);
      });
    });
    changeSearch.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      ui.changeQuery = '';
      ui.changeKindFilter = 'all';
      ui.changeSearchOpen = false;
      persist();
      render();
      app.querySelector('[data-action="search-changes"]')?.focus();
    });
  }
  const changeKindFilter = app.querySelector('#change-kind-filter');
  if (changeKindFilter && !changeKindFilter.__ideaGitListeners) {
    changeKindFilter.__ideaGitListeners = new Set(['changed-file-kind-filter']);
    changeKindFilter.addEventListener('change', () => {
      ui.changeKindFilter = changeKindFilter.value;
      persist();
      render();
      requestAnimationFrame(() => app.querySelector('#change-kind-filter')?.focus());
    });
  }
  once('[data-branch-group]', 'click', (event) => {
    const group = event.currentTarget.dataset.branchGroup;
    if (!group || ui.logBranchQuery.trim()) return;
    ui.branchGroupsExpanded[group] = !ui.branchGroupsExpanded[group];
    persist();
    render();
    requestAnimationFrame(() => app.querySelector(`[data-branch-group="${group}"]`)?.focus());
  });
  once('[data-log-folder-toggle]', 'click', (event) => {
    const folder = event.currentTarget.dataset.logFolderToggle;
    if (!folder || ui.logBranchQuery.trim()) return;
    if (ui.collapsedLogBranchFolders.has(folder)) ui.collapsedLogBranchFolders.delete(folder);
    else ui.collapsedLogBranchFolders.add(folder);
    persist();
    render();
    requestAnimationFrame(() => app.querySelector(`[data-log-folder-toggle="${CSS.escape(folder)}"]`)?.focus());
  });
  once('[data-branch-more]', 'click', (event) => {
    const group = event.currentTarget.dataset.branchMore;
    if (!group) return;
    ui.branchVisibleCounts[group] = (ui.branchVisibleCounts[group] || BRANCH_PAGE_SIZE) + BRANCH_PAGE_SIZE;
    render();
    requestAnimationFrame(() => (app.querySelector(`[data-branch-more="${group}"]`) || app.querySelector(`[data-branch-group="${group}"]`))?.focus());
  });
  once('[data-graph-filter]', 'change', (event) => {
    const select = event.currentTarget;
    if (select.dataset.graphFilter === 'branch') {
      setHistoryRef(select.value);
      requestAnimationFrame(() => app.querySelector('[data-graph-filter="branch"]')?.focus());
      return;
    }
    if (select.dataset.graphFilter === 'author') ui.graphAuthorFilter = select.value;
    if (select.dataset.graphFilter === 'age') ui.graphAgeFilter = select.value || 'all';
    reconcileHistorySelection();
    persist();
    render();
  });
  once('[data-log-branch]', 'click', (event) => {
    setHistoryRef(event.currentTarget.dataset.logBranch || '');
  });
  once('[data-log-branch]', 'keydown', (event) => {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    openBranchContextMenu({
      preventDefault: () => event.preventDefault(),
      stopPropagation: () => event.stopPropagation(),
      clientX: bounds.left + Math.min(48, bounds.width / 2),
      clientY: bounds.bottom
    }, event.currentTarget);
  });
  once('[data-branch-context-action]', 'click', runBranchContextAction);
  once('[data-commit-context-action]', 'click', runCommitContextAction);
  once('[data-file-context-action]', 'click', runFileContextAction);
  once('.context-menu', 'keydown', (event) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const items = [...event.currentTarget.querySelectorAll('button:not(:disabled)')];
    const current = items.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[Math.max(0, next)]?.focus();
  });
  once('[data-log-splitter]', 'pointerdown', startLogResize);
  once('[data-log-splitter]', 'dblclick', resetLogBranchWidth);
  once('[data-log-splitter]', 'keydown', adjustLogBranchWidth);
  once('[data-log-detail-splitter]', 'pointerdown', startLogDetailResize);
  once('[data-log-detail-splitter]', 'dblclick', resetLogDetailSize);
  once('[data-log-detail-splitter]', 'keydown', adjustLogDetailSize);
  once('[data-commit-detail-splitter]', 'pointerdown', startCommitDetailResize);
  once('[data-commit-detail-splitter]', 'dblclick', resetCommitMetadataHeight);
  once('[data-commit-detail-splitter]', 'keydown', adjustCommitMetadataHeight);
  once('[data-commit-panel-splitter]', 'pointerdown', startCommitPanelResize);
  once('[data-commit-panel-splitter]', 'dblclick', resetCommitPanelHeight);
  once('[data-commit-panel-splitter]', 'keydown', adjustCommitPanelHeight);
  once('[data-commit-zone-splitter]', 'pointerdown', startCommitZoneResize);
  once('[data-commit-zone-splitter]', 'dblclick', (event) => { applyCommitZonePercent(event.currentTarget, COMMIT_ZONE_DEFAULT_PERCENT); persist(); });
  once('[data-commit-zone-splitter]', 'keydown', adjustCommitZonePercent);
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
    input.dataset.selectionRange = String(event.shiftKey);
  });
  once('[data-select]', 'change', (event) => {
    const input = event.currentTarget;
    const range = input.dataset.selectionRange === 'true';
    delete input.dataset.selectionRange;
    setSelection(input.dataset.select, input.checked, range);
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
    if (!event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.key.toLowerCase() === 'm') {
      event.preventDefault();
      if (ui.busy) return;
      const paths = ui.selected.has(button.dataset.diff) ? [...ui.selected] : [button.dataset.diff];
      post('moveSelectedFilesToChangelist', { paths });
      return;
    }
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      ui.changeSearchOpen = true;
      render();
      requestAnimationFrame(() => app.querySelector('#change-search')?.focus());
      return;
    }
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      for (const path of orderedPaths()) ui.selected.add(path);
      focusFile(button.dataset.diff);
      return;
    }
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      const bounds = button.getBoundingClientRect();
      openFileContextMenu({
        preventDefault: () => event.preventDefault(),
        stopPropagation: () => event.stopPropagation(),
        clientX: bounds.left + Math.min(48, bounds.width / 2),
        clientY: bounds.bottom,
        currentTarget: button
      }, button.closest('[data-file-row]'));
      return;
    }
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
      textarea.addEventListener('input', () => {
        ui.commitMessage = textarea.value;
        persist();
        syncCommitActionState();
      });
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
      ui.branchPopupVisibleCounts = { local: BRANCH_PAGE_SIZE, remote: BRANCH_PAGE_SIZE };
      render();
      requestAnimationFrame(() => {
        const input = app.querySelector('#branch-search');
        input?.focus();
        input?.setSelectionRange(ui.branchQuery.length, ui.branchQuery.length);
      });
    });
    search.addEventListener('keydown', (event) => {
      if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
      event.preventDefault();
      const rows = [...app.querySelectorAll('[data-checkout]:not([hidden])')];
      (event.key === 'ArrowDown' ? rows[0] : rows.at(-1))?.focus();
    });
  }
  once('[data-checkout]', 'keydown', (event) => {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      const bounds = event.currentTarget.getBoundingClientRect();
      openBranchContextMenu({
        preventDefault: () => event.preventDefault(),
        stopPropagation: () => event.stopPropagation(),
        clientX: bounds.left + Math.min(48, bounds.width / 2),
        clientY: bounds.bottom
      }, event.currentTarget);
      return;
    }
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    const rows = [...app.querySelectorAll('[data-checkout]:not([hidden])')];
    const next = rows.indexOf(event.currentTarget) + (event.key === 'ArrowDown' ? 1 : -1);
    (rows[next] || app.querySelector('#branch-search'))?.focus();
  });
  once('[data-branch-popup-more]', 'click', (event) => {
    const group = event.currentTarget.dataset.branchPopupMore;
    if (!group) return;
    ui.branchPopupVisibleCounts[group] = (ui.branchPopupVisibleCounts[group] || BRANCH_PAGE_SIZE) + BRANCH_PAGE_SIZE;
    render();
    requestAnimationFrame(() => (app.querySelector(`[data-branch-popup-more="${group}"]`) || app.querySelector('#branch-search'))?.focus());
  });
}

function handleAction(action) {
  if (action === 'refresh') post('refresh');
  if (action === 'show-log') post('showLog');
  if (action === 'show-changes') post('showChanges');
  if (action === 'open-settings') post('openSettings');
  if (action === 'save-detached-head' && !ui.busy && ui.snapshot?.branch === '(detached)') {
    post('createBranch', { startPoint: ui.snapshot.headOid || 'HEAD' });
  }
  if ((action === 'fetch' || action === 'push') && !ui.busy && ui.syncPhase !== 'fetching') post(action);
  if (action === 'pull-menu' && !ui.busy && ui.syncPhase !== 'fetching') {
    ui.pullMenuOpen = !ui.pullMenuOpen;
    render();
    if (ui.pullMenuOpen) requestAnimationFrame(() => app.querySelector('[data-pull-strategy]:not(:disabled)')?.focus());
  }
  if (action === 'load-more-commits') requestMoreHistory(ui.graphScrollTop);
  if (action === 'clear-graph-filters') {
    ui.graphQuery = '';
    ui.graphPathFilter = '';
    const hadRef = Boolean(ui.graphBranchFilter);
    ui.graphBranchFilter = '';
    ui.graphAuthorFilter = '';
    ui.graphAgeFilter = 'all';
    if (hadRef) {
      ui.historyRefLoading = true;
      ui.selectedCommitHash = undefined;
      ui.commitDetails = undefined;
      post('setHistoryRef', { branch: '' });
    } else reconcileHistorySelection();
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
  if (action === 'search-changes') {
    ui.changeSearchOpen = !ui.changeSearchOpen;
    if (!ui.changeSearchOpen) {
      ui.changeQuery = '';
      ui.changeKindFilter = 'all';
      persist();
    }
    render();
    requestAnimationFrame(() => {
      if (ui.changeSearchOpen) app.querySelector('#change-search')?.focus();
      else app.querySelector('[data-action="search-changes"]')?.focus();
    });
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

function syncCommitActionState() {
  const enabled = Boolean(ui.selected.size && ui.commitMessage.trim() && !ui.busy);
  const messageCheck = app.querySelector('[data-commit-message-check]');
  if (messageCheck) {
    const ready = Boolean(ui.commitMessage.trim());
    messageCheck.classList.toggle('pending', !ready);
    messageCheck.innerHTML = `${icon(ready ? 'check' : 'circle-outline')} ${ready ? 'Message ready' : 'Message needed'}`;
  }
  const hint = ui.busy ? 'A Git operation is in progress' : !ui.selected.size ? 'Select at least one changed file' : !ui.commitMessage.trim() ? 'Write a commit message' : undefined;
  for (const button of app.querySelectorAll('[data-action="commit"], [data-action="commit-and-push"]')) {
    button.disabled = !enabled;
    button.title = hint || (button.dataset.action === 'commit' ? `Commit selected files (${commandKey}+Enter)` : 'Commit selected files and push');
  }
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
  if (message.type === 'revealCommit' && surface === 'history') {
    ui.graphBranchFilter = '';
    ui.graphPathFilter = '';
    ui.graphQuery = '';
    ui.graphAuthorFilter = '';
    ui.graphAgeFilter = 'all';
    selectCommit(message.hash, { focus: true });
  }
  if (message.type === 'applyPathFilter') {
    ui.graphPathFilter = message.path || '';
    ui.graphBranchFilter = '';
    ui.graphAuthorFilter = '';
    ui.graphAgeFilter = 'all';
    ui.graphQuery = '';
    ui.graphScrollTop = 0;
    ui.historyRefLoading = true;
    ui.selectedCommitHash = undefined;
    ui.commitDetails = undefined;
    persist();
    render();
    post('setHistoryRef', { branch: '' });
    restoreGraphScroll(0);
    requestAnimationFrame(() => app.querySelector('#graph-path')?.focus());
  }
  if (message.type === 'applyBranchFilter') {
    ui.graphBranchFilter = message.branch || '';
    ui.graphPathFilter = '';
    ui.graphQuery = '';
    ui.graphAuthorFilter = '';
    ui.graphAgeFilter = 'all';
    ui.graphScrollTop = 0;
    ui.historyRefLoading = true;
    ui.selectedCommitHash = undefined;
    ui.commitDetails = undefined;
    persist();
    render();
    post('setHistoryRef', { branch: ui.graphBranchFilter });
    restoreGraphScroll(0);
    requestAnimationFrame(() => app.querySelector('[data-graph-filter="branch"]')?.focus());
  }
  if (message.type === 'revealFile') {
    const filePath = message.path;
    const list = ui.snapshot?.changelists.find((candidate) => candidate.changes.some((change) => change.path === filePath));
    if (list) ui.collapsed.delete(list.id);
    ui.focusedPath = filePath;
    persist();
    render();
    requestAnimationFrame(() => {
      const row = [...app.querySelectorAll('[data-file-row]')].find((item) => item.dataset.path === filePath);
      row?.scrollIntoView({ block: 'center' });
      row?.querySelector('[data-diff]')?.focus();
    });
  }
  if (message.type === 'fileIconCss') {
    const style = document.querySelector('#kivo-file-icon-fonts');
    if (style) style.textContent = typeof message.css === 'string' ? message.css : '';
  }
  if (message.type === 'snapshot') {
    const fingerprint = JSON.stringify(message.payload);
    if (fingerprint === lastSnapshot && !ui.historyRefLoading && !ui.graphLoadingMore) return;
    const previousRoot = ui.snapshot?.root;
    const nextRoot = message.payload.root;
    if (previousRoot && previousRoot !== nextRoot) saveRepositoryState(previousRoot);
    if (previousRoot !== nextRoot) {
      const nextState = repositoryStates[nextRoot] || (!previousRoot ? legacyRepositoryState : undefined) || {};
      restoreRepositoryState(nextRoot, nextState);
    }
    lastSnapshot = fingerprint;
    ui.emptyMessage = undefined;
    ui.snapshot = message.payload;
    ui.graphLoadingMore = false;
    ui.historyRefLoading = false;
    if (ui.selectedCommitHash && !message.payload.commits.some((commit) => commit.hash === ui.selectedCommitHash)) {
      clearTimeout(commitDetailTimer);
      ui.selectedCommitHash = undefined;
      ui.focusedCommitHash = undefined;
      ui.commitDetails = undefined;
      ui.commitDetailsError = undefined;
      ui.commitDetailsLoading = false;
    }
    reconcileHistorySelection();
    const valid = new Set(message.payload.changes.map((change) => change.path));
    ui.selected = new Set([...ui.selected].filter((path) => valid.has(path)));
    if (!valid.has(ui.focusedPath)) ui.focusedPath = message.payload.changes[0]?.path;
    persist();
    render();
    restoreGraphScroll(ui.graphScrollTop);
    requestOlderHistoryForHash();
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
  if (message.type === 'empty') {
    persist();
    ui.snapshot = undefined;
    ui.emptyMessage = message.message;
    ui.graphLoadingMore = false;
    lastSnapshot = '';
    render();
  }
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
  if (activeLogDetailResize) {
    event.preventDefault();
    finishLogDetailResize(false);
    return;
  }
  if (activeCommitDetailResize) {
    event.preventDefault();
    finishCommitDetailResize(false);
    return;
  }
  if (activeCommitPanelResize) {
    event.preventDefault();
    finishCommitPanelResize(false);
    return;
  }
  if (activeCommitZoneResize) {
    event.preventDefault();
    finishCommitZoneResize(false);
    return;
  }
  if (ui.branchContextMenu) {
    event.preventDefault();
    const { ref, fromPopup } = ui.branchContextMenu;
    ui.branchContextMenu = undefined;
    render();
    requestAnimationFrame(() => {
      const selector = fromPopup ? '[data-checkout]' : '[data-log-branch]';
      [...app.querySelectorAll(selector)].find((row) => (row.dataset.branchRef || row.dataset.checkout) === ref)?.focus();
    });
    return;
  }
  if (ui.commitContextMenu) {
    event.preventDefault();
    const hash = ui.commitContextMenu.hash;
    ui.commitContextMenu = undefined;
    render();
    requestAnimationFrame(() => [...app.querySelectorAll('[data-commit]')].find((row) => row.dataset.commit === hash)?.focus());
    return;
  }
  if (ui.fileContextMenu) {
    event.preventDefault();
    const { path, returnFocus } = ui.fileContextMenu;
    ui.fileContextMenu = undefined;
    render();
    requestAnimationFrame(() => {
      const row = [...app.querySelectorAll('[data-file-row]')].find((item) => item.dataset.path === path);
      row?.querySelector(returnFocus === 'menu' ? '[data-file-menu]' : '[data-diff]')?.focus();
    });
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

function closeContextMenusOutside(target) {
  const element = target instanceof Element ? target : target?.parentElement;
  let closed = false;
  if (ui.branchContextMenu && !element?.closest('[data-branch-context]')) {
    ui.branchContextMenu = undefined;
    closed = true;
  }
  if (ui.commitContextMenu && !element?.closest('[data-commit-context]')) {
    ui.commitContextMenu = undefined;
    closed = true;
  }
  if (ui.fileContextMenu && !element?.closest('[data-file-context]')) {
    ui.fileContextMenu = undefined;
    closed = true;
  }
  if (closed) render();
  return closed;
}

document.addEventListener('pointerdown', (event) => {
  closeContextMenusOutside(event.target);
}, true);

document.addEventListener('click', (event) => {
  if (closeContextMenusOutside(event.target)) return;
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

post('ready', { historyRef: surface === 'history' ? ui.graphBranchFilter : undefined });
render();
