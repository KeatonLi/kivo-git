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
const COMMIT_PANEL_MIN_HEIGHT = 176;
const COMMIT_PANEL_MAX_HEIGHT = 260;
const COMMIT_PANEL_LEGACY_DEFAULT_HEIGHT = 188;
const COMMIT_PANEL_DEFAULT_HEIGHT = 188;
// Recent commits fit their contents until the user explicitly resizes the split.
const COMMIT_ZONE_DEFAULT_PERCENT = 65;
const BRANCH_PAGE_SIZE = 36;
const GRAPH_MAX_WIDTH = 176;
const GRAPH_MIN_WIDTH = 64;
const GRAPH_ROW_HEIGHT = 30;
const GRAPH_BOTTOM_EPSILON = 2;
const GRAPH_VIRTUAL_OVERSCAN = 12;
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const restoredBranchWidth = Number(initialRepositoryState.logBranchWidth);
const restoredDetailWidth = Number(initialRepositoryState.logDetailWidth);
const restoredDetailHeight = Number(initialRepositoryState.logDetailHeight);
const restoredCommitMetadataHeight = Number(initialRepositoryState.commitMetadataHeight);
const restoredCommitPanelHeight = Number(initialRepositoryState.commitPanelHeight);
const hasCustomCommitSplit = (state) => state.commitZoneResized === true
  || (state.commitZoneResized === undefined && Number.isFinite(Number(state.commitZonePercent))
    && Number(state.commitZonePercent) !== COMMIT_ZONE_DEFAULT_PERCENT);

const ui = {
  snapshot: undefined,
  emptyMessage: undefined,
  selected: new Set(initialRepositoryState.selected || []),
  collapsed: new Set(initialRepositoryState.collapsed || []),
  branchOpen: false,
  toolbarMenuOpen: false,
  branchQuery: '',
  changeQuery: initialRepositoryState.changeQuery || '',
  changeFilter: initialRepositoryState.changeFilter || initialRepositoryState.changeKindFilter || 'all',
  changeSearchOpen: false,
  logBranchQuery: initialRepositoryState.logBranchQuery || '',
  historyFocusMode: initialRepositoryState.historyFocusMode === true,
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
  commitZoneResized: hasCustomCommitSplit(initialRepositoryState),
  recentCommitsCollapsed: initialRepositoryState.recentCommitsCollapsed === true,
  recentSelectedHash: undefined,
  recentDetails: undefined,
  recentDetailsLoading: false,
  recentDetailsError: undefined,
  recentRequestId: 0,
  recentDetailsCache: new Map(),
  branchGroupsExpanded: {
    local: initialRepositoryState.branchGroupsExpanded?.local !== false,
    remote: initialRepositoryState.branchGroupsExpanded?.remote !== false,
    tags: initialRepositoryState.branchGroupsExpanded?.tags === true
  },
  collapsedLogBranchFolders: new Set(initialRepositoryState.collapsedLogBranchFolders || []),
  branchVisibleCounts: { local: BRANCH_PAGE_SIZE, remote: BRANCH_PAGE_SIZE, tags: BRANCH_PAGE_SIZE },
  branchPopupVisibleCounts: { local: BRANCH_PAGE_SIZE, remote: BRANCH_PAGE_SIZE },
  branchPopupRemoteExpanded: false,
  busy: false,
  operationKind: undefined,
  operationId: 0,
  syncPhase: 'idle',
  lastFetchedAt: undefined,
  syncError: undefined,
  branchContextMenu: undefined,
  commitContextMenu: undefined,
  fileContextMenu: undefined,
  listMenuId: undefined,
  focusedPath: initialRepositoryState.focusedPath,
  selectionAnchor: undefined,
  commitMessage: initialRepositoryState.commitMessage || '',
  commitReviewOpen: false,
  pushReview: undefined,
  pushSelectedHash: undefined,
  pushDetails: undefined,
  pushDetailsLoading: false,
  pushDetailsError: undefined,
  pushDetailsRequestId: 0,
  pushDetailsCache: new Map(),
  commitReviewAndPush: false,
  graphQuery: initialRepositoryState.graphQuery || '',
  pendingRevealHash: undefined,
  graphPathFilter: initialRepositoryState.graphPathFilter || '',
  graphBranchFilter: initialRepositoryState.graphBranchFilter || '',
  graphAuthorFilter: initialRepositoryState.graphAuthorFilter || '',
  graphAgeFilter: initialRepositoryState.graphAgeFilter || 'all',
  graphLoadingMore: false,
  historySearch: undefined,
  historySearchLoading: false,
  historySearchRequestId: 0,
  historySearchLimit: 80,
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
let historySearchTimer;
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
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const runningMotion = new Set();
const elementMotion = new WeakMap();

function motionEnabled() { return !reducedMotion.matches && !document.hidden; }

function playMotion(element, frames, options) {
  if (!element || !motionEnabled()) return;
  elementMotion.get(element)?.cancel();
  const animation = element.animate(frames, options);
  elementMotion.set(element, animation);
  runningMotion.add(animation);
  const cleanup = () => {
    runningMotion.delete(animation);
    if (elementMotion.get(element) === animation) elementMotion.delete(element);
  };
  animation.finished.then(cleanup, cleanup);
}

function stopMotion() {
  for (const animation of runningMotion) animation.cancel();
  runningMotion.clear();
}
reducedMotion.addEventListener('change', () => { if (reducedMotion.matches) stopMotion(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) stopMotion(); });

function changelistMovement(before, after, viewportHeight) {
  if (!before || before.listId === after.listId || !before.width || !before.height || !after.width || !after.height) return undefined;
  const x = before.left - after.left;
  const y = before.top - after.top;
  return (x || y) && Math.abs(y) < viewportHeight ? { x, y } : undefined;
}
const commandKey = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

const escapeHtml = (value = '') => String(value)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#039;');

const iconFor = (kind) => ({ modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: '?', conflict: '!' })[kind] || 'M';
const describeFileState = (status) => ({ '.': 'unchanged', M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', U: 'conflicted', '?': 'untracked' })[status] || 'changed';
function fileStateTitle(change) {
  if (change.kind === 'untracked') return 'New file · Git is not tracking it yet';
  return `Staged: ${describeFileState(change.indexStatus)} · Unstaged: ${describeFileState(change.workingTreeStatus)}`;
}
function fileStateSummary(change) {
  if (change.kind === 'conflict') return 'Conflict';
  if (change.kind === 'untracked') return 'New file';
  if (change.indexStatus !== '.' && change.workingTreeStatus !== '.') return 'Staged + edits';
  if (change.indexStatus !== '.') return 'Staged';
  return ({ deleted: 'Deleted', renamed: 'Renamed', added: 'Added' })[change.kind] || 'Modified';
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
const absoluteTime = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (part) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
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
    changeFilter: ui.changeFilter,
    changeSearchOpen: ui.changeSearchOpen,
    commitMessage: ui.commitMessage,
    graphQuery: ui.graphQuery,
    graphPathFilter: ui.graphPathFilter,
    graphBranchFilter: ui.graphBranchFilter,
    graphAuthorFilter: ui.graphAuthorFilter,
    graphAgeFilter: ui.graphAgeFilter,
    logBranchQuery: ui.logBranchQuery,
    historyFocusMode: ui.historyFocusMode,
    logBranchWidth: ui.logBranchWidth,
    logDetailWidth: ui.logDetailWidth,
    logDetailHeight: ui.logDetailHeight,
    commitMetadataHeight: ui.commitMetadataHeight,
    commitPanelHeight: ui.commitPanelHeight,
    commitZonePercent: ui.commitZonePercent,
    commitZoneResized: ui.commitZoneResized,
    recentCommitsCollapsed: ui.recentCommitsCollapsed,
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
  const savedChangeFilter = state.changeFilter || state.changeKindFilter;
  ui.changeFilter = ['all', 'staged', 'worktree', 'modified', 'added', 'deleted', 'renamed', 'untracked', 'conflict'].includes(savedChangeFilter)
    ? savedChangeFilter
    : 'all';
  ui.changeSearchOpen = state.changeSearchOpen === true;
  ui.selectionAnchor = undefined;
  ui.commitMessage = state.commitMessage || '';
  ui.commitReviewOpen = false;
  ui.pushReview = undefined;
  clearPushCommitPreview(true);
  ui.commitReviewAndPush = false;
  ui.graphQuery = state.graphQuery || '';
  ui.graphPathFilter = state.graphPathFilter || '';
  ui.graphBranchFilter = state.graphBranchFilter || '';
  ui.graphAuthorFilter = state.graphAuthorFilter || '';
  ui.graphAgeFilter = state.graphAgeFilter || 'all';
  ui.logBranchQuery = state.logBranchQuery || '';
  ui.historyFocusMode = state.historyFocusMode === true;
  ui.logBranchWidth = Number.isFinite(branchWidth) ? clamp(branchWidth, LOG_BRANCH_MIN_WIDTH, LOG_BRANCH_MAX_WIDTH) : LOG_BRANCH_DEFAULT_WIDTH;
  ui.logDetailWidth = Number.isFinite(detailWidth) ? clamp(detailWidth, LOG_DETAIL_MIN_WIDTH, LOG_DETAIL_MAX_WIDTH) : LOG_DETAIL_DEFAULT_WIDTH;
  ui.logDetailHeight = Number.isFinite(detailHeight) ? Math.max(LOG_DETAIL_MIN_HEIGHT, detailHeight) : LOG_DETAIL_DEFAULT_HEIGHT;
  ui.commitMetadataHeight = Number.isFinite(metadataHeight) ? Math.max(COMMIT_METADATA_MIN_HEIGHT, metadataHeight) : COMMIT_METADATA_DEFAULT_HEIGHT;
  ui.commitPanelHeight = Number.isFinite(panelHeight)
    ? clamp(panelHeight === COMMIT_PANEL_LEGACY_DEFAULT_HEIGHT ? COMMIT_PANEL_DEFAULT_HEIGHT : panelHeight, COMMIT_PANEL_MIN_HEIGHT, COMMIT_PANEL_MAX_HEIGHT)
    : COMMIT_PANEL_DEFAULT_HEIGHT;
  ui.commitZonePercent = clamp(Number(state.commitZonePercent) || COMMIT_ZONE_DEFAULT_PERCENT, 35, 75);
  ui.commitZoneResized = hasCustomCommitSplit(state);
  ui.recentCommitsCollapsed = state.recentCommitsCollapsed === true;
  clearRecentCommitPreview(true);
  ui.branchGroupsExpanded = {
    local: state.branchGroupsExpanded?.local !== false,
    remote: state.branchGroupsExpanded?.remote !== false,
    tags: state.branchGroupsExpanded?.tags === true
  };
  ui.collapsedLogBranchFolders = new Set(state.collapsedLogBranchFolders || []);
  ui.branchVisibleCounts = { local: BRANCH_PAGE_SIZE, remote: BRANCH_PAGE_SIZE, tags: BRANCH_PAGE_SIZE };
  ui.branchPopupVisibleCounts = { local: BRANCH_PAGE_SIZE, remote: BRANCH_PAGE_SIZE };
  ui.branchPopupRemoteExpanded = false;
  ui.graphScrollTop = Number(state.graphScrollTop) || 0;
  ui.graphViewportWidth = 0;
  ui.graphViewportHeight = 0;
  ui.historyRefLoading = false;
  ui.historySearch = undefined;
  ui.historySearchLoading = false;
  ui.historySearchLimit = 80;
  clearTimeout(historySearchTimer);
  ui.selectedCommitHash = state.selectedCommitHash;
  ui.focusedCommitHash = state.focusedCommitHash || state.selectedCommitHash;
  ui.commitDetailsDismissed = state.commitDetailsDismissed || false;
  ui.commitDetails = undefined;
  ui.commitDetailsLoading = false;
  ui.commitDetailsError = undefined;
  ui.branchOpen = false;
  ui.toolbarMenuOpen = false;
  ui.branchQuery = '';
  ui.branchContextMenu = undefined;
  ui.commitContextMenu = undefined;
  ui.fileContextMenu = undefined;
  ui.listMenuId = undefined;
  ui.pullMenuOpen = false;
  repositoryStates[root] = serializeRepositoryState();
}

function historySearchActive() {
  return Boolean(ui.graphQuery.trim() || ui.graphPathFilter.trim() || ui.graphAuthorFilter.trim() || ui.graphAgeFilter !== 'all');
}

function historySearchKey() {
  const snapshot = ui.snapshot;
  return JSON.stringify([snapshot?.root, snapshot?.commits?.[0]?.hash, snapshot?.branches?.map((branch) => `${branch.name}:${branch.oid || ''}:${branch.tracking || ''}`), ui.graphBranchFilter, ui.graphQuery.trim(), ui.graphAuthorFilter.trim(), ui.graphAgeFilter, ui.graphPathFilter.trim()]);
}

function requestHistorySearch(reset = true, delay = 160) {
  clearTimeout(historySearchTimer);
  if (surface !== 'history' || !ui.snapshot || !historySearchActive()) {
    ui.historySearch = undefined;
    ui.historySearchLoading = false;
    return;
  }
  if (reset) {
    ui.historySearchLimit = 80;
    ui.graphScrollTop = 0;
  }
  const requestId = ++ui.historySearchRequestId;
  ui.historySearchLoading = true;
  ui.historySearchError = undefined;
  if (reset) ui.historySearch = undefined;
  render();
  historySearchTimer = setTimeout(() => post('searchHistory', {
    requestId, limit: ui.historySearchLimit,
    filters: { query: ui.graphQuery, path: ui.graphPathFilter, author: ui.graphAuthorFilter, age: ui.graphAgeFilter, ref: ui.graphBranchFilter }
  }), delay);
}

function graphCommits() {
  if (historySearchActive()) return ui.historySearch?.key === historySearchKey() ? ui.historySearch.commits : [];
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
  if (surface !== 'history' || !ui.snapshot || ui.historyRefLoading || ui.historySearchLoading) return;
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
  const hasMore = historySearchActive() ? ui.historySearch?.hasMore : ui.snapshot?.commitsHasMore;
  if (!hasMore || ui.graphLoadingMore || ui.historyRefLoading || ui.historySearchLoading || ui.busy) return false;
  ui.graphLoadingMore = true;
  if (historySearchActive()) {
    ui.historySearchLimit += 80;
    requestHistorySearch(false, 0);
    restoreGraphScroll(scrollTop);
    return true;
  }
  render();
  restoreGraphScroll(scrollTop);
  post('loadMoreCommits');
  return true;
}

function requestOlderHistoryForHash() {
  if (historySearchActive()) { requestHistorySearch(true, 0); return true; }
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
  if (list.scrollHeight > list.clientHeight && scrollTop + list.clientHeight >= list.scrollHeight - GRAPH_BOTTOM_EPSILON) {
    requestMoreHistory(scrollTop);
  }
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

function changeSelection() {
  return KivoChangeSelection.model(ui.snapshot, { filter: ui.changeFilter, query: ui.changeQuery, collapsed: ui.collapsed, selected: ui.selected });
}

function orderedPaths() {
  return changeSelection().visiblePaths;
}

function setSelection(path, checked, range = false) {
  if (ui.busy) return;
  const paths = orderedPaths();
  const anchorIndex = range ? paths.indexOf(ui.selectionAnchor) : -1;
  const affected = range ? KivoChangeSelection.range(paths, ui.selectionAnchor, path) : [path];
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
  if (node.id) return `id:${node.id}`;
  if (node.dataset.path) return `file:${node.dataset.path}`;
  if (node.dataset.listId && node.classList.contains('changelist')) return `list:${node.dataset.listId}`;
  if (node.dataset.checkout) return `branch:${node.dataset.checkout}`;
  if (node.dataset.hash) return `commit:${node.dataset.hash}`;
  return null;
}

function interactionIdentity(node) {
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  return [...node.attributes]
    .filter((attribute) => attribute.name.startsWith('data-') || attribute.name === 'role')
    .map((attribute) => `${attribute.name}=${attribute.value}`)
    .sort()
    .join('|');
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
    if (child && (child.nodeType !== wanted.nodeType || child.nodeName !== wanted.nodeName || (keyFor(child) && keyFor(child) !== key) ||
        (child.__ideaGitListeners && interactionIdentity(child) !== interactionIdentity(wanted)))) child = null;
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
  const pool = new Map([...app.querySelectorAll('[id], [data-path], [data-list-id], [data-checkout], [data-hash]')].map((node) => [keyFor(node), node]));
  const before = new Map();
  if (motionEnabled()) {
    const destinations = new Map([...target.querySelectorAll('.file-row')].filter((row) => !row.closest('.collapsed')).map((row) => [row.dataset.path, row.dataset.listId]));
    for (const row of app.querySelectorAll('.file-row')) {
      const destination = destinations.get(row.dataset.path);
      if (!destination || destination === row.dataset.listId || row.closest('.collapsed')) continue;
      const rect = row.getBoundingClientRect();
      before.set(row.dataset.path, { listId: row.dataset.listId, left: rect.left, top: rect.top, width: rect.width, height: rect.height });
    }
  }
  patchNode(app, target, pool);
  if (before.size && motionEnabled()) {
    for (const row of app.querySelectorAll('.file-row')) {
      const old = before.get(row.dataset.path);
      if (!old) continue;
      const next = row.getBoundingClientRect();
      const movement = changelistMovement(old, { listId: row.dataset.listId, left: next.left, top: next.top, width: next.width, height: next.height }, window.innerHeight);
      if (movement) playMotion(row, [
        { transform: `translate(${movement.x}px, ${movement.y}px)` }, { transform: 'translate(0, 0)' }
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
    <section class="content ${surface}-content ${surface === 'changes' && ui.commitZoneResized && !ui.recentCommitsCollapsed ? 'recent-resized' : ''} ${surface === 'changes' && ui.recentCommitsCollapsed ? 'recent-collapsed' : ''}" aria-busy="${ui.busy}" ${ui.commitReviewOpen || ui.pushReview ? 'inert' : ''}>
      ${surface === 'changes' ? renderChanges(s) : renderGraph(s)}
    </section>
    ${surface === 'changes' && ui.branchOpen ? renderBranchPopup(s) : ''}
    ${surface === 'changes' ? renderBranchContextMenu() : ''}
    ${surface === 'changes' && ui.commitReviewOpen ? renderCommitReview(s) : ''}
    ${ui.pushReview ? renderPushReview(s) : ''}
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
    const changes = list?.changes.filter(matchesChangeFilter) || [];
    const selected = changes.filter((change) => ui.selected.has(change.path)).length;
    input.checked = Boolean(changes.length && selected === changes.length);
    input.indeterminate = selected > 0 && selected < changes.length;
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

function renderCommitRepository(s) {
  const name = s.repositoryName || 'Repository';
  const title = `${name}${s.root ? `\n${s.root}` : ''}`;
  const label = `${icon('repo')}<span class="commit-repository-name">${escapeHtml(name)}</span>`;
  return `<div class="commit-repository-header">${s.repositoryCount > 1
    ? `<button class="commit-repository-label commit-repository-picker" data-action="choose-repository" aria-label="Choose repository, current ${escapeHtml(name)}" aria-haspopup="dialog" title="${escapeHtml(title)}\nChoose repository" ${ui.busy ? 'disabled' : ''}>${label}${icon('chevron-down')}</button>`
    : `<div class="commit-repository-label" aria-label="Current repository ${escapeHtml(name)}" title="${escapeHtml(title)}">${label}</div>`}</div>`;
}

function renderCommitToolbar(s) {
  const syncing = ui.syncPhase === 'fetching';
  const branchLabel = s.branch === '(detached)' ? 'Detached HEAD' : s.branch;
  const branchActionLabel = s.branch === '(detached)' ? 'Git branches, detached HEAD' : `Git branches, current branch ${s.branch}`;
  const fetchIcon = syncing || ui.operationKind === 'fetch' ? 'loading' : 'refresh';
  const hasUpstream = Boolean(s.upstream);
  const pullTitle = hasUpstream
    ? s.behind ? `Pull ${s.behind} known incoming commit${s.behind === 1 ? '' : 's'} (checks remote)` : 'Pull from upstream (checks remote for new commits)'
    : 'Set an upstream branch before pulling';
  const pushTitle = s.ahead ? `Push ${s.ahead} outgoing commit${s.ahead === 1 ? '' : 's'}` : 'No commits to push';
  return `<header class="commit-toolbar" aria-label="Commit tool window actions" aria-busy="${syncing}">
    <button class="idea-toolbar-button" data-action="refresh" aria-label="Refresh changes" title="Refresh changes" ${ui.busy ? 'disabled' : ''}>${icon('refresh')}</button>
    <button class="idea-toolbar-button" data-action="branches" aria-label="${escapeHtml(branchActionLabel)}" title="Branches: ${escapeHtml(branchLabel)}" aria-haspopup="dialog" aria-expanded="${ui.branchOpen}">${icon('git-branch')}</button>
    <div class="sync-action-wrap compact-sync-action">
    <button class="idea-toolbar-button ${s.behind ? 'has-count incoming-count' : ''}" data-action="pull-menu" aria-label="${escapeHtml(pullTitle)}" title="${escapeHtml(pullTitle)}" aria-haspopup="menu" aria-expanded="${ui.pullMenuOpen}" ${!hasUpstream || ui.busy || syncing ? 'disabled' : ''}>${icon('arrow-down')}${s.behind ? `<span class="tool-count">${s.behind}</span>` : ''}</button>
      ${renderPullMenu()}
    </div>
    <button class="idea-toolbar-button ${s.ahead ? 'has-count outgoing-count' : ''}" data-action="push" aria-label="${escapeHtml(pushTitle)}" title="${escapeHtml(pushTitle)}" ${!hasUpstream || !s.ahead || ui.busy || syncing ? 'disabled' : ''}>${icon('arrow-up')}${s.ahead ? `<span class="tool-count">${s.ahead}</span>` : ''}</button>
    <button class="idea-toolbar-button" data-action="show-log" aria-label="Open Kivo Git History in bottom Panel" title="Open History in bottom Panel">${kivoIcon('graph', 'kivo-toolbar-mark')}</button>
    <span class="toolbar-spacer"></span>
    <button class="idea-toolbar-button" data-action="search-changes" aria-label="${ui.changeSearchOpen ? 'Close changed-file search' : 'Search changed files'}" title="${ui.changeSearchOpen ? 'Close changed-file search' : 'Search changed files'}" aria-expanded="${ui.changeSearchOpen}">${icon(ui.changeSearchOpen ? 'close' : 'search')}</button>
    <div class="commit-toolbar-more">
      <button class="idea-toolbar-button ${ui.syncPhase === 'error' ? 'has-error' : ''}" data-action="toolbar-more" aria-label="${escapeHtml(ui.syncPhase === 'error' ? 'Remote check failed; more Commit actions' : 'More Commit actions')}" title="${escapeHtml(ui.syncPhase === 'error' ? ui.syncError || 'Remote check failed' : 'More Commit actions')}" aria-haspopup="menu" aria-expanded="${ui.toolbarMenuOpen}">${icon('ellipsis')}</button>
      <div class="commit-toolbar-menu ${ui.toolbarMenuOpen ? 'open' : ''}" role="menu" aria-label="More Commit actions" ${ui.toolbarMenuOpen ? '' : 'inert'}>
        <button role="menuitem" data-toolbar-action="fetch" ${ui.busy || syncing ? 'disabled' : ''}>${icon(fetchIcon, syncing || ui.operationKind === 'fetch' ? 'codicon-modifier-spin' : '')}<span>${syncing ? 'Checking remote…' : ui.syncPhase === 'error' ? 'Remote check failed · Retry' : 'Fetch remote updates'}</span></button>
        ${!s.upstream && s.branch !== '(detached)' ? `<button role="menuitem" data-toolbar-action="configure-upstream" ${ui.busy ? 'disabled' : ''}>${icon('git-branch')}<span>Set tracking branch…</span></button>` : ''}
        <button role="menuitem" data-toolbar-action="configure-git-identity" ${ui.busy ? 'disabled' : ''}>${icon('account')}<span>${s.identity?.ready ? 'Edit Git identity…' : 'Set Git identity…'}</span></button>
        ${s.branch === '(detached)' ? `<button role="menuitem" data-toolbar-action="save-detached-head" ${ui.busy ? 'disabled' : ''}>${icon('git-branch')}<span>Create branch from HEAD…</span></button>` : ''}
        <span class="commit-toolbar-menu-divider" role="separator"></span>
        <button role="menuitem" data-toolbar-action="new-list" ${ui.busy ? 'disabled' : ''}>${icon('add')}<span>Create changelist</span></button>
        <button role="menuitem" data-toolbar-action="collapse-all">${icon('chevron-up')}<span>Collapse all changelists</span></button>
        <button role="menuitem" data-toolbar-action="expand-all">${icon('chevron-down')}<span>Expand all changelists</span></button>
      </div>
    </div>
  </header>`;
}

function matchesChangeFilter(change) {
  return KivoChangeSelection.matches(change, ui.changeFilter, ui.changeQuery);
}

function renderChanges(s) {
  const query = ui.changeQuery.trim().toLowerCase();
  const filtersActive = Boolean(query || ui.changeFilter !== 'all');
  const changesByList = new Map(changeSelection().lists.map((list) => [list.id, list.changes]));
  const filteredTotal = [...changesByList.values()].reduce((count, changes) => count + changes.length, 0);
  const visiblePaths = s.changelists
    .filter((list) => !ui.collapsed.has(list.id))
    .flatMap((list) => (changesByList.get(list.id) || []).map((change) => change.path));
  if (!visiblePaths.includes(ui.focusedPath)) ui.focusedPath = visiblePaths[0];
  const lists = s.changelists.filter((list) => !filtersActive || changesByList.get(list.id)?.length).map((list) => {
    const collapsed = ui.collapsed.has(list.id);
    const changes = changesByList.get(list.id) || [];
    const tracked = changes.filter((change) => change.kind !== 'untracked');
    const untracked = changes.filter((change) => change.kind === 'untracked');
    const selected = changes.filter((change) => ui.selected.has(change.path)).length;
    const allSelected = changes.length > 0 && selected === changes.length;
    return `<section class="changelist ${collapsed ? 'collapsed' : ''} ${list.active ? 'active-list' : ''}" data-list-id="${escapeHtml(list.id)}">
      <div class="list-heading"><label class="list-check check"><input type="checkbox" data-select-list="${escapeHtml(list.id)}" aria-label="Select matching files in ${escapeHtml(list.name)}" ${allSelected ? 'checked' : ''} ${ui.busy || !changes.length ? 'disabled' : ''}><span></span></label><button class="list-collapse" data-collapse="${escapeHtml(list.id)}" aria-expanded="${!collapsed}">
        ${icon('chevron-down', 'disclosure')}<span class="active-dot" title="${list.active ? 'Active changelist' : ''}"></span><span class="list-name">${escapeHtml(list.name)}</span>${s.changelists.length > 1 ? `<span class="count">${filtersActive ? `${changes.length}/${list.changes.length}` : list.changes.length}</span>` : ''}
      </button><button class="list-more" data-list-menu="${escapeHtml(list.id)}" aria-label="Actions for ${escapeHtml(list.name)}" aria-expanded="${ui.listMenuId === list.id}">${icon('more')}</button></div>
      <div class="file-list-shell"><div class="file-list ${list.changes.length ? '' : 'empty'}" data-drop-list="${escapeHtml(list.id)}">
        ${tracked.length ? `<div class="file-group-heading" role="heading" aria-level="3"><span>Tracked</span>${untracked.length ? `<span>${tracked.length}</span>` : ''}</div>${tracked.map((change) => renderFile(change, list.id)).join('')}` : ''}
        ${untracked.length ? `<div class="file-group-heading untracked-group" role="heading" aria-level="3"><span>Untracked</span>${tracked.length ? `<span>${untracked.length}</span>` : ''}</div>${untracked.map((change) => renderFile(change, list.id)).join('')}` : ''}
      </div></div><div class="list-menu ${ui.listMenuId === list.id ? 'open' : ''}" role="menu" ${ui.listMenuId === list.id ? '' : 'inert'}>
        ${list.active ? '' : `<button role="menuitem" data-list-action="active" data-list-id="${escapeHtml(list.id)}">Set Active</button>`}
        <button role="menuitem" data-list-action="rename" data-list-id="${escapeHtml(list.id)}" data-list-name="${escapeHtml(list.name)}">Rename</button>
        ${list.id === 'default' ? '' : `<button role="menuitem" class="danger" data-list-action="delete" data-list-id="${escapeHtml(list.id)}" data-list-name="${escapeHtml(list.name)}">Delete</button>`}
      </div>
    </section>`;
  }).join('');
  const commitHint = commitBlocker() || 'Commit selected files';
  const canCommit = !commitBlocker();
  return `
    <div class="commit-upper" id="kivo-commit-upper" ${ui.commitZoneResized && !ui.recentCommitsCollapsed ? `style="flex-basis:${ui.commitZonePercent}%"` : ''}>
      ${renderCommitRepository(s)}
      ${renderCommitToolbar(s)}
      <div class="commit-changes-heading" role="heading" aria-level="2"><span class="changes-heading-label">${kivoIcon('changes', 'changes-heading-icon')}<span>Changes</span></span><small>${filtersActive ? `${filteredTotal}/${s.changes.length}` : s.changes.length} ${s.changes.length === 1 ? 'file' : 'files'}</small></div>
      ${ui.changeSearchOpen ? `<div class="commit-change-search"><input id="change-search" type="search" aria-label="Search changed files by path or status" placeholder="Path or status…" value="${escapeHtml(ui.changeQuery)}"><select id="change-filter" aria-label="Filter changed files by type or Git state"><option value="all" ${ui.changeFilter === 'all' ? 'selected' : ''}>All changes</option><option value="staged" ${ui.changeFilter === 'staged' ? 'selected' : ''}>Staged</option><option value="worktree" ${ui.changeFilter === 'worktree' ? 'selected' : ''}>Working tree</option><option value="modified" ${ui.changeFilter === 'modified' ? 'selected' : ''}>Modified</option><option value="added" ${ui.changeFilter === 'added' ? 'selected' : ''}>Added</option><option value="deleted" ${ui.changeFilter === 'deleted' ? 'selected' : ''}>Deleted</option><option value="renamed" ${ui.changeFilter === 'renamed' ? 'selected' : ''}>Renamed</option><option value="untracked" ${ui.changeFilter === 'untracked' ? 'selected' : ''}>Untracked</option><option value="conflict" ${ui.changeFilter === 'conflict' ? 'selected' : ''}>Conflicts</option></select><kbd>Esc</kbd></div>` : ''}
      <div class="lists commit-changes-tree" id="kivo-commit-changes">${lists || `<div class="commit-empty-list">${filtersActive ? 'No changed files match the current filters' : 'No changes'}</div>`}</div>
      <div class="commit-panel-splitter" data-commit-panel-splitter role="separator" aria-label="Resize changes and commit message" aria-controls="kivo-commit-changes kivo-commit-message" aria-orientation="horizontal" aria-valuemin="${COMMIT_PANEL_MIN_HEIGHT}" aria-valuenow="${Math.round(ui.commitPanelHeight)}" tabindex="0" title="Drag to resize. Double-click to reset."></div>
      <footer class="commit-panel" id="kivo-commit-message" style="--commit-panel-height:${Math.round(ui.commitPanelHeight)}px">
      ${renderSelectionStatus()}
      <textarea id="commit-message" rows="4" placeholder="Commit Message" aria-label="Commit Message" spellcheck="true" ${ui.operationKind === 'commit' ? 'disabled' : ''}>${escapeHtml(ui.commitMessage)}</textarea>
      <div class="commit-actions">
        <button class="primary-button ${ui.operationKind === 'commit' ? 'working' : ''}" data-action="commit" title="${escapeHtml(commitHint)} (${commandKey}+Enter)" ${!canCommit ? 'disabled' : ''}>${ui.operationKind === 'commit' ? `${icon('loading', 'codicon-modifier-spin button-spinner')}<span>Committing…</span>` : '<span>Commit</span>'}</button>
        <button class="commit-push-button ${ui.operationKind === 'push' ? 'working' : ''}" data-action="commit-and-push" title="${escapeHtml(canCommit ? 'Commit selected files and push' : commitHint)}" ${!canCommit ? 'disabled' : ''}>${ui.operationKind === 'push' ? `${icon('loading', 'codicon-modifier-spin button-spinner')}<span>Pushing…</span>` : '<span>Commit and Push…</span>'}</button>
        <button class="idea-toolbar-button" data-action="reuse-commit-message" aria-label="Reuse a recent commit message" title="Reuse a recent commit message" ${ui.busy ? 'disabled' : ''}>${icon('history')}</button>
        <button class="idea-toolbar-button commit-settings" data-action="open-settings" aria-label="Kivo Git settings" title="Kivo Git settings">${icon('gear')}</button>
      </div>
      </footer>
    </div>
    ${ui.recentCommitsCollapsed ? '' : `<div class="commit-zone-splitter" data-commit-zone-splitter role="separator" aria-label="Resize changes and recent commits" aria-controls="kivo-commit-upper kivo-commit-lower" aria-orientation="horizontal" aria-valuenow="${ui.commitZonePercent}" aria-valuemin="35" aria-valuemax="75" tabindex="0" title="Drag to resize. Double-click to fit recent commits to content."></div>`}
    <div class="commit-lower" id="kivo-commit-lower">
      ${renderRecentCommits(s)}
    </div>
    ${renderFileContextMenu()}`;
}

function renderCommitReview(s) {
  const { selectedChanges } = changeSelection();
  const partial = selectedChanges.filter((change) => change.indexStatus !== '.' && change.workingTreeStatus !== '.').length;
  const destination = ui.commitReviewAndPush ? `<p class="commit-review-push">After committing, you will review the push to <strong>${escapeHtml(s.upstream || 'the configured upstream')}</strong>.</p>` : '';
  return `<div class="commit-review-overlay"><div class="commit-review-scrim" data-action="close-commit-review"></div>
    <section class="commit-review-dialog" role="dialog" aria-modal="true" aria-labelledby="commit-review-title" aria-describedby="commit-review-description">
      <header><div><small>BEFORE COMMIT</small><h2 id="commit-review-title">Review ${selectedChanges.length} selected ${selectedChanges.length === 1 ? 'file' : 'files'}</h2></div><button class="idea-toolbar-button" data-action="close-commit-review" aria-label="Close commit review" title="Close review">${icon('close')}</button></header>
      <p id="commit-review-description">Kivo Git commits the current working-tree contents of these files, including both staged and unstaged edits. Other staged files stay untouched.</p>
      ${partial ? `<p class="commit-review-warning" role="note">${icon('warning')} ${partial} ${partial === 1 ? 'file has' : 'files have'} both staged and working-tree edits. Both will be included.</p>` : ''}
      <div class="commit-review-files" aria-label="Files in this commit">${selectedChanges.map((change) => `<div class="commit-review-file"><span class="commit-review-path" title="${escapeHtml(change.path)}">${escapeHtml(change.path)}</span><span class="commit-review-state">${escapeHtml(fileStateSummary(change))}</span><button data-review-diff="${escapeHtml(change.path)}" data-original-path="${escapeHtml(change.originalPath || '')}" data-kind="${escapeHtml(change.kind)}" aria-label="Review diff for ${escapeHtml(change.path)}">Review diff</button></div>`).join('')}</div>
      <div class="commit-review-message"><span>Message</span><strong>${escapeHtml(ui.commitMessage.trim())}</strong></div>
      ${destination}
      <footer><button class="commit-review-cancel" data-action="close-commit-review">Back</button><button class="primary-button" data-action="confirm-commit-review">${ui.commitReviewAndPush ? 'Commit, then review push' : 'Commit these files'}</button></footer>
    </section>
  </div>`;
}

function renderPushReview(s) {
  const review = ui.pushReview;
  const p = review.preview;
  const blocked = Boolean(p.behind || review.rejection);
  const warning = review.rejection || (p.behind ? `${p.behind} incoming ${p.behind === 1 ? 'commit' : 'commits'}. Fetch and review the branch before pushing.` : '');
  return `<div class="push-review-overlay"><div class="push-review-scrim" data-action="cancel-push-review"></div>
    <section class="push-review-dialog" role="dialog" aria-modal="true" aria-labelledby="push-review-title" aria-describedby="push-review-description">
      <header><div><small>${icon('repo')} ${escapeHtml(s.repositoryName)}</small><h2 id="push-review-title">${icon('arrow-up')} ${review.rejection ? 'Push rejected' : 'Push commits'}</h2></div><button data-action="cancel-push-review" aria-label="Close push review" title="Close">${icon('close')}</button></header>
      <div class="push-review-body"><p id="push-review-description">${review.afterCommit ? 'Commit saved locally. Review the destination.' : 'Review the destination and outgoing commits.'}</p>
        <div class="push-review-route"><div><span class="push-route-label">Local</span>${icon('git-branch')}<strong>${escapeHtml(p.branch)}</strong></div><div class="push-route-target"><span class="push-route-label">Remote</span>${icon('cloud')}<strong>${escapeHtml(`${p.remote}/${p.targetBranch}`)}</strong></div></div>
        ${warning ? `<p class="push-review-warning" role="alert">${icon('warning')}<span>${escapeHtml(warning)}</span></p>` : ''}
        <div class="push-review-summary"><span><b>${p.ahead}</b> ${p.ahead === 1 ? 'commit' : 'commits'} to push</span><span><b>${p.fileCount}</b> ${p.fileCount === 1 ? 'changed file' : 'changed files'}</span></div>
        <div class="push-review-commits" aria-label="Outgoing commits">${p.commits.map((commit) => {
          const expanded = ui.pushSelectedHash === commit.hash;
          return `<div class="push-review-entry" data-hash="${escapeHtml(commit.hash)}"><button class="push-review-commit" data-push-commit="${escapeHtml(commit.hash)}" aria-expanded="${expanded}" ${expanded ? `aria-controls="push-files-${review.id}-${escapeHtml(commit.hash)}"` : ''} title="${expanded ? 'Hide' : 'Show'} changed files · ${escapeHtml(commit.subject)}">${icon(expanded ? 'chevron-down' : 'chevron-right', 'push-commit-disclosure')}<span class="push-commit-dot" aria-hidden="true"></span><code title="${escapeHtml(commit.hash)}">${escapeHtml(commit.hash.slice(0, 7))}</code><span class="push-commit-subject">${escapeHtml(commit.subject)}</span></button>${expanded ? renderPushCommitPreview(commit) : ''}</div>`;
        }).join('')}${p.ahead > p.commits.length ? `<p class="push-review-more">+ ${p.ahead - p.commits.length} more commits</p>` : ''}</div>
      </div>
      <footer><button class="push-review-cancel" data-action="cancel-push-review">Cancel</button><button class="primary-button" data-action="${blocked ? 'fetch-push-review' : 'confirm-push-review'}">${icon(blocked ? 'sync' : 'arrow-up')} ${blocked ? 'Fetch and Review' : `Push ${p.ahead} ${p.ahead === 1 ? 'commit' : 'commits'}`}</button></footer>
    </section>
  </div>`;
}

function respondPushReview(choice) {
  if (!ui.pushReview) return;
  const { id, root } = ui.pushReview;
  ui.pushReview = undefined;
  clearPushCommitPreview(true);
  render();
  post('respondPushReview', { id, root, choice });
  app.querySelector('[data-action="push"]')?.focus();
}

function clearPushCommitPreview(clearCache = false) {
  ui.pushDetailsRequestId++;
  ui.pushSelectedHash = undefined;
  ui.pushDetails = undefined;
  ui.pushDetailsLoading = false;
  ui.pushDetailsError = undefined;
  if (clearCache) ui.pushDetailsCache.clear();
}

function selectPushCommit(hash, retry = false) {
  if (!ui.pushReview?.preview.commits.some((commit) => commit.hash === hash)) return;
  if (ui.pushSelectedHash === hash && !retry) clearPushCommitPreview();
  else {
    clearPushCommitPreview();
    ui.pushSelectedHash = hash;
    ui.pushDetails = ui.pushDetailsCache.get(hash);
    ui.pushDetailsLoading = !ui.pushDetails;
    if (ui.pushDetailsLoading) post('pushCommitDetails', { id: ui.pushReview.id, root: ui.pushReview.root, hash, requestId: ui.pushDetailsRequestId });
  }
  render();
}

function renderPushCommitPreview(commit) {
  let content = '';
  if (ui.pushDetailsLoading) content = '<div class="commit-recent-status" role="status">Loading changed files…</div>';
  else if (ui.pushDetailsError) content = `<div class="commit-recent-status" role="alert">${escapeHtml(ui.pushDetailsError)} <button data-push-retry="${escapeHtml(commit.hash)}">Retry</button></div>`;
  else if (ui.pushDetails) {
    const files = ui.pushDetails.files || [];
    content = `<div class="commit-recent-file-count">${files.length ? `${files.length} ${files.length === 1 ? 'changed file' : 'changed files'}` : 'No file changes in this commit'}</div>${files.map((file) => {
      const { kind, label } = commitFileState(file);
      return `<button class="commit-recent-file push-preview-file ${kind}" data-push-file="${escapeHtml(file.path)}" data-push-hash="${escapeHtml(commit.hash)}" title="${label}: ${escapeHtml(file.originalPath ? `${file.originalPath} → ${file.path}` : file.path)}" aria-label="${label}: ${escapeHtml(file.path)}; view committed diff">${renderFileTypeIcon(file, ui.pushDetails.fileIcons)}${renderCompactCommitFile(file)}</button>`;
    }).join('')}`;
  }
  return `<div class="push-commit-files" id="push-files-${ui.pushReview.id}-${escapeHtml(commit.hash)}" aria-busy="${ui.pushDetailsLoading}">${content}</div>`;
}

function commitFileState(file) {
  const kind = ({ A: 'added', D: 'deleted', R: 'renamed', C: 'added' })[file.status?.[0]] || 'modified';
  return { kind, label: ({ added: 'Added', deleted: 'Deleted', renamed: 'Renamed', modified: 'Modified' })[kind] };
}

function renderCompactCommitFile(file) {
  const split = file.path.lastIndexOf('/');
  const filename = file.path.slice(split + 1);
  const directory = split < 0 ? '' : file.path.slice(0, split);
  const parts = directory.split('/');
  const shortDirectory = parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : directory;
  return `<span class="preview-file-copy ${directory ? 'has-directory' : ''}"><span class="preview-file-name">${escapeHtml(filename)}</span>${directory ? `<span class="preview-file-directory">${escapeHtml(shortDirectory)}</span>` : ''}</span>`;
}

function clearRecentCommitPreview(clearCache = false) {
  ui.recentRequestId++;
  ui.recentSelectedHash = undefined;
  ui.recentDetails = undefined;
  ui.recentDetailsLoading = false;
  ui.recentDetailsError = undefined;
  if (clearCache) ui.recentDetailsCache.clear();
}

function selectRecentCommit(hash, retry = false) {
  if (!ui.snapshot || !recentCommits(ui.snapshot).some((commit) => commit.hash === hash)) return;
  if (ui.recentSelectedHash === hash && !retry) {
    clearRecentCommitPreview();
  } else {
    clearRecentCommitPreview();
    ui.recentSelectedHash = hash;
    ui.recentDetails = ui.recentDetailsCache.get(hash);
    ui.recentDetailsLoading = !ui.recentDetails;
    if (ui.recentDetailsLoading) post('recentCommitDetails', { hash, root: ui.snapshot.root, requestId: ui.recentRequestId });
  }
  render();
}

function recentCommits(s) { return (s.recentCommits || s.commits || []).slice(0, 5); }

function renderRecentCommitPreview(commit) {
  let content = '';
  if (ui.recentDetailsLoading) content = '<div class="commit-recent-status" role="status">Loading changed files…</div>';
  else if (ui.recentDetailsError) content = `<div class="commit-recent-status" role="alert">${escapeHtml(ui.recentDetailsError)} <button data-recent-retry="${escapeHtml(commit.hash)}">Retry</button></div>`;
  else if (ui.recentDetails) {
    const files = ui.recentDetails.files || [];
    content = `<div class="commit-recent-file-count">${files.length} ${files.length === 1 ? 'changed file' : 'changed files'}</div>${files.slice(0, 8).map((file) => {
      const { kind, label } = commitFileState(file);
      return `<button class="commit-recent-file ${kind}" data-recent-file="${escapeHtml(file.path)}" data-original-path="${escapeHtml(file.originalPath || '')}" data-kind="${escapeHtml(file.status || '')}" title="${label}: ${escapeHtml(file.originalPath ? `${file.originalPath} → ${file.path}` : file.path)}" aria-label="${label}: ${escapeHtml(file.path)}; view committed diff">${renderFileTypeIcon(file, ui.recentDetails.fileIcons)}${renderCompactCommitFile(file)}</button>`;
    }).join('')}${files.length > 8 ? `<div class="commit-recent-status">${files.length - 8} more in History</div>` : ''}`;
  }
  return `<div class="commit-recent-preview" id="recent-${escapeHtml(commit.hash)}" aria-busy="${ui.recentDetailsLoading}">${content}<button class="commit-recent-history" data-recent-history="${escapeHtml(commit.hash)}">Open in History ${icon('arrow-right')}</button></div>`;
}

function renderRecentCommits(s) {
  const commits = recentCommits(s);
  let previousDate;
  return `<section class="commit-recent" aria-label="Recent commits">
    <div class="commit-lower-heading"><button class="commit-recent-toggle" data-action="toggle-recent-commits" aria-label="${ui.recentCommitsCollapsed ? 'Expand' : 'Collapse'} recent commits" aria-expanded="${!ui.recentCommitsCollapsed}" aria-controls="kivo-recent-list">${icon(ui.recentCommitsCollapsed ? 'chevron-right' : 'chevron-down')}<span>Recent commits</span></button><button class="commit-recent-view-all" data-action="show-log" aria-label="Show all commit history">View all</button></div>
    <div class="commit-recent-list" id="kivo-recent-list" ${ui.recentCommitsCollapsed ? 'hidden' : ''}><div class="commit-recent-branch" title="Recent commits on ${escapeHtml(s.branch)}">${icon('git-branch')}<span>${escapeHtml(s.branch || 'HEAD')}</span></div>${commits.length ? commits.map((commit) => {
      const timestamp = absoluteTime(commit.date);
      const date = timestamp.split(' ')[0];
      const heading = previousDate !== date ? `<div class="commit-recent-date">${date}</div>` : '';
      previousDate = date;
      const expanded = ui.recentSelectedHash === commit.hash;
      return `<div class="commit-recent-entry" data-hash="${escapeHtml(commit.hash)}">${heading}<button class="commit-recent-row ${commit.unpushedTo ? 'unpushed' : ''}" data-recent-commit="${escapeHtml(commit.hash)}" aria-expanded="${expanded}" ${expanded ? `aria-controls="recent-${escapeHtml(commit.hash)}"` : ''} title="${expanded ? 'Hide' : 'Show'} changed files · ${escapeHtml(commit.subject)}">
        <span class="commit-recent-node" aria-hidden="true"></span><span class="commit-recent-copy"><strong title="${escapeHtml(commit.subject)}">${escapeHtml(commit.subject)}</strong><span class="commit-recent-meta"><code>${escapeHtml(commit.shortHash)}</code>${renderUnpushedBadge(commit)}<span class="commit-recent-author" title="${escapeHtml(commit.author)}">${escapeHtml(commit.author)}</span><time datetime="${escapeHtml(commit.date)}" title="${timestamp}">${timestamp.split(' ')[1] || '—'}</time></span></span>
      </button>${expanded ? renderRecentCommitPreview(commit) : ''}</div>`;
    }).join('') : '<div class="commit-recent-empty">No commits yet</div>'}</div>
  </section>`;
}

function renderFile(change, listId) {
  const checked = ui.selected.has(change.path);
  const filename = change.path.split('/').pop();
  const parent = change.path.includes('/') ? change.path.slice(0, change.path.lastIndexOf('/')) : '';
  return `<div class="file-row ${change.kind} ${checked ? 'selected' : ''} ${ui.focusedPath === change.path ? 'focused' : ''}" draggable="${!ui.busy}" data-file-row data-path="${escapeHtml(change.path)}" data-list-id="${escapeHtml(listId)}" title="${escapeHtml(change.path)}">
    <label class="check"><input type="checkbox" aria-label="Select ${escapeHtml(change.path)}" data-select="${escapeHtml(change.path)}" ${checked ? 'checked' : ''} ${ui.busy ? 'disabled' : ''}><span></span></label>
    <button class="file-main" data-diff="${escapeHtml(change.path)}" data-original-path="${escapeHtml(change.originalPath || '')}" data-kind="${escapeHtml(change.kind)}" tabindex="${ui.focusedPath === change.path ? '0' : '-1'}" aria-keyshortcuts="M" aria-label="Preview diff for ${escapeHtml(change.path)}; ${escapeHtml(fileStateSummary(change))}; ${escapeHtml(fileStateTitle(change))}; press M to move to another changelist" title="${escapeHtml(change.path)} · ${escapeHtml(fileStateTitle(change))} · Press M to move to another changelist">
      ${renderFileTypeIcon(change)}<span class="file-name">${escapeHtml(filename)}</span>${parent ? `<span class="file-parent">${escapeHtml(parent)}</span>` : ''}
    </button>
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
  const height = (list?.changes.length && list.changes.length > 1 ? 310 : 280) + (partialDiff ? 52 : 0);
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
    ${list?.changes.length && list.changes.length > 1 ? `<button role="menuitem" data-file-context-action="select-list" ${ui.busy ? 'disabled' : ''}>${icon('list-selection')}<span>Select Matching Files in Changelist</span></button>` : ''}
    <button role="menuitem" data-file-context-action="copy-path">${icon('copy')}<span>Copy Relative Path</span></button>
    <div class="context-menu-separator" role="separator"></div>
    <button role="menuitem" class="danger-action" data-file-context-action="rollback" ${ui.busy ? 'disabled' : ''}>${icon('discard')}<span>${ui.selected.has(change.path) && changeSelection().selectedChanges.length > 1 && !changeSelection().hiddenCount ? `Rollback ${changeSelection().selectedChanges.length} selected files…` : 'Rollback file…'}</span></button>
  </div>`;
}

function renderRef(ref) {
  const kind = ref.kind === 'remote' ? 'remote' : ref.kind === 'tag' ? 'tag' : 'local';
  return `<span class="graph-ref ${kind} ${ref.current ? 'current' : ''}">${icon(ref.kind === 'tag' ? 'tag' : ref.kind === 'remote' ? 'cloud' : 'git-branch')}<span>${ref.current ? 'HEAD · ' : ''}${escapeHtml(ref.name)}</span></span>`;
}

function renderUnpushedBadge(commit) {
  if (!commit.unpushedTo) return '';
  const label = `Not pushed to ${commit.unpushedTo} · Compared with the local tracking ref`;
  return `<span class="unpushed-badge" role="img" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${icon('arrow-up')}<span>Unpushed</span></span>`;
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
  return `${folders.map(([name, child]) => {
    const segments = [name];
    while (!child.leaves.length && child.directories.size === 1) {
      const [segment, next] = child.directories.entries().next().value;
      segments.push(segment);
      child = next;
    }
    const label = segments.join('/');
    return `<div class="commit-file-folder" style="--tree-indent:${depth * 13}px" title="${escapeHtml(label)}">${icon('chevron-down')} ${icon('folder')}<span>${escapeHtml(label)}</span></div>${renderCommitFileTree(child, depth + 1)}`;
  }).join('')}${node.leaves.sort((left, right) => left.leaf.localeCompare(right.leaf)).map((file) => {
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
      <div class="commit-detail-meta"><span>${escapeHtml(commit.author)} · ${absoluteTime(commit.date)}</span><code>${escapeHtml(commit.hash)}</code></div>
      <div class="commit-detail-refs">${commit.refs.map(renderRef).join('') || '<span class="detail-muted">No branch label</span>'}</div>
      ${details?.body && details.body !== details.subject ? `<p class="commit-body">${escapeHtml(details.body)}</p>` : ''}
      ${details?.parents?.length ? `<div class="detail-parents"><span>Parents</span>${details.parents.map((parent) => `<code>${escapeHtml(parent.slice(0, 8))}</code>`).join('')}</div>` : ''}
    </div>
  </aside>`;
}

function renderLogBranchRow(branch, depth = 0, sync = '') {
  const kind = branch.kind === 'tag' ? 'tag' : 'branch';
  const label = branch.leaf || branch.name;
  const row = `<button class="log-branch-row ${branch.current ? 'current' : ''} ${ui.graphBranchFilter === branch.name ? 'selected' : ''}" style="--tree-indent:${depth * 13}px" data-log-branch="${escapeHtml(branch.name)}" data-branch-ref="${escapeHtml(branch.name)}" data-branch-remote="${branch.remote ? 'true' : 'false'}" data-branch-kind="${kind}" aria-pressed="${ui.graphBranchFilter === branch.name}" aria-haspopup="menu" title="Show ${escapeHtml(branch.name)} history · Right-click for ${kind} actions">${icon(branch.remote ? 'cloud' : kind === 'tag' ? 'tag' : 'git-branch')}<span>${escapeHtml(label)}</span>${sync}${branch.current ? '<small>HEAD</small>' : ''}</button>`;
  if (branch.remote || branch.current || kind === 'tag' || !branch.upstream) return row;
  const title = `Update ${branch.name} from ${branch.upstream} (fast-forward only)`;
  return `<div class="log-branch-entry ${ui.graphBranchFilter === branch.name ? 'selected' : ''}">${row}<button class="log-branch-update" data-update-branch="${escapeHtml(branch.name)}" aria-label="${escapeHtml(title)}" title="${escapeHtml(title)}" ${ui.busy ? 'disabled' : ''}>${icon('arrow-down')}</button></div>`;
}

function renderLogBranchSync(branch, snapshot) {
  if (branch.remote || branch.kind === 'tag') return '';
  const upstream = branch.current ? snapshot.upstream : branch.upstream;
  if (!upstream) return '';
  const behind = branch.current ? snapshot.behind : branch.behind;
  const ahead = branch.current ? snapshot.ahead : branch.ahead;
  const incoming = behind !== undefined ? behind > 0 : branch.tracking?.includes('<');
  const outgoing = ahead !== undefined ? ahead > 0 : branch.tracking?.includes('>');
  const failed = branch.current && ui.syncPhase === 'error';
  if (!incoming && !outgoing && !failed) return '';
  const title = `${behind === undefined && incoming ? 'Incoming commits' : `${behind ?? 0} incoming`}, ${ahead === undefined && outgoing ? 'outgoing commits' : `${ahead ?? 0} outgoing`} · ${upstream}${failed ? ' · Remote check failed' : ''}`;
  return `<span class="branch-sync-indicator" role="img" aria-label="${escapeHtml(title)}" title="${escapeHtml(title)}">${incoming ? `<span class="branch-sync-count branch-sync-incoming">${icon('arrow-down')}<b>${behind ?? ''}</b></span>` : ''}${outgoing ? `<span class="branch-sync-count branch-sync-outgoing">${icon('arrow-up')}<b>${ahead ?? ''}</b></span>` : ''}${failed ? icon('warning', 'branch-sync-error') : ''}</span>`;
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
  const local = s.branches.filter((branch) => !branch.remote && matches(branch))
    .sort((left, right) => Number(right.current) - Number(left.current) || left.name.localeCompare(right.name));
  const remote = s.branches.filter((branch) => branch.remote && matches(branch));
  const tags = (s.tags || []).filter(matches).map((tag) => ({ ...tag, path: tag.name, name: tag.name, remote: false, kind: 'tag' }));
  const tagCount = (s.tags || []).length;
  const group = (key, label, items, emptyLabel) => {
    const expanded = Boolean(query) || ui.branchGroupsExpanded[key];
    const visibleCount = ui.branchVisibleCounts[key];
    const visible = expanded ? items.slice(0, visibleCount) : [];
    const remaining = Math.max(0, items.length - visible.length);
    const tree = key === 'local'
      ? visible.map((branch) => renderLogBranchRow(branch, 0, renderLogBranchSync(branch, s))).join('')
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
  const trackedLocal = menu.kind === 'branch' && !menu.remote && ui.snapshot?.branches.some((branch) => branch.name === menu.ref && Boolean(branch.upstream));
  const actionCount = 3
    + (menu.kind === 'branch' && !menu.current ? 3 : 0)
    + (menu.kind === 'branch' && !menu.remote ? 1 : 0)
    + (trackedLocal ? 2 : 0);
  const height = 40 + actionCount * 27 + 12;
  const left = clamp(menu.x, 8, Math.max(8, window.innerWidth - width - 8));
  const top = clamp(menu.y, 8, Math.max(8, window.innerHeight - height - 8));
  const refLabel = menu.kind === 'tag' ? 'tag' : 'branch';
  return `<div class="context-menu branch-context-menu" data-branch-context role="menu" aria-label="Actions for ${escapeHtml(menu.ref)}" style="left:${left}px;top:${top}px">
    <div class="context-menu-title branch-context-title"><span>${icon(menu.remote ? 'cloud' : menu.kind === 'tag' ? 'tag' : 'git-branch')}</span><strong title="${escapeHtml(menu.ref)}">${escapeHtml(menu.ref)}</strong></div>
    ${menu.kind === 'branch' && !menu.current ? `<button role="menuitem" data-branch-context-action="checkout" ${ui.busy ? 'disabled' : ''}>${icon('check')}<span>Checkout</span></button>` : ''}
    ${trackedLocal ? `<button role="menuitem" data-branch-context-action="update" ${ui.busy ? 'disabled' : ''}>${icon('arrow-down')}<span>Update from Remote</span></button><button role="menuitem" data-branch-context-action="push" ${ui.busy ? 'disabled' : ''}>${icon('arrow-up')}<span>Push…</span></button>` : ''}
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
  const commit = graphCommits().find((candidate) => candidate.hash === menu.hash);
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

function renderLogActionRail(s) {
  return `<aside class="log-action-rail" aria-label="History actions">
    <button class="idea-toolbar-button" data-action="show-changes" aria-label="Open Commit tool window" title="Open Commit tool window">${kivoIcon('changes', 'kivo-toolbar-mark')}<span class="rail-text">Commit</span></button>
    ${s.repositoryCount > 1 ? `<button class="idea-toolbar-button" data-action="choose-repository" aria-label="Choose repository, current ${escapeHtml(s.repositoryName)}" title="Repository: ${escapeHtml(s.repositoryName)}" ${ui.busy ? 'disabled' : ''}>${icon('repo')}<span class="rail-text">Repos</span></button>` : ''}
    <button class="idea-toolbar-button" data-action="refresh" aria-label="Refresh History" title="Refresh History">${icon('refresh')}<span class="rail-text">Refresh</span></button>
    <button class="idea-toolbar-button" data-action="fetch" aria-label="Fetch remote updates" title="Fetch remote updates" ${ui.busy || ui.syncPhase === 'fetching' ? 'disabled' : ''}>${icon(ui.syncPhase === 'fetching' ? 'loading' : 'cloud-download', ui.syncPhase === 'fetching' ? 'codicon-modifier-spin' : '')}<span class="rail-text">Fetch</span></button>
    <span class="idea-toolbar-divider" aria-hidden="true"></span>
    <button class="idea-toolbar-button" data-action="toggle-history-focus" aria-label="${ui.historyFocusMode ? 'Show History side panels' : 'Focus on commit history'}" title="${ui.historyFocusMode ? 'Show branches and commit details' : 'Focus on commit history'}" aria-pressed="${ui.historyFocusMode}">${icon(ui.historyFocusMode ? 'screen-full' : 'screen-normal')}<span class="rail-text">${ui.historyFocusMode ? 'Panels' : 'Focus'}</span></button>
  </aside>`;
}

function renderLogFilterBar(s, commits, filtersActive) {
  const branchOptions = [...new Set([...s.branches, ...(s.tags || [])].map((branch) => branch.name))].sort((a, b) => a.localeCompare(b));
  const authorOptions = [...new Set(s.commits.map((commit) => commit.author))].sort((a, b) => a.localeCompare(b));
  const countLabel = historySearchActive()
    ? ui.historySearchLoading ? 'Searching history…' : `${commits.length}${ui.historySearch?.hasMore ? '+ matching' : ' matching'}`
    : filtersActive ? `${commits.length} of ${s.commits.length}${s.commitsHasMore ? ' loaded' : ''}` : `${s.commits.length}${s.commitsHasMore ? '+ loaded' : ''}`;
  return `<div class="log-filter-bar"><div class="graph-toolbar-head">
    <label class="graph-search log-search">${icon('search')}<input id="graph-search" aria-label="Search by text or hash" placeholder="Search commits or hash" value="${escapeHtml(ui.graphQuery)}"></label>
    <div class="graph-filters" aria-label="History filters">
      <label class="graph-filter"><span>Ref</span><select data-graph-filter="branch" aria-label="Filter by branch or tag"><option value="">All refs</option>${branchOptions.map((branch) => `<option value="${escapeHtml(branch)}" ${ui.graphBranchFilter === branch ? 'selected' : ''}>${escapeHtml(branch)}</option>`).join('')}</select></label>
      <label class="graph-filter"><span>User</span><input id="graph-author" aria-label="Filter by author" list="graph-author-options" placeholder="Any" value="${escapeHtml(ui.graphAuthorFilter)}"><datalist id="graph-author-options">${authorOptions.map((author) => `<option value="${escapeHtml(author)}"></option>`).join('')}</datalist></label>
      <label class="graph-filter"><span>Date</span><select data-graph-filter="age" aria-label="Filter by date"><option value="all" ${ui.graphAgeFilter === 'all' ? 'selected' : ''}>All</option><option value="7d" ${ui.graphAgeFilter === '7d' ? 'selected' : ''}>7 days</option><option value="30d" ${ui.graphAgeFilter === '30d' ? 'selected' : ''}>30 days</option><option value="90d" ${ui.graphAgeFilter === '90d' ? 'selected' : ''}>90 days</option></select></label>
      <label class="graph-filter path-filter"><span>Paths</span><input id="graph-path" aria-label="Filter by path" placeholder="Any" value="${escapeHtml(ui.graphPathFilter)}"></label>
      ${filtersActive ? '<button class="text-button graph-clear" data-action="clear-graph-filters">Clear</button>' : ''}
    </div><span class="log-result-count" aria-live="polite">${countLabel}</span>
  </div></div>`;
}

function renderGraph(s) {
  const commits = graphCommits();
  const hasMore = historySearchActive() ? ui.historySearch?.hasMore : s.commitsHasMore;
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
    <div class="log-workspace ${ui.historyFocusMode ? 'history-focus' : ''}" style="--log-branch-width:${branchWidth}px;--log-detail-width:${detailWidth}px;--log-detail-height:${detailHeight}px">
      ${renderLogActionRail(s)}
      ${renderLogBranchPane(s)}
      <div class="log-splitter" data-log-splitter role="separator" aria-label="Resize History branch tree" aria-controls="kivo-log-branches kivo-log-history" aria-orientation="vertical" aria-valuemin="${LOG_BRANCH_MIN_WIDTH}" aria-valuemax="${LOG_BRANCH_MAX_WIDTH}" aria-valuenow="${branchWidth}" tabindex="0" title="Drag to resize the branch tree. Double-click to reset."></div>
      <section class="log-history-pane" id="kivo-log-history" aria-label="Commit history">
        ${renderLogFilterBar(s, commits, filtersActive)}
        <div class="log-column-header" aria-hidden="true" style="--graph-width:${graphWidth}px"><span>AUTHOR</span><span>GRAPH</span><span>COMMIT</span><span>DATE</span></div>
        <div class="graph-list ${graph.compressed ? 'graph-compressed' : ''} ${ui.graphLoadingMore ? 'is-loading' : ''}" data-graph-list role="listbox" aria-label="Commit history${graph.compressed ? `, compact ${laneCount}-lane topology` : ''}" aria-busy="${ui.graphLoadingMore || ui.historyRefLoading || ui.historySearchLoading}" aria-setsize="${commits.length}" style="--lane-count:${laneCount};--graph-width:${graphWidth}px;--graph-row-height:${GRAPH_ROW_HEIGHT}px">${ui.historyRefLoading || ui.historySearchLoading && !commits.length ? `<div class="inline-empty" role="status">${icon('loading', 'codicon-modifier-spin')} ${ui.historyRefLoading ? 'Loading branch history…' : 'Searching complete history…'}</div>` : commits.length ? `${windowed.topSpacer ? `<div class="graph-virtual-spacer" aria-hidden="true" style="height:${windowed.topSpacer}px"></div>` : ''}${visibleCommits.map((commit, index) => `<article class="graph-row ${commit.unpushedTo ? 'unpushed' : ''} ${commit.parents.length > 1 ? 'merge-row' : ''} ${ui.selectedCommitHash === commit.hash ? 'selected' : ''}" data-commit="${escapeHtml(commit.hash)}" data-hash="${escapeHtml(commit.hash)}" role="option" aria-selected="${ui.selectedCommitHash === commit.hash}" aria-posinset="${windowed.start + index + 1}" tabindex="${focusHash === commit.hash ? '0' : '-1'}">
          <span class="log-author" title="${escapeHtml(commit.author)}">${escapeHtml(commit.author)}</span><div class="graph-canvas">${renderGraphSvg(commit, graph)}</div><div class="graph-commit"><div class="log-subject">${renderUnpushedBadge(commit)}<strong title="${escapeHtml(commit.subject)}">${escapeHtml(commit.subject)}</strong>${(commit.refs || []).slice(0, 3).map(renderRef).join('')}</div><span class="log-meta"><code>${escapeHtml(commit.shortHash)}</code>${commit.parents?.length > 1 ? '<span class="merge-note">Merge</span>' : ''}</span></div><time class="log-date" datetime="${escapeHtml(commit.date)}" title="${escapeHtml(commit.date)}">${absoluteTime(commit.date)}</time>
        </article>`).join('')}${windowed.bottomSpacer ? `<div class="graph-virtual-spacer" aria-hidden="true" style="height:${windowed.bottomSpacer}px"></div>` : ''}` : `<div class="inline-empty" role="status">${ui.historySearchError ? `Search failed. <button data-action="retry-history-search">Retry</button>` : historySearchActive() ? 'No matching commits in this repository' : 'No commits yet'}</div>`}${hasMore && !ui.historyRefLoading ? `<div class="graph-load-sentinel" aria-hidden="true">${ui.graphLoadingMore ? 'Loading older commits…' : 'Scroll to the bottom for older commits'}</div>` : ''}${ui.graphLoadingMore ? `<div class="graph-loading-row" role="status">${icon('loading', 'codicon-modifier-spin')}<span>Loading more history…</span></div>` : ''}</div>
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
  const railWidth = compact || narrow ? 30 : 56;
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
  if (action === 'select-list' && !ui.busy) {
    const list = ui.snapshot?.changelists.find((candidate) => candidate.id === menu.listId);
    if (list) {
      const matching = list.changes.filter(matchesChangeFilter);
      for (const item of matching) ui.selected.add(item.path);
      ui.selectionAnchor = change.path;
      persist();
      toast(`Selected ${matching.length} matching files`, 'success');
    }
  }
  if (action === 'copy-path') post('copyPath', { path: change.path });
  if (action === 'rollback' && !ui.busy) {
    const selection = changeSelection();
    const paths = ui.selected.has(change.path) && selection.selectedChanges.length > 1 && !selection.hiddenCount
      ? selection.selectedChanges.map((item) => item.path) : [change.path];
    post('rollbackFiles', { paths });
  }
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
  if (action === 'update' && !ui.busy && !menu.remote) {
    if (menu.current) post('pull', { strategy: 'ff-only' });
    else post('updateBranch', { branch: menu.ref });
  }
  if (action === 'push' && !ui.busy && !menu.remote) {
    if (menu.current) post('push');
    else post('pushBranch', { branch: menu.ref });
  }
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
  const repositoryHeight = content?.querySelector('.commit-repository-header')?.getBoundingClientRect().height || 34;
  const toolbarHeight = content?.querySelector('.commit-toolbar')?.getBoundingClientRect().height || 31;
  const headingHeight = content?.querySelector('.commit-changes-heading')?.getBoundingClientRect().height || 26;
  const available = content?.clientHeight || 0;
  const maximum = Math.min(COMMIT_PANEL_MAX_HEIGHT, available
    ? Math.max(COMMIT_PANEL_MIN_HEIGHT, available - repositoryHeight - toolbarHeight - headingHeight - 82)
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
  ui.commitZoneResized = true;
  splitter.parentElement?.classList.add('recent-resized');
  splitter.parentElement?.querySelector('.commit-upper')?.style.setProperty('flex-basis', `${next}%`);
  splitter.setAttribute('aria-valuenow', String(next));
  return next;
}

function resetCommitZoneSize() {
  ui.commitZonePercent = COMMIT_ZONE_DEFAULT_PERCENT;
  ui.commitZoneResized = false;
  persist();
  render();
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
  else {
    ui.commitZoneResized = resize.initialResized;
    ui.commitZonePercent = resize.initialPercent;
    render();
  }
}

function startCommitZoneResize(event) {
  if (event.button !== 0 || activeCommitZoneResize) return;
  const splitter = event.currentTarget;
  const content = splitter.closest('.changes-content');
  if (!content?.clientHeight) return;
  event.preventDefault();
  const initialResized = ui.commitZoneResized;
  const initialPercent = ui.commitZonePercent;
  const startPercent = (content.querySelector('.commit-upper')?.getBoundingClientRect().height || 0) * 100 / content.clientHeight;
  const startY = event.clientY;
  const move = (pointerEvent) => {
    if (pointerEvent.pointerId !== event.pointerId) return;
    applyCommitZonePercent(splitter, startPercent + (pointerEvent.clientY - startY) * 100 / content.clientHeight);
  };
  const complete = (pointerEvent) => { if (pointerEvent.pointerId === event.pointerId) finishCommitZoneResize(true); };
  const cancel = (pointerEvent) => { if (pointerEvent.pointerId === event.pointerId) finishCommitZoneResize(false); };
  activeCommitZoneResize = { splitter, pointerId: event.pointerId, initialPercent, initialResized, move, complete, cancel };
  splitter.setPointerCapture?.(event.pointerId);
  splitter.addEventListener('pointermove', move);
  splitter.addEventListener('pointerup', complete);
  splitter.addEventListener('pointercancel', cancel);
  document.body.classList.add('commit-zone-resizing');
}

function adjustCommitZonePercent(event) {
  if (!['ArrowUp', 'ArrowDown', 'Home'].includes(event.key)) return;
  event.preventDefault();
  if (event.key === 'Home') {
    resetCommitZoneSize();
    return;
  }
  const content = event.currentTarget.closest('.changes-content');
  const percent = ui.commitZoneResized ? ui.commitZonePercent
    : (content?.querySelector('.commit-upper')?.getBoundingClientRect().height || 0) * 100 / (content?.clientHeight || 1);
  applyCommitZonePercent(event.currentTarget, percent + (event.key === 'ArrowDown' ? 3 : -3));
  persist();
}

function renderBranchPopup(s) {
  const query = ui.branchQuery.trim().toLowerCase();
  const filtered = s.branches.filter((branch) => branch.name.toLowerCase().includes(query));
  const local = filtered.filter((branch) => !branch.remote).sort((a, b) => Number(b.current) - Number(a.current));
  const remote = filtered.filter((branch) => branch.remote);
  const rows = (items) => items.map((branch) => `<button class="branch-row ${branch.current ? 'current' : ''}" data-checkout="${escapeHtml(branch.name)}" data-remote="${branch.remote}" ${ui.busy ? 'disabled' : ''}>
      ${icon(branch.current ? 'check' : branch.remote ? 'cloud' : 'git-branch')}<span class="branch-row-name">${escapeHtml(branch.name)}</span>${branch.tracking ? `<small>${escapeHtml(branch.tracking)}</small>` : ''}
    </button>`).join('');
  const popupGroup = (key, label, items) => {
    const count = ui.branchPopupVisibleCounts[key];
    const visible = items.slice(0, count);
    const remaining = Math.max(0, items.length - visible.length);
    const expanded = key !== 'remote' || ui.branchPopupRemoteExpanded || Boolean(query);
    return `<section class="branch-popup-group"><h3>${key === 'remote' ? `<button class="branch-popup-toggle" data-branch-popup-toggle="remote" aria-expanded="${expanded}">${icon(expanded ? 'chevron-down' : 'chevron-right')}${label}<span>${items.length}</span></button>` : `${label}<span>${items.length}</span>`}</h3>${expanded ? `${rows(visible) || `<p class="no-results">No ${label.toLowerCase()}</p>`}${remaining ? `<button class="branch-popup-more" data-branch-popup-more="${key}">Show ${Math.min(BRANCH_PAGE_SIZE, remaining)} more</button>` : ''}` : ''}</section>`;
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
  once('[data-toolbar-action]', 'click', (event) => {
    event.stopPropagation();
    const action = event.currentTarget.dataset.toolbarAction;
    ui.toolbarMenuOpen = false;
    render();
    handleAction(action);
  });
  once('[data-review-diff]', 'click', (event) => {
    const button = event.currentTarget;
    post('openDiff', { path: button.dataset.reviewDiff, originalPath: button.dataset.originalPath || undefined, kind: button.dataset.kind, preview: false });
  });
  once('.commit-review-dialog', 'keydown', (event) => {
    if (event.key !== 'Tab') return;
    const items = [...event.currentTarget.querySelectorAll('button:not(:disabled)')];
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  once('.commit-toolbar-menu', 'keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      ui.toolbarMenuOpen = false;
      render();
      app.querySelector('[data-action="toolbar-more"]')?.focus();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const items = [...event.currentTarget.querySelectorAll('button:not(:disabled)')];
    const current = items.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[Math.max(0, next)]?.focus();
  });
  once('[data-file-menu]', 'click', (event) => openFileContextMenu(event, event.currentTarget.closest('[data-file-row]')));
  once('[data-graph-list]', 'scroll', onGraphScroll);
  bindGraphViewport();
  once('[data-commit]', 'click', (event) => selectCommit(event.currentTarget.dataset.commit));
  once('[data-recent-commit]', 'click', (event) => selectRecentCommit(event.currentTarget.dataset.recentCommit));
  once('[data-recent-retry]', 'click', (event) => selectRecentCommit(event.currentTarget.dataset.recentRetry, true));
  once('[data-recent-history]', 'click', (event) => post('showRecentCommit', { hash: event.currentTarget.dataset.recentHistory }));
  once('[data-recent-file]', 'click', (event) => {
    const file = event.currentTarget.dataset;
    post('openRecentCommitDiff', { root: ui.snapshot.root, hash: ui.recentSelectedHash, path: file.recentFile, originalPath: file.originalPath, kind: file.kind });
  });
  once('[data-push-commit]', 'click', (event) => selectPushCommit(event.currentTarget.dataset.pushCommit));
  once('[data-push-retry]', 'click', (event) => selectPushCommit(event.currentTarget.dataset.pushRetry, true));
  once('[data-push-file]', 'click', (event) => {
    if (!ui.pushReview) return;
    post('openPushCommitDiff', { id: ui.pushReview.id, root: ui.pushReview.root, hash: event.currentTarget.dataset.pushHash, path: event.currentTarget.dataset.pushFile });
  });
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
      persist();
      requestHistorySearch();
      if (!historySearchActive()) { reconcileHistorySelection(); render(); }
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
      requestHistorySearch();
      if (!historySearchActive()) { reconcileHistorySelection(); render(); }
      requestAnimationFrame(() => {
        const input = app.querySelector('#graph-path');
        input?.focus();
        input?.setSelectionRange(ui.graphPathFilter.length, ui.graphPathFilter.length);
      });
    });
  }
  const graphAuthor = app.querySelector('#graph-author');
  if (graphAuthor && !graphAuthor.__ideaGitListeners) {
    graphAuthor.__ideaGitListeners = new Set(['author-search']);
    graphAuthor.addEventListener('input', () => {
      ui.graphAuthorFilter = graphAuthor.value;
      persist();
      requestHistorySearch();
      if (!historySearchActive()) { reconcileHistorySelection(); render(); }
      requestAnimationFrame(() => {
        const input = app.querySelector('#graph-author');
        input?.focus();
        input?.setSelectionRange(ui.graphAuthorFilter.length, ui.graphAuthorFilter.length);
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
      ui.changeFilter = 'all';
      ui.changeSearchOpen = false;
      persist();
      render();
      app.querySelector('[data-action="search-changes"]')?.focus();
    });
  }
  const changeFilter = app.querySelector('#change-filter');
  if (changeFilter && !changeFilter.__ideaGitListeners) {
    changeFilter.__ideaGitListeners = new Set(['changed-file-filter']);
    changeFilter.addEventListener('change', () => {
      ui.changeFilter = changeFilter.value;
      persist();
      render();
      requestAnimationFrame(() => app.querySelector('#change-filter')?.focus());
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
    if (select.dataset.graphFilter === 'age') ui.graphAgeFilter = select.value || 'all';
    persist();
    requestHistorySearch();
    if (!historySearchActive()) { reconcileHistorySelection(); render(); }
  });
  once('[data-log-branch]', 'click', (event) => {
    setHistoryRef(event.currentTarget.dataset.logBranch || '');
  });
  once('[data-update-branch]', 'click', (event) => {
    if (!ui.busy) post('updateBranch', { branch: event.currentTarget.dataset.updateBranch });
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
  once('[data-commit-zone-splitter]', 'dblclick', resetCommitZoneSize);
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
    for (const change of list.changes.filter(matchesChangeFilter)) input.checked ? ui.selected.add(change.path) : ui.selected.delete(change.path);
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
      if (ui.busy) return;
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
      clearTimeout(previewTimer);
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
    if (target.dataset.diff !== button.dataset.diff) {
      clearTimeout(previewTimer);
      previewTimer = setTimeout(() => postDiff(target, true), 140);
    }
  });
  once('[data-checkout]', 'click', (event) => {
    const button = event.currentTarget;
    if (button.classList.contains('current') || ui.busy) return;
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
  once('[data-branch-popup-toggle]', 'click', () => {
    ui.branchPopupRemoteExpanded = !ui.branchPopupRemoteExpanded;
    render();
    requestAnimationFrame(() => app.querySelector('[data-branch-popup-toggle]')?.focus());
  });
}

function handleAction(action) {
  if (action === 'cancel-push-review') { respondPushReview('cancel'); return; }
  if (action === 'confirm-push-review') { respondPushReview('push'); return; }
  if (action === 'fetch-push-review') { respondPushReview('fetch'); return; }
  if (action === 'toggle-recent-commits') {
    ui.recentCommitsCollapsed = !ui.recentCommitsCollapsed;
    persist();
    render();
    requestAnimationFrame(() => app.querySelector('[data-action="toggle-recent-commits"]')?.focus());
    return;
  }
  if (action === 'close-commit-review') {
    const andPush = ui.commitReviewAndPush;
    ui.commitReviewOpen = false;
    render();
    requestAnimationFrame(() => app.querySelector(`[data-action="${andPush ? 'commit-and-push' : 'commit'}"]`)?.focus());
    return;
  }
  if (action === 'confirm-commit-review') {
    submitReviewedCommit();
    return;
  }
  if (action === 'toolbar-more') {
    ui.toolbarMenuOpen = !ui.toolbarMenuOpen;
    ui.pullMenuOpen = false;
    render();
    if (ui.toolbarMenuOpen) requestAnimationFrame(() => app.querySelector('[data-toolbar-action]:not(:disabled)')?.focus());
    return;
  }
  if (action === 'toggle-history-focus') {
    ui.historyFocusMode = !ui.historyFocusMode;
    persist();
    render();
    requestAnimationFrame(() => app.querySelector('[data-action="toggle-history-focus"]')?.focus());
    return;
  }
  if (action === 'choose-repository' && !ui.busy) post('chooseRepository');
  if (action === 'clear-selection' && !ui.busy) {
    ui.selected.clear();
    persist();
    render();
  }
  if (action === 'clear-hidden-selection' && !ui.busy) {
    const { filteredPaths } = changeSelection();
    ui.selected = new Set([...ui.selected].filter((path) => filteredPaths.has(path)));
    persist();
    render();
  }
  if (action === 'rollback-selected' && !ui.busy) {
    const selection = changeSelection();
    if (selection.selectedChanges.length && !selection.hiddenCount) {
      post('rollbackFiles', { paths: selection.selectedChanges.map((change) => change.path) });
    }
  }
  if (action === 'refresh') post('refresh');
  if (action === 'show-log') post('showLog');
  if (action === 'show-changes') post('showChanges');
  if (action === 'open-settings') post('openSettings');
  if (action === 'reuse-commit-message' && !ui.busy) post('reuseCommitMessage', { draft: ui.commitMessage });
  if (action === 'configure-git-identity' && !ui.busy) post('configureGitIdentity');
  if (action === 'configure-upstream' && !ui.busy) post('configureUpstream');
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
  if (action === 'retry-history-search') requestHistorySearch(true, 0);
  if (action === 'clear-graph-filters') {
    clearTimeout(historySearchTimer);
    ui.historySearchRequestId += 1;
    ui.historySearch = undefined;
    ui.historySearchLoading = false;
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
    else ui.branchPopupRemoteExpanded = false;
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
      ui.changeFilter = 'all';
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

function commitBlocker() {
  const selection = changeSelection();
  if (ui.busy) return 'A Git operation is in progress';
  if (!selection.selectedChanges.length) return 'Select at least one changed file';
  if (selection.hiddenCount) return 'Review or remove hidden selected files before committing';
  if (ui.snapshot?.changes.some((change) => change.kind === 'conflict')) return 'Resolve merge conflicts before committing';
  if (ui.snapshot?.identity?.ready === false) return 'Set your Git identity before committing';
  if (!ui.commitMessage.trim()) return 'Write a commit message';
  return undefined;
}

function renderSelectionStatus() {
  const { selectedChanges, hiddenCount } = changeSelection();
  const wholeFiles = ui.changeFilter === 'staged' || selectedChanges.some((change) => change.staged && change.workingTreeStatus !== '.');
  return `<div class="commit-selection-status" role="status"><span>${selectedChanges.length} ${selectedChanges.length === 1 ? 'file' : 'files'} selected${hiddenCount ? ` · ${hiddenCount} hidden by filters` : ''}</span>${selectedChanges.length ? `<div class="commit-selection-actions"><button class="text-button rollback-selection" data-action="rollback-selected" title="Restore tracked changes to HEAD; move new files to Trash" ${ui.busy || hiddenCount ? 'disabled' : ''}>Rollback…</button><button class="text-button" data-action="${hiddenCount ? 'clear-hidden-selection' : 'clear-selection'}" ${ui.busy ? 'disabled' : ''}>${hiddenCount ? 'Remove hidden' : 'Clear'}</button></div>` : ''}</div>${hiddenCount ? '<div class="commit-selection-note warning">Hidden selections must be reviewed or removed.</div>' : wholeFiles ? '<div class="commit-selection-note">Commits include all working-tree changes in selected files.</div>' : ''}`;
}

function syncCommitActionState() {
  const hint = commitBlocker();
  const enabled = !hint;
  const messageCheck = app.querySelector('[data-commit-message-check]');
  if (messageCheck) {
    const ready = Boolean(ui.commitMessage.trim());
    messageCheck.classList.toggle('pending', !ready);
    messageCheck.innerHTML = `${icon(ready ? 'check' : 'circle-outline')} ${ready ? 'Message ready' : 'Message needed'}`;
  }
  for (const button of app.querySelectorAll('[data-action="commit"], [data-action="commit-and-push"]')) {
    button.disabled = !enabled;
    button.title = hint || (button.dataset.action === 'commit' ? `Commit selected files (${commandKey}+Enter)` : 'Commit selected files and push');
  }
}

function commit(andPush = false) {
  const blocker = commitBlocker();
  if (blocker) {
    toast(blocker, 'error');
    return;
  }
  if (andPush && !ui.snapshot?.upstream) {
    toast('Set an upstream before using Commit and Push. You can still commit locally.', 'error');
    return;
  }
  ui.commitReviewAndPush = andPush;
  ui.commitReviewOpen = true;
  render();
  requestAnimationFrame(() => app.querySelector('[data-action="confirm-commit-review"]')?.focus());
}

function submitReviewedCommit() {
  if (!ui.commitReviewOpen) return;
  const blocker = commitBlocker();
  if (blocker) { toast(blocker, 'error'); return; }
  const andPush = ui.commitReviewAndPush;
  const paths = changeSelection().selectedChanges.map((change) => change.path);
  ui.commitReviewOpen = false;
  render();
  post(andPush ? 'commitAndPush' : 'commit', { message: ui.commitMessage, paths });
}

function toast(message, phase = 'success') {
  const element = document.createElement('div');
  element.className = `toast ${phase}`;
  element.setAttribute('role', phase === 'error' ? 'alert' : 'status');
  element.innerHTML = `${icon(phase === 'success' ? 'check' : phase === 'loading' ? 'loading' : 'error', phase === 'loading' ? 'codicon-modifier-spin' : '')}<p>${escapeHtml(message)}</p><button class="toast-close" aria-label="Dismiss notification" title="Dismiss">${icon('close')}</button>`;
  clearTimeout(toastRegion.firstElementChild?.dismissTimer);
  toastRegion.replaceChildren(element);
  const scheduleDismiss = () => {
    clearTimeout(element.dismissTimer);
    if (phase !== 'loading' && !element.matches(':hover, :focus-within')) element.dismissTimer = setTimeout(() => dismissToast(element), phase === 'error' ? 8000 : 2800);
  };
  element.querySelector('button').addEventListener('click', () => dismissToast(element));
  element.addEventListener('mouseenter', () => clearTimeout(element.dismissTimer));
  element.addEventListener('focusin', () => clearTimeout(element.dismissTimer));
  element.addEventListener('mouseleave', scheduleDismiss);
  element.addEventListener('focusout', () => requestAnimationFrame(scheduleDismiss));
  scheduleDismiss();
  return element;
}

function dismissToast(element) {
  if (!element?.isConnected || element.classList.contains('leaving')) return;
  clearTimeout(element.dismissTimer);
  if (!motionEnabled()) { element.remove(); return; }
  element.classList.add('leaving');
  element.addEventListener('animationend', () => element.remove(), { once: true });
  setTimeout(() => element.remove(), 240);
}

window.addEventListener('message', (event) => {
  const message = event.data;
  if (message.type === 'pushReview') {
    if (message.root !== ui.snapshot?.root || ui.pushReview?.id > message.id) return;
    if (ui.pushReview?.id !== message.id) clearPushCommitPreview(true);
    ui.pushReview = message;
    ui.commitReviewOpen = false;
    ui.branchOpen = false;
    ui.branchContextMenu = undefined;
    ui.commitContextMenu = undefined;
    ui.fileContextMenu = undefined;
    ui.toolbarMenuOpen = false;
    render();
    requestAnimationFrame(() => app.querySelector('.push-review-dialog footer .primary-button')?.focus());
    return;
  }
  if (message.type === 'pushReviewClosed') {
    if (message.id !== ui.pushReview?.id) return;
    ui.pushReview = undefined;
    clearPushCommitPreview(true);
    render();
    return;
  }
  if (message.type === 'pushCommitDetails' || message.type === 'pushCommitDetailsError') {
    const hash = message.payload?.hash || message.hash;
    if (!ui.pushReview || message.id !== ui.pushReview.id || message.root !== ui.snapshot?.root ||
        message.requestId !== ui.pushDetailsRequestId || hash !== ui.pushSelectedHash) return;
    ui.pushDetailsLoading = false;
    ui.pushDetailsError = message.type === 'pushCommitDetailsError' ? message.message || 'Unable to load changed files.' : undefined;
    ui.pushDetails = message.type === 'pushCommitDetails' ? message.payload : undefined;
    if (ui.pushDetails) ui.pushDetailsCache.set(hash, ui.pushDetails);
    render();
    return;
  }
  if (message.type === 'historySearchResults' && surface === 'history') {
    if (message.requestId !== ui.historySearchRequestId || message.root !== ui.snapshot?.root || !historySearchActive()) return;
    ui.historySearch = { key: historySearchKey(), commits: message.commits, hasMore: message.hasMore };
    ui.historySearchLoading = false;
    ui.graphLoadingMore = false;
    if (ui.pendingRevealHash && message.commits.some((commit) => commit.hash === ui.pendingRevealHash)) {
      const hash = ui.pendingRevealHash;
      ui.pendingRevealHash = undefined;
      selectCommit(hash, { focus: true });
    } else {
      if (ui.pendingRevealHash && !message.hasMore) {
        ui.pendingRevealHash = undefined;
        toast('Commit is not in the available history.', 'error');
      }
      reconcileHistorySelection();
      render();
      restoreGraphScroll(ui.graphScrollTop);
    }
    return;
  }
  if (message.type === 'historySearchError' && surface === 'history') {
    if (message.requestId !== ui.historySearchRequestId || message.root !== ui.snapshot?.root) return;
    ui.historySearchLoading = false;
    ui.graphLoadingMore = false;
    ui.historySearchError = message.message;
    toast(`History search failed: ${message.message}`, 'error');
    render();
    return;
  }
  if (message.type === 'reuseCommitMessage' && surface === 'changes') {
    if (ui.commitMessage !== message.expectedDraft) {
      toast('Draft changed while choosing a message. Choose again to replace it.', 'error');
      return;
    }
    ui.commitMessage = message.body;
    persist();
    render();
    app.querySelector('#commit-message')?.focus();
    return;
  }
  if (message.type === 'revealCommit' && surface === 'history') {
    // A Blame jump needs the detail pane even if the user left History in focus mode.
    ui.historyFocusMode = false;
    ui.graphBranchFilter = '';
    ui.graphPathFilter = '';
    ui.graphQuery = message.hash;
    ui.graphAuthorFilter = '';
    ui.graphAgeFilter = 'all';
    ui.pendingRevealHash = message.hash;
    persist();
    render();
    requestHistorySearch(true, 0);
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
    if (ui.commitReviewOpen && lastSnapshot && fingerprint !== lastSnapshot) {
      ui.commitReviewOpen = false;
      toast('Repository changed during review. Check the selected files again.', 'error');
    }
    const previousRoot = ui.snapshot?.root;
    const previousBranch = ui.snapshot?.branch;
    const nextRoot = message.payload.root;
    if (previousRoot && previousRoot !== nextRoot) saveRepositoryState(previousRoot);
    if (previousRoot !== nextRoot) {
      const nextState = repositoryStates[nextRoot] || (!previousRoot ? legacyRepositoryState : undefined) || {};
      restoreRepositoryState(nextRoot, nextState);
    }
    lastSnapshot = fingerprint;
    ui.emptyMessage = undefined;
    ui.snapshot = message.payload;
    if (ui.pushReview) {
      const p = ui.pushReview.preview;
      const branch = message.payload.branches.find((candidate) => candidate.name === p.branch && !candidate.remote);
      const upstream = message.payload.branches.find((candidate) => candidate.name === p.upstream);
      if (!branch || branch.oid && branch.oid !== p.head || upstream?.oid && upstream.oid !== p.upstreamOid || branch.upstream && branch.upstream !== p.upstream) {
        respondPushReview('cancel');
        toast('Branch changed. Reopen Push to review the latest commits.', 'error');
      }
    }
    if (previousRoot === nextRoot && previousBranch !== message.payload.branch) clearRecentCommitPreview(true);
    else if (ui.recentSelectedHash && !recentCommits(message.payload).some((commit) => commit.hash === ui.recentSelectedHash)) clearRecentCommitPreview();
    ui.graphLoadingMore = false;
    ui.historyRefLoading = false;
    if (surface === 'history' && historySearchActive() && ui.historySearch?.key !== historySearchKey()) requestHistorySearch(true, 0);
    if (ui.selectedCommitHash && !message.payload.commits.some((commit) => commit.hash === ui.selectedCommitHash) &&
        !ui.historySearch?.commits.some((commit) => commit.hash === ui.selectedCommitHash)) {
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
    if (ui.pendingRevealHash && message.payload.commits.some((commit) => commit.hash === ui.pendingRevealHash)) {
      const hash = ui.pendingRevealHash;
      ui.pendingRevealHash = undefined;
      selectCommit(hash, { focus: true });
    } else if (ui.pendingRevealHash && !historySearchActive() && !message.payload.commitsHasMore) {
      ui.pendingRevealHash = undefined;
      toast('Commit is not in the available history.', 'error');
    }
    if (ui.pendingRevealHash && !historySearchActive()) requestOlderHistoryForHash();
  }
  if (message.type === 'empty') {
    persist();
    ui.pushReview = undefined;
    clearPushCommitPreview(true);
    clearRecentCommitPreview(true);
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
    if (!message.feedbackSurface || message.feedbackSurface === surface) toast(message.message, message.phase);
    render();
    if (message.phase === 'success' && message.clearsCommit) {
      const textarea = app.querySelector('#commit-message');
      if (textarea) textarea.value = '';
    }
  }
  if (message.type === 'syncStatus') {
    ui.syncPhase = message.phase;
    ui.lastFetchedAt = message.lastFetchedAt;
    ui.syncError = message.error;
    render();
  }
  if (message.type === 'recentCommitDetails' || message.type === 'recentCommitDetailsError') {
    const hash = message.payload?.hash || message.hash;
    if (message.root !== ui.snapshot?.root || message.requestId !== ui.recentRequestId || hash !== ui.recentSelectedHash) return;
    ui.recentDetailsLoading = false;
    ui.recentDetailsError = message.type === 'recentCommitDetailsError' ? message.message || 'Unable to load changed files.' : undefined;
    ui.recentDetails = message.type === 'recentCommitDetails' ? message.payload : undefined;
    if (ui.recentDetails) ui.recentDetailsCache.set(hash, ui.recentDetails);
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
  if (ui.pushReview) {
    event.preventDefault();
    respondPushReview('cancel');
    return;
  }
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
  if (ui.commitReviewOpen) {
    event.preventDefault();
    handleAction('close-commit-review');
    return;
  }
  if (ui.toolbarMenuOpen) {
    event.preventDefault();
    ui.toolbarMenuOpen = false;
    render();
    app.querySelector('[data-action="toolbar-more"]')?.focus();
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

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Tab' || !ui.pushReview) return;
  const buttons = [...app.querySelectorAll('.push-review-dialog button:not(:disabled)')];
  if (!buttons.length) return;
  const first = buttons[0], last = buttons.at(-1);
  if (event.shiftKey && document.activeElement === first || !event.shiftKey && document.activeElement === last || !buttons.includes(document.activeElement)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  }
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
  if (ui.toolbarMenuOpen && !event.target.closest('.commit-toolbar-more')) {
    ui.toolbarMenuOpen = false;
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

post('ready', { historyRef: surface === 'history' ? ui.graphBranchFilter : undefined });
render();
