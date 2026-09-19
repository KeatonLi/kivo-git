const vscode = acquireVsCodeApi();
const app = document.querySelector('#app');
const toastRegion = document.querySelector('#toast-region');
const persisted = vscode.getState?.() || {};

const ui = {
  snapshot: undefined,
  tab: persisted.tab === 'log' ? 'log' : 'changes',
  selected: new Set(persisted.selected || []),
  collapsed: new Set(persisted.collapsed || []),
  branchOpen: false,
  branchQuery: '',
  busy: false,
  operationKind: undefined,
  operationId: 0,
  branchMotion: undefined,
  listMenuId: undefined,
  focusedPath: persisted.focusedPath,
  selectionAnchor: undefined,
  commitMessage: persisted.commitMessage || ''
};
let lastSnapshot = '';
let previewTimer;
let dragAvatar;
const commandKey = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

const escapeHtml = (value = '') => String(value)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#039;');

const iconFor = (kind) => ({ modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: '?', conflict: '!' })[kind] || 'M';
const relativeTime = (date) => {
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (seconds < 60) return 'now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
};

function post(type, payload = {}) { vscode.postMessage({ type, ...payload }); }
function persist() {
  vscode.setState?.({ tab: ui.tab, selected: [...ui.selected], collapsed: [...ui.collapsed], focusedPath: ui.focusedPath, commitMessage: ui.commitMessage });
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
  const counters = new Map([...app.querySelectorAll('.count, .sync, .tabs .tab span')].map((node) => [node, node.textContent]));
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
    app.innerHTML = `<section class="empty-state"><div class="empty-mark">⑂</div><h2>Open a Git repository</h2><p>IdeaGit will appear here when the workspace is ready.</p><button data-action="refresh">Refresh</button></section>`;
    bind();
    return;
  }
  const changeCount = s.changes.length;
  patchApp(`
    <header class="repo-header">
      <button class="branch-pill" data-action="branches" aria-label="Git branches" aria-haspopup="dialog" aria-expanded="${ui.branchOpen}">
        <span class="branch-symbol">⑂</span><span class="branch-name">${escapeHtml(s.branch)}</span>
        ${s.ahead ? `<span class="sync up">↑${s.ahead}</span>` : ''}${s.behind ? `<span class="sync down">↓${s.behind}</span>` : ''}
        <span class="chevron">⌄</span>
      </button>
      <div class="repo-actions">
        <button class="icon-button ${ui.operationKind === 'fetch' ? 'working' : ''}" aria-label="${ui.operationKind === 'fetch' ? 'Fetching' : 'Fetch'}" title="Fetch" data-action="fetch" ${ui.busy ? 'disabled' : ''}><span class="action-glyph">↻</span></button>
        <button class="icon-button ${ui.operationKind === 'pull' ? 'working' : ''}" aria-label="${ui.operationKind === 'pull' ? 'Pulling' : 'Pull'}" title="Pull" data-action="pull" ${ui.busy ? 'disabled' : ''}><span class="action-glyph">↓</span></button>
        <button class="icon-button ${ui.operationKind === 'push' ? 'working' : ''}" aria-label="${ui.operationKind === 'push' ? 'Pushing' : 'Push'}" title="Push" data-action="push" ${ui.busy ? 'disabled' : ''}><span class="action-glyph">↑</span></button>
      </div>
    </header>
    <nav class="tabs" aria-label="Git views">
      <button class="tab ${ui.tab === 'changes' ? 'active' : ''}" data-tab="changes">Changes <span>${changeCount}</span></button>
      <button class="tab ${ui.tab === 'log' ? 'active' : ''}" data-tab="log">Log</button>
    </nav>
    <section class="content" aria-busy="${ui.busy}">
      ${ui.tab === 'changes' ? renderChanges(s) : renderLog(s)}
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
        <span class="disclosure">⌄</span><span class="active-dot" title="${list.active ? 'Active changelist' : ''}">${list.active ? '●' : ''}</span><span class="list-name">${escapeHtml(list.name)}</span><span class="count">${list.changes.length}</span>
      </button><button class="list-more" data-list-menu="${escapeHtml(list.id)}" aria-label="Actions for ${escapeHtml(list.name)}" aria-expanded="${ui.listMenuId === list.id}">•••</button></div>
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
    <div class="section-toolbar"><span>LOCAL CHANGES</span><button class="text-button" data-action="new-list" ${ui.busy ? 'disabled' : ''}>＋ Changelist</button></div>
    <div class="lists">${lists}</div>
    <footer class="commit-panel">
      <textarea id="commit-message" rows="3" placeholder="Commit message…" spellcheck="true" ${ui.operationKind === 'commit' ? 'disabled' : ''}>${escapeHtml(ui.commitMessage)}</textarea>
      <div class="commit-meta"><span>${selectedCount || 'No'} file${selectedCount === 1 ? '' : 's'} selected</span><span class="shortcut">${commandKey} Enter</span></div>
      <button class="primary-button ${ui.operationKind === 'commit' ? 'working' : ''}" data-action="commit" ${!selectedCount || ui.busy ? 'disabled' : ''}>${ui.operationKind === 'commit' ? '<span class="button-spinner">↻</span><span class="button-label">Committing…</span>' : '<span class="button-label">Commit</span><span class="button-arrow">⌄</span>'}</button>
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

function renderLog(s) {
  if (!s.commits.length) return '<div class="inline-empty">No commits yet</div>';
  return `<div class="log-list">${s.commits.map((commit, index) => `
    <article class="commit-row" data-hash="${escapeHtml(commit.hash)}" style="--delay:${Math.min(index * 14, 180)}ms">
      <div class="graph"><span class="node"></span>${index < s.commits.length - 1 ? '<span class="line"></span>' : ''}</div>
      <div class="commit-copy"><strong>${escapeHtml(commit.subject)}</strong><span>${escapeHtml(commit.author)} · ${relativeTime(commit.date)}</span></div>
      <code>${escapeHtml(commit.shortHash)}</code>
    </article>`).join('')}</div>`;
}

function renderBranchPopup(s) {
  const query = ui.branchQuery.toLowerCase();
  const filtered = s.branches.filter((branch) => branch.name.toLowerCase().includes(query));
  const local = filtered.filter((branch) => !branch.remote);
  const remote = filtered.filter((branch) => branch.remote);
  const rows = (items) => items.map((branch) => `<button class="branch-row ${branch.current ? 'current' : ''}" data-checkout="${escapeHtml(branch.name)}" data-remote="${branch.remote}" ${ui.busy ? 'disabled' : ''}>
      <span>${branch.current ? '✓' : '⑂'}</span><span class="branch-row-name">${escapeHtml(branch.name)}</span>${branch.tracking ? `<small>${escapeHtml(branch.tracking)}</small>` : ''}
    </button>`).join('');
  return `<div class="branch-overlay ${ui.branchOpen ? 'open' : ''}" ${ui.branchOpen ? '' : 'inert'} aria-hidden="${!ui.branchOpen}"><div class="scrim" data-action="close-branches"></div><aside class="branch-popup" role="dialog" aria-modal="true" aria-label="Git branches">
    <div class="popup-title"><strong>Git Branches</strong><button class="icon-button" aria-label="Close branches" data-action="close-branches">×</button></div>
    <div class="search-wrap"><span>⌕</span><input id="branch-search" aria-label="Search branches" placeholder="Search branches" value="${escapeHtml(ui.branchQuery)}"></div>
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
  if ((action === 'fetch' || action === 'pull' || action === 'push') && !ui.busy) post(action);
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
  element.innerHTML = `<span>${phase === 'success' ? '✓' : phase === 'loading' ? '↻' : '!'}</span><p>${escapeHtml(message)}</p>`;
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
  if (message.type === 'snapshot') {
    const fingerprint = JSON.stringify(message.payload);
    if (fingerprint === lastSnapshot) return;
    lastSnapshot = fingerprint;
    ui.snapshot = message.payload;
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
  if (message.type === 'empty') { ui.snapshot = undefined; lastSnapshot = ''; render(); }
  if (message.type === 'operation') {
    if (message.id && message.id < ui.operationId) return;
    if (message.id) ui.operationId = message.id;
    document.querySelectorAll('.toast.loading').forEach((item) => dismissToast(item));
    ui.busy = message.phase === 'loading';
    ui.operationKind = message.phase === 'loading' ? message.kind : undefined;
    if (message.phase === 'success' && message.clearsCommit) { ui.commitMessage = ''; ui.selected.clear(); persist(); }
    toast(message.message, message.phase);
    render();
    if (message.phase === 'success' && message.clearsCommit) {
      const textarea = app.querySelector('#commit-message');
      if (textarea) textarea.value = '';
    }
    if (message.phase === 'error') ui.branchMotion = undefined;
  }
  if (message.type === 'notice') toast(message.message, message.phase || 'error');
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (ui.listMenuId) {
    event.preventDefault();
    const id = ui.listMenuId;
    ui.listMenuId = undefined;
    render();
    requestAnimationFrame(() => [...app.querySelectorAll('[data-list-menu]')].find((button) => button.dataset.listMenu === id)?.focus());
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
  if (!ui.listMenuId || event.target.closest('.list-menu, .list-more')) return;
  ui.listMenuId = undefined;
  render();
});

post('ready');
render();
