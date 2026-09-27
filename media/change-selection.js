(function (scope) {
  function matches(change, filter = 'all', query = '') {
    const stateMatches = filter === 'staged' ? change.staged && change.kind !== 'conflict'
      : filter === 'worktree' ? change.workingTreeStatus !== '.'
        : filter === 'all' || change.kind === filter;
    return Boolean(stateMatches && `${change.path} ${change.kind} ${change.indexStatus} ${change.workingTreeStatus}`.toLowerCase().includes(query.trim().toLowerCase()));
  }

  function model(snapshot, { filter = 'all', query = '', collapsed = new Set(), selected = new Set() } = {}) {
    const lists = (snapshot?.changelists || []).map((list) => ({ ...list, changes: list.changes.filter((change) => matches(change, filter, query)) }));
    const filteredPaths = new Set(lists.flatMap((list) => list.changes.map((change) => change.path)));
    const visiblePaths = lists.filter((list) => !collapsed.has(list.id)).flatMap((list) => list.changes.map((change) => change.path));
    const selectedChanges = (snapshot?.changes || []).filter((change) => selected.has(change.path));
    return { lists, filteredPaths, visiblePaths, selectedChanges,
      hiddenCount: selectedChanges.filter((change) => !filteredPaths.has(change.path)).length };
  }

  function range(paths, anchor, target) {
    const start = paths.indexOf(anchor);
    const end = paths.indexOf(target);
    return start >= 0 && end >= 0 ? paths.slice(Math.min(start, end), Math.max(start, end) + 1) : paths.includes(target) ? [target] : [];
  }

  scope.KivoChangeSelection = { matches, model, range };
})(globalThis);
