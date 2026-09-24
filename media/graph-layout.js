(function attachKivoGraphLayout(scope) {
  const GRAPH_MIN_WIDTH = 64;
  const GRAPH_DEFAULT_LANE_WIDTH = 16;
  const GRAPH_PADDING = 20;

  const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

  function laneValues(commit) {
    return [commit?.lane, ...(commit?.incomingLanes || []), ...(commit?.parentLanes || [])]
      .filter((lane) => Number.isFinite(lane))
      .map(Number);
  }

  /**
   * Keeps dense Git topology readable without allowing one highly divergent
   * history window to consume the Commit column. Lanes remain in their real
   * order; only their spacing adapts to the available graph column budget.
   */
  function layout(commits, options = {}) {
    const maximumWidth = Math.max(
      GRAPH_MIN_WIDTH,
      Math.floor(options.maximumWidth ?? 176)
    );
    const lanes = (commits || []).flatMap(laneValues);
    const laneCount = lanes.length ? Math.max(1, Math.max(...lanes) + 1) : 1;
    const laneWidth = Math.min(
      GRAPH_DEFAULT_LANE_WIDTH,
      Math.max(1, (maximumWidth - GRAPH_PADDING) / laneCount)
    );
    const graphWidth = clamp(
      Math.ceil(laneCount * laneWidth + GRAPH_PADDING),
      GRAPH_MIN_WIDTH,
      maximumWidth
    );
    const nodeRadius = clamp(3.6 * (laneWidth / GRAPH_DEFAULT_LANE_WIDTH), 1.2, 3.6);
    return {
      laneCount,
      laneWidth,
      graphWidth,
      nodeRadius,
      mergeNodeRadius: clamp(nodeRadius + .9, 1.8, 4.5),
      compressed: laneWidth < GRAPH_DEFAULT_LANE_WIDTH
    };
  }

  /**
   * Return the small, overscanned portion of a long history that should exist
   * in the DOM. The complete commit sequence stays in memory so its graph
   * topology is untouched; this only avoids rendering thousands of rows.
   */
  function visibleRange(length, options = {}) {
    const total = Math.max(0, Math.floor(Number(length) || 0));
    const rowHeight = Math.max(1, Math.floor(Number(options.rowHeight) || 26));
    const viewportHeight = Math.max(rowHeight, Math.floor(Number(options.viewportHeight) || rowHeight * 18));
    const overscan = Math.max(0, Math.floor(Number(options.overscan) || 0));
    const totalHeight = total * rowHeight;
    const maximumScrollTop = Math.max(0, totalHeight - viewportHeight);
    const scrollTop = Math.max(0, Math.min(Number(options.scrollTop) || 0, maximumScrollTop));
    const firstVisible = Math.floor(scrollTop / rowHeight);
    const visibleRows = Math.max(1, Math.ceil(viewportHeight / rowHeight));
    const start = Math.max(0, firstVisible - overscan);
    const end = Math.min(total, firstVisible + visibleRows + overscan);
    return {
      start,
      end,
      scrollTop,
      topSpacer: start * rowHeight,
      bottomSpacer: Math.max(0, total - end) * rowHeight,
      totalHeight
    };
  }

  scope.KivoGraphLayout = { layout, visibleRange };
})(globalThis);
