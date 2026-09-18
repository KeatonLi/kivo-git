const vscode = acquireVsCodeApi();
const app = document.querySelector('#app');
const toastRegion = document.querySelector('#toast-region');

const ui = {
  snapshot: undefined,
  tab: 'changes',
  selected: new Set(),
  collapsed: new Set(),
  branchOpen: false,
  branchQuery: '',
  busy: false,
  commitMessage: ''
};

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

function render() {
  const s = ui.snapshot;
  if (!s) {
    app.innerHTML = `<section class="empty-state"><div class="empty-mark">⑂</div><h2>Open a Git repository</h2><p>IdeaGit will appear here when the workspace is ready.</p><button data-action="refresh">Refresh</button></section>`;
    bind();
    return;
  }
  const changeCount = s.changes.length;
  app.innerHTML = `
    <header class="repo-header">
      <button class="branch-pill" data-action="branches" aria-expanded="${ui.branchOpen}">
        <span class="branch-symbol">⑂</span><span class="branch-name">${escapeHtml(s.branch)}</span>
        ${s.ahead ? `<span class="sync up">↑${s.ahead}</span>` : ''}${s.behind ? `<span class="sync down">↓${s.behind}</span>` : ''}
        <span class="chevron">⌄</span>
      </button>
      <div class="repo-actions">
        <button class="icon-button" title="Fetch" data-action="fetch">↻</button>
        <button class="icon-button" title="Pull" data-action="pull">↓</button>
        <button class="icon-button" title="Push" data-action="push">↑</button>
      </div>
    </header>
    <nav class="tabs" aria-label="Git views">
      <button class="tab ${ui.tab === 'changes' ? 'active' : ''}" data-tab="changes">Changes <span>${changeCount}</span></button>
      <button class="tab ${ui.tab === 'log' ? 'active' : ''}" data-tab="log">Log</button>
    </nav>
    <section class="content ${ui.busy ? 'is-busy' : ''}">
      ${ui.tab === 'changes' ? renderChanges(s) : renderLog(s)}
    </section>
    ${renderBranchPopup(s)}
  `;
  bind();
}

function renderChanges(s) {
  const lists = s.changelists.map((list) => {
    const collapsed = ui.collapsed.has(list.id);
    return `<section class="changelist ${collapsed ? 'collapsed' : ''}" data-list-id="${escapeHtml(list.id)}">
      <button class="list-heading" data-collapse="${escapeHtml(list.id)}">
        <span class="disclosure">⌄</span><span class="list-name">${escapeHtml(list.name)}</span><span class="count">${list.changes.length}</span>
      </button>
      <div class="file-list" data-drop-list="${escapeHtml(list.id)}">
        ${list.changes.length ? list.changes.map(renderFile).join('') : '<div class="drop-hint">Drop files here</div>'}
      </div>
    </section>`;
  }).join('');
  const selectedCount = ui.selected.size;
  return `
    <div class="section-toolbar"><span>LOCAL CHANGES</span><button class="text-button" data-action="new-list">＋ Changelist</button></div>
    <div class="lists">${lists}</div>
    <footer class="commit-panel">
      <textarea id="commit-message" rows="3" placeholder="Commit message…" spellcheck="true">${escapeHtml(ui.commitMessage)}</textarea>
      <div class="commit-meta"><span>${selectedCount || 'No'} file${selectedCount === 1 ? '' : 's'} selected</span><span class="shortcut">⌘ Enter</span></div>
      <button class="primary-button" data-action="commit" ${!selectedCount || ui.busy ? 'disabled' : ''}><span class="button-label">Commit</span><span class="button-arrow">⌄</span></button>
    </footer>`;
}

function renderFile(change) {
  const checked = ui.selected.has(change.path);
  const filename = change.path.split('/').pop();
  const parent = change.path.includes('/') ? change.path.slice(0, change.path.lastIndexOf('/')) : '';
  return `<div class="file-row ${checked ? 'selected' : ''}" draggable="true" data-path="${escapeHtml(change.path)}" title="${escapeHtml(change.path)}">
    <label class="check"><input type="checkbox" data-select="${escapeHtml(change.path)}" ${checked ? 'checked' : ''}><span></span></label>
    <button class="file-main" data-diff="${escapeHtml(change.path)}" data-original-path="${escapeHtml(change.originalPath || '')}" data-kind="${escapeHtml(change.kind)}">
      <span class="file-name">${escapeHtml(filename)}</span>${parent ? `<span class="file-parent">${escapeHtml(parent)}</span>` : ''}
    </button>
    <span class="status ${change.kind}">${iconFor(change.kind)}</span>
  </div>`;
}

function renderLog(s) {
  if (!s.commits.length) return '<div class="inline-empty">No commits yet</div>';
  return `<div class="log-list">${s.commits.map((commit, index) => `
    <article class="commit-row" style="--delay:${Math.min(index * 14, 180)}ms">
      <div class="graph"><span class="node"></span>${index < s.commits.length - 1 ? '<span class="line"></span>' : ''}</div>
      <div class="commit-copy"><strong>${escapeHtml(commit.subject)}</strong><span>${escapeHtml(commit.author)} · ${relativeTime(commit.date)}</span></div>
      <code>${escapeHtml(commit.shortHash)}</code>
    </article>`).join('')}</div>`;
}

function renderBranchPopup(s) {
  if (!ui.branchOpen) return '';
  const query = ui.branchQuery.toLowerCase();
  const filtered = s.branches.filter((branch) => branch.name.toLowerCase().includes(query));
  const local = filtered.filter((branch) => !branch.remote);
  const remote = filtered.filter((branch) => branch.remote);
  const rows = (items) => items.map((branch) => `<button class="branch-row ${branch.current ? 'current' : ''}" data-checkout="${escapeHtml(branch.name)}" data-remote="${branch.remote}">
      <span>${branch.current ? '✓' : '⑂'}</span><span class="branch-row-name">${escapeHtml(branch.name)}</span>${branch.tracking ? `<small>${escapeHtml(branch.tracking)}</small>` : ''}
    </button>`).join('');
  return `<div class="scrim" data-action="close-branches"></div><aside class="branch-popup">
    <div class="popup-title"><strong>Git Branches</strong><button class="icon-button" data-action="close-branches">×</button></div>
    <div class="search-wrap"><span>⌕</span><input id="branch-search" placeholder="Search branches" value="${escapeHtml(ui.branchQuery)}"></div>
    <div class="branch-groups"><h3>LOCAL BRANCHES</h3>${rows(local) || '<p class="no-results">No local branches</p>'}<h3>REMOTE BRANCHES</h3>${rows(remote) || '<p class="no-results">No remote branches</p>'}</div>
  </aside>`;
}

function bind() {
  app.querySelectorAll('[data-tab]').forEach((button) => button.addEventListener('click', () => { ui.tab = button.dataset.tab; render(); }));
  app.querySelectorAll('[data-action]').forEach((button) => button.addEventListener('click', () => handleAction(button.dataset.action)));
  app.querySelectorAll('[data-collapse]').forEach((button) => button.addEventListener('click', () => {
    const id = button.dataset.collapse;
    ui.collapsed.has(id) ? ui.collapsed.delete(id) : ui.collapsed.add(id);
    render();
  }));
  app.querySelectorAll('[data-select]').forEach((input) => input.addEventListener('change', () => {
    input.checked ? ui.selected.add(input.dataset.select) : ui.selected.delete(input.dataset.select);
    render();
  }));
  app.querySelectorAll('[data-diff]').forEach((button) => button.addEventListener('dblclick', () => post('openDiff', {
    path: button.dataset.diff,
    originalPath: button.dataset.originalPath || undefined,
    kind: button.dataset.kind
  })));
  app.querySelectorAll('[data-checkout]').forEach((button) => button.addEventListener('click', () => {
    if (button.classList.contains('current')) return;
    ui.branchOpen = false;
    post('checkout', { branch: button.dataset.checkout, remote: button.dataset.remote === 'true' });
    render();
  }));
  app.querySelectorAll('[draggable="true"]').forEach((row) => row.addEventListener('dragstart', (event) => {
    const paths = ui.selected.has(row.dataset.path) ? [...ui.selected] : [row.dataset.path];
    event.dataTransfer.setData('application/x-ideagit-paths', JSON.stringify(paths));
    event.dataTransfer.effectAllowed = 'move';
    row.classList.add('dragging');
  }));
  app.querySelectorAll('[data-drop-list]').forEach((zone) => {
    zone.addEventListener('dragover', (event) => { event.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', (event) => {
      event.preventDefault();
      zone.classList.remove('drag-over');
      const paths = JSON.parse(event.dataTransfer.getData('application/x-ideagit-paths') || '[]');
      if (paths.length) post('moveFiles', { paths, listId: zone.dataset.dropList });
    });
  });
  const textarea = app.querySelector('#commit-message');
  if (textarea) {
    textarea.addEventListener('input', () => { ui.commitMessage = textarea.value; });
    textarea.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); commit(); }
    });
  }
  const search = app.querySelector('#branch-search');
  if (search) search.addEventListener('input', () => { ui.branchQuery = search.value; render(); app.querySelector('#branch-search')?.focus(); });
}

function handleAction(action) {
  if (action === 'refresh') post('refresh');
  if (action === 'fetch' || action === 'pull' || action === 'push') post(action);
  if (action === 'branches') { ui.branchOpen = !ui.branchOpen; render(); setTimeout(() => app.querySelector('#branch-search')?.focus(), 30); }
  if (action === 'close-branches') { ui.branchOpen = false; render(); }
  if (action === 'new-list') {
    const name = prompt('New changelist name');
    if (name?.trim()) post('createChangelist', { name });
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
  if (phase !== 'loading') setTimeout(() => element.remove(), 2800);
  return element;
}

window.addEventListener('message', (event) => {
  const message = event.data;
  if (message.type === 'snapshot') {
    ui.snapshot = message.payload;
    const valid = new Set(message.payload.changes.map((change) => change.path));
    ui.selected = new Set([...ui.selected].filter((path) => valid.has(path)));
    ui.busy = false;
    render();
  }
  if (message.type === 'empty') { ui.snapshot = undefined; render(); }
  if (message.type === 'operation') {
    document.querySelectorAll('.toast.loading').forEach((item) => item.remove());
    ui.busy = message.phase === 'loading';
    if (message.phase === 'success') { ui.commitMessage = ''; ui.selected.clear(); }
    toast(message.message, message.phase);
    render();
  }
});

post('ready');
render();
