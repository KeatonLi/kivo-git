import assert from 'node:assert/strict';

// A synthetic octopus merge with 12 live lanes, interior commits, and a branch
// ending under a populated fan. Inject the same snapshot the webview consumes;
// do not fake the SVG or render against commits from the working repository.
const laneCount = 12;
const inspectedLane = 8;
const inspectedSubject = 'Validate an interior integration';
const inspectedPath = 'src/integration/Validation.ts';
const hash = (id) => `d${id.toString(16).padStart(39, '0')}`;
const through = (count, excluded, compact = false) => Array.from({ length: count }, (_, from) => from === excluded ? [] : [
  { from, to: compact && from > excluded ? from - 1 : from, kind: 'through' }
]).flat();

export async function openDenseHistory(page, openSurface) {
  await page.setViewportSize({ width: 1450, height: 650 });
  await openSurface('surface=history');

  const tips = Array.from({ length: laneCount }, (_, lane) => hash(lane + 20));
  const commits = [
    { hash: hash(1), lane: 0, subject: 'Merge the integration branches', parents: [...tips], incomingLanes: [], hasIncoming: false,
      parentLanes: tips.map((_, lane) => lane), laneTransitions: tips.map((_, lane) => ({ from: 0, to: lane, kind: 'parent' })),
      refs: [{ name: 'feature/integration', kind: 'local', current: true }] },
    ...[1, 5, inspectedLane, 10].map((lane, index) => ({ hash: tips[lane], lane,
      subject: lane === inspectedLane ? inspectedSubject : `Review integration path ${lane + 1}`,
      body: lane === inspectedLane ? 'Check the validation results before publishing the integration.' : '',
      paths: lane === inspectedLane ? [inspectedPath, 'docs/Integration.md'] : undefined,
      parents: [hash(index + 40)], parentLanes: [lane], incomingLanes: tips.map((_, i) => i), hasIncoming: true,
      laneTransitions: [...through(laneCount, lane), { from: lane, to: lane, kind: 'parent' }] }))
  ];
  for (const [index, lane] of [1, 5, inspectedLane, 10].entries()) tips[lane] = hash(index + 40);
  // End one interior path early so the remaining pass-through paths actually bend.
  const earlyEnd = 2;
  for (const lane of [earlyEnd, ...tips.map((_, lane) => lane).reverse().filter(lane => lane !== earlyEnd)]) {
    const count = laneCount - (commits.length - 5);
    const position = count === laneCount || lane < earlyEnd ? lane : lane - 1;
    commits.push({ hash: tips[lane], lane: position, subject: `Start integration path ${lane + 1}`, parents: [], parentLanes: [],
      incomingLanes: Array.from({ length: count }, (_, i) => i), hasIncoming: true,
      laneTransitions: through(count, position, true) });
  }
  await page.evaluate(commits => {
    fixture.repositoryName = 'Integration sample';
    fixture.root = '/workspace/integration-sample';
    fixture.branch = 'feature/integration';
    fixture.upstream = 'origin/feature/integration';
    fixture.headOid = commits[0].hash;
    fixture.ahead = 0;
    fixture.behind = 0;
    fixture.branches = [{ name: fixture.branch, current: true, remote: false, upstream: fixture.upstream, oid: fixture.headOid },
      { name: 'main', current: false, remote: false, oid: commits.at(-1).hash },
      { name: fixture.upstream, current: false, remote: true, oid: fixture.headOid }];
    fixture.tags = [];
    fixture.commitsHasMore = false;
    fixture.commits = commits.map((commit, index) => ({ author: index % 2 ? 'Alex Rivera' : 'Sam Nguyen', refs: [],
      date: `2026-11-18T09:${String(59 - index).padStart(2, '0')}:00Z`, body: '',
      ...commit, paths: commit.paths ?? ['src/integration/Graph.ts'], shortHash: commit.hash.slice(-7) }));
    emit({ type: 'snapshot', payload: fixture });
  }, commits);
  await page.locator('[data-graph-list].graph-compressed').waitFor();
  return { head: commits[0].hash, inspected: commits[3].hash, bend: commits[5].hash, keyboard: commits[4].hash };
}

async function edgeState(row) {
  return row.locator('.graph-edge').evaluateAll(edges => edges.map(edge => {
    const style = getComputedStyle(edge);
    return { lane: Number(edge.dataset.lane), primary: edge.dataset.primary === 'true',
      role: ['through', 'incoming', 'outgoing'].find(role => edge.classList.contains(role)),
      d: edge.getAttribute('d'), ink: [style.stroke, style.strokeOpacity, style.strokeWidth, style.opacity] };
  }));
}

async function rowActionVisible(action) {
  return action.evaluate(element => {
    const style = getComputedStyle(element);
    return element.getBoundingClientRect().width > 0 && style.visibility === 'visible' && Number(style.opacity) > .9;
  });
}

async function verifyGraphAndDetails(page, openSurface) {
  const { head, inspected, bend, keyboard } = await openDenseHistory(page, openSurface);
  const row = hash => page.locator(`[data-commit="${hash}"]`);
  const target = row(inspected);
  const action = target.locator('[data-commit-row-menu]');
  const subject = target.locator('.log-subject strong');
  const list = page.locator('[data-graph-list]');
  const search = page.locator('#graph-search');
  await search.hover();
  assert.match(await list.getAttribute('aria-label'), /compact 12-lane topology/);
  assert.equal(await row(head).locator('.graph-node.merge[data-lane="0"]').count(), 1);
  assert.equal(await row(head).locator('.graph-edge.outgoing').count(), laneCount, 'The octopus merge needs all of its parent edges.');
  assert.equal(await target.locator(`.graph-node[data-lane="${inspectedLane}"]`).count(), 1, 'Lane IDs must be actual topology indices, not palette indices.');
  assert.equal(await row(bend).locator('.graph-edge.through[data-lane="9"]').evaluate(edge => {
    const start = edge.getPointAtLength(0), end = edge.getPointAtLength(edge.getTotalLength());
    return start.x > end.x && end.y > start.y;
  }), true, 'After an interior branch ends, retained lanes must bend into their new slots.');

  const idle = await edgeState(target);
  assert.deepEqual(idle.filter(edge => edge.role === 'through').map(edge => edge.lane),
    [0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 11], 'Every inactive through lane must remain in the real SVG.');
  assert.deepEqual(idle.filter(edge => edge.role !== 'through').map(edge => [edge.role, edge.lane]),
    [['incoming', inspectedLane], ['outgoing', inspectedLane]]);
  assert.equal(idle.some(edge => edge.primary), false, 'A lane index is not a current-branch marker.');
  assert.ok(idle.every(edge => edge.ink[0] !== 'none' && edge.ink.slice(1).every(value => Number.parseFloat(value) > 0)),
    'Muted lanes must still draw a visible stroke.');
  assert.ok(Number(idle.find(edge => edge.role === 'through').ink[3]) < Number(idle.find(edge => edge.role === 'incoming').ink[3]), 'Through lanes should not dominate connected edges.');
  assert.equal(await action.getAttribute('aria-hidden'), 'true', 'The row keyboard shortcut avoids making every ellipsis another Tab stop.');
  assert.equal(await rowActionVisible(action), false, 'Idle row actions should not compete with commit titles.');
  const titleWidth = (await subject.boundingBox()).width;
  assert.equal(await target.evaluate(element => {
    const subject = element.querySelector('.log-subject');
    const author = element.querySelector('.log-meta .log-author');
    return element.getBoundingClientRect().height === 44 &&
      subject.getBoundingClientRect().bottom <= author.getBoundingClientRect().top + 1 &&
      !!element.querySelector('.log-meta code')?.textContent;
  }), true, 'A 44px row puts the author and hash below the commit title.');

  await subject.hover();
  assert.equal(await target.getAttribute('aria-selected'), 'false', 'Hover must not change the selected commit.');
  assert.equal(await rowActionVisible(action), true);
  assert.equal((await subject.boundingBox()).width, titleWidth, 'Revealing a row action must not resize its subject.');
  const hovered = await edgeState(target);
  for (const [index, edge] of hovered.entries()) {
    assert.equal(edge.d, idle[index].d, 'Hover must not move SVG topology.');
    if (edge.role === 'through') assert.deepEqual(edge.ink, idle[index].ink, 'Hover does not emphasize unrelated through lanes.');
    else assert.notDeepEqual(edge.ink, idle[index].ink, 'Hover emphasizes connected edges.');
  }

  const menu = page.locator('[data-commit-context]');
  await action.click();
  await menu.waitFor();
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'hidden' });
  await page.waitForFunction(hash => document.activeElement?.dataset.commit === hash, inspected);
  await search.click();
  assert.equal(await target.getAttribute('aria-selected'), 'true');
  assert.equal(await rowActionVisible(action), true, 'The selected row should retain its affordance without hover or focus.');
  assert.deepEqual(await edgeState(target), hovered, 'Selection keeps the inspected styling and original topology without hover.');

  const details = page.locator('#kivo-log-details');
  const file = details.locator(`[data-commit-file="${inspectedPath}"]`);
  await file.waitFor();
  assert.equal(await details.locator('.commit-detail-head strong').textContent(), inspectedSubject);
  assert.match(await details.locator('.commit-body').textContent(), /Check the validation results/);
  assert.equal(await details.evaluate(element => {
    const summary = element.querySelector('.commit-metadata');
    const files = element.querySelector('.commit-files-panel');
    return Boolean(summary.compareDocumentPosition(files) & Node.DOCUMENT_POSITION_FOLLOWING) &&
      summary.getBoundingClientRect().bottom <= files.getBoundingClientRect().top + 1;
  }), true, 'Commit summary must precede Changed Files within the same details pane.');
  await file.click();
  assert.ok(await page.evaluate(({ hash, path }) => window.__vscodeMessages.some(message => message.type === 'openCommitDiff' &&
    message.hash === hash && message.path === path), { hash: inspected, path: inspectedPath }), 'The re-ordered file tree must still open the exact immutable diff.');

  await page.locator('[data-action="locate-history-head"]').click();
  await page.waitForFunction(hash => document.activeElement?.dataset.commit === hash, head);
  assert.equal(await row(head).getAttribute('aria-selected'), 'true');
  await search.focus();
  await page.keyboard.press('Tab');
  // Move focus by keyboard modality, then exercise the keyboard path on a row.
  const next = row(keyboard);
  await next.focus();
  assert.equal(await rowActionVisible(next.locator('[data-commit-row-menu]')), true, 'Keyboard focus reveals the action on an unselected row.');
  await page.keyboard.press('Shift+F10');
  await menu.waitFor();
  await menu.locator('[data-commit-context-action="copy"]').click();
  await menu.waitFor({ state: 'hidden' });
  assert.ok(await page.evaluate(hash => window.__vscodeMessages.some(message => message.type === 'copyCommitHash' && message.hash === hash), keyboard),
    'The keyboard menu must act on the focused commit.');

  const wideGraph = (await target.locator('.graph-svg').boundingBox()).width;
  await page.setViewportSize({ width: 960, height: 500 });
  await page.waitForFunction(({ hash, wideGraph }) => document.querySelector(`[data-commit="${hash}"] .graph-svg`)
    ?.getBoundingClientRect().width < wideGraph, { hash: inspected, wideGraph });
  assert.equal(await target.locator('.graph-edge').count(), idle.length, 'Narrow layouts compress spacing, not topology.');
  assert.ok((await subject.boundingBox()).width >= 88, 'Dense lanes must leave room to read the subject in a narrow History panel.');

  await page.setViewportSize({ width: 400, height: 520 });
  const long = '修复并验证分支和文件历史在窄面板中的完整显示 · preserve every visible detail when the History panel is narrow · END OF SUBJECT';
  await page.evaluate(({ inspected, long }) => {
    fixture.commits = fixture.commits.map(commit => commit.hash === inspected ? { ...commit, subject: long, refs: [{ name: 'feature/long-branch-label-that-must-remain-readable', kind: 'local' }], unpushedTo: 'origin/main' } : commit);
    emit({ type: 'snapshot', payload: fixture });
  }, { inspected, long });
  await page.waitForFunction(hash => document.querySelector(`[data-commit="${hash}"] .log-subject strong`)?.textContent.endsWith('END OF SUBJECT'), inspected);
  assert.ok(await target.evaluate(element => {
    const title = element.querySelector('strong');
    const meta = element.querySelector('.log-meta');
    const bounds = element.getBoundingClientRect();
    const last = document.createRange();
    last.selectNodeContents(title);
    const titleRects = [...last.getClientRects()];
    return titleRects.length > 1 && element.offsetHeight > 44 && titleRects.every(rect => rect.right <= bounds.right + 1) &&
      ['.log-author', 'code', 'time', '.unpushed-badge', '.graph-ref'].every(selector => {
        const item = meta.querySelector(selector);
        const rect = item.getBoundingClientRect();
        return rect.width > 0 && rect.bottom <= bounds.bottom + 1 && item.scrollWidth <= item.clientWidth + 1;
      });
  }), 'Long titles wrap and every key metadata field stays within the same row on narrow panels.');
}

async function verifyFilterDisclosure(page, openSurface) {
  await page.setViewportSize({ width: 960, height: 500 });
  await openSurface('surface=history');
  const search = page.locator('#graph-search');
  const ref = page.locator('select[data-graph-filter="branch"]');
  const trigger = page.getByRole('button', { name: /^Advanced filters/ });
  const badge = trigger.locator('.history-filters-count');
  const panel = page.locator('#kivo-history-filters');
  const author = panel.locator('#graph-author');
  const date = panel.locator('[data-graph-filter="age"]');
  const paths = panel.locator('#graph-path');
  const reset = panel.locator('[data-action="clear-graph-filters"]');
  const list = page.locator('[data-graph-list]');
  const initialCount = await list.getAttribute('aria-setsize');
  const listTop = (await list.boundingBox()).y;
  const [searchRect, refRect, triggerRect] = await Promise.all([search.boundingBox(), ref.boundingBox(), trigger.boundingBox()]);
  const centerY = box => box.y + box.height / 2;
  assert.ok(searchRect && refRect && triggerRect && searchRect.x < refRect.x && refRect.x < triggerRect.x &&
    [refRect, triggerRect].every(box => Math.abs(centerY(searchRect) - centerY(box)) <= 2),
    'Narrow History must keep Search, All refs, and Advanced filters visible in order on the same row.');
  assert.equal(await ref.locator('option:checked').textContent(), 'All refs');
  assert.equal(await ref.locator('option[value="v1.0.0"]').count(), 1, 'The native selector also includes tags.');
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(await trigger.getAttribute('aria-controls'), 'kivo-history-filters');
  assert.equal(await panel.isVisible(), false);

  await trigger.press('Enter');
  await panel.waitFor();
  assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
  assert.equal((await list.boundingBox()).y, listTop, 'The disclosure overlays instead of adding a second toolbar row.');
  assert.equal(await panel.locator('select[data-graph-filter="branch"]').count(), 0, 'The ref is not an advanced filter.');
  assert.deepEqual(await panel.locator('.graph-filter > span').allTextContents(), ['Author', 'Date', 'Paths']);
  assert.equal(await reset.isDisabled(), true, 'Reset does not imply active filters when the inputs are empty.');
  assert.equal(await author.evaluate(element => element === document.activeElement), true);
  await page.keyboard.insertText('jarvan.jiang');
  await page.waitForFunction(initial => {
    const list = document.querySelector('[data-graph-list]');
    const count = Number(list.getAttribute('aria-setsize'));
    return list.getAttribute('aria-busy') === 'false' && count > 0 && count < Number(initial);
  }, initialCount);
  const selected = await page.locator('.graph-row.selected').getAttribute('data-commit');
  await page.keyboard.press('Escape');
  await panel.waitFor({ state: 'hidden' });
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(await trigger.evaluate(element => document.activeElement === element), true);
  assert.equal(await badge.textContent(), '1', 'An active advanced filter stays discoverable while its controls are hidden.');
  assert.equal(await page.locator('.graph-row.selected').getAttribute('data-commit'), selected);
  await trigger.click();
  assert.equal(await author.inputValue(), 'jarvan.jiang', 'Closing Filters must not clear its active values.');
  await reset.click();
  assert.equal(await author.inputValue(), '');
  assert.equal(await list.getAttribute('aria-setsize'), initialCount);
  await search.click();
  await panel.waitFor({ state: 'hidden' });
  assert.equal(await search.evaluate(element => document.activeElement === element), true, 'Outside dismissal does not steal focus.');

  await ref.selectOption('origin/master');
  assert.equal(await ref.inputValue(), 'origin/master');
  assert.equal(await badge.isVisible(), false, 'The current ref does not count as an advanced filter.');
  assert.equal(await panel.isVisible(), false, 'Changing the ref does not open Advanced filters.');
  assert.deepEqual(await page.evaluate(() => window.__vscodeMessages
    .filter(message => ['setHistoryRef', 'checkout', 'checkoutRevision'].includes(message.type)).map(({ type, branch }) => [type, branch])),
    [['setHistoryRef', 'origin/master']], 'Browsing a ref requests History without checking out anything.');
  await trigger.click();
  assert.equal(await reset.isEnabled(), true, 'Reset is available even when only the ref has changed.');
  await search.fill('test');
  assert.equal(await badge.isVisible(), false, 'The text search does not count as an advanced filter.');
  await trigger.click();
  await author.fill('jarvan.jiang');
  await date.selectOption('7d');
  await paths.fill('src');
  assert.equal(await badge.textContent(), '3');
  await reset.click();
  assert.deepEqual(await Promise.all([search.inputValue(), ref.inputValue(), author.inputValue(), date.inputValue(), paths.inputValue()]), ['', '', '', 'all', '']);
  assert.equal(await badge.isVisible(), false);
  assert.equal(await page.evaluate(() => window.__vscodeMessages.filter(message => message.type === 'setHistoryRef').at(-1)?.branch), '');

  await page.setViewportSize({ width: 360, height: 130 });
  await openSurface('surface=history');
  await page.evaluate(() => { document.body.dataset.locale = 'zh'; });
  await page.locator('[data-action="toggle-history-filters"]').click();
  assert.equal(await page.getByRole('button', { name: '高级筛选' }).getAttribute('aria-expanded'), 'true');
  assert.equal(await search.getAttribute('placeholder'), '搜索提交或哈希');
  assert.equal(await ref.locator('option:checked').textContent(), '所有引用');
  assert.deepEqual(await panel.locator('.graph-filter > span').allTextContents(), ['作者', '日期', '路径']);
  assert.equal(await reset.textContent(), '重置');
  const panelRect = await panel.boundingBox();
  assert.ok(panelRect && panelRect.x >= 0 && panelRect.y >= 0 && panelRect.x + panelRect.width <= 360 && panelRect.y + panelRect.height <= 130,
    'The advanced panel must stay inside a short, narrow viewport.');
  assert.equal(await panel.evaluate(element => element.scrollHeight > element.clientHeight), true, 'Clipped controls remain scrollable.');
}

export async function verifyHistoryPresentation(page, openSurface) {
  const viewport = page.viewportSize();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  try {
    await verifyFilterDisclosure(page, openSurface);
    await verifyGraphAndDetails(page, openSurface);
    console.log('History presentation passed: dense topology, lane hierarchy, row actions, details order, and filter disclosure.');
  } finally {
    await page.emulateMedia({ reducedMotion: null });
    await page.setViewportSize(viewport);
  }
}
