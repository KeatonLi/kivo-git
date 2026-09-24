import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

async function graphLayout() {
  const source = await readFile(path.join(root, 'media', 'graph-layout.js'), 'utf8');
  const context: Record<string, unknown> = {};
  context.globalThis = context;
  runInNewContext(source, context);
  return context.KivoGraphLayout as { layout: Function; visibleRange: Function };
}

describe('Kivo Graph dynamic layout', () => {
  it('keeps a dense, multi-lane graph inside its column budget', async () => {
    const { layout } = await graphLayout();
    const commits = Array.from({ length: 48 }, (_, lane) => ({ lane, incomingLanes: [], parentLanes: [] }));
    const result = layout(commits, { maximumWidth: 176 });

    expect(result).toMatchObject({ laneCount: 48, compressed: true });
    expect(result.graphWidth).toBeLessThanOrEqual(176);
    expect(result.laneWidth).toBeLessThan(16);
    expect(result.nodeRadius).toBeGreaterThanOrEqual(1.2);
  });

  it('only renders an overscanned history window while retaining the full scroll height', async () => {
    const { visibleRange } = await graphLayout();
    const result = visibleRange(1_000, {
      scrollTop: 26 * 400,
      viewportHeight: 26 * 10,
      rowHeight: 26,
      overscan: 6
    });

    expect(result).toMatchObject({ start: 394, end: 416, topSpacer: 26 * 394, bottomSpacer: 26 * 584, totalHeight: 26_000 });
    expect(result.end - result.start).toBeLessThan(30);
  });

  it('keeps a compact single-lane graph at the IDEA-sized minimum', async () => {
    const { layout } = await graphLayout();
    const result = layout([{ lane: 0, incomingLanes: [], parentLanes: [] }], { maximumWidth: 176 });

    expect(result).toMatchObject({ laneCount: 1, laneWidth: 16, graphWidth: 64, compressed: false });
  });
});
