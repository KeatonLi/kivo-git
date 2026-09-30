import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  throw new Error('Playwright is required. Install the pinned test dependency with `npm install --no-save --package-lock=false playwright@1.62.1`.');
}

const port = Number(process.env.KIVO_WEBVIEW_TEST_PORT || 4174);
const baseUrl = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [path.join(root, 'scripts', 'visual-server.mjs'), '--host', '127.0.0.1', '--port', String(port)], {
  cwd: root,
  stdio: 'ignore'
});
let browser;

async function waitForServer() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Visual fixture server exited with code ${server.exitCode}.`);
    try {
      const response = await fetch(`${baseUrl}/test/visual-preview.html`);
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Visual fixture server did not start at ${baseUrl}.`);
}

async function openSurface(page, query) {
  await page.goto(`${baseUrl}/test/visual-preview.html?${query}`);
  await page.waitForSelector(query.includes('surface=history') ? '.log-branch-pane' : '.commit-toolbar');
}

try {
  await waitForServer();
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 360, height: 820 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await openSurface(page, 'surface=changes&state=empty');
  const emptyList = page.locator('.file-list.empty');
  assert.equal(await emptyList.count(), 1, 'The empty changelist should remain a valid drop target.');
  assert.ok((await emptyList.evaluate((element) => element.getBoundingClientRect().height)) <= 4, 'An idle empty changelist should not reserve visible blank space.');
  const idleHint = await emptyList.evaluate((element) => getComputedStyle(element, '::after').content);
  assert.equal(idleHint, 'none', 'The drop instruction should stay hidden until dragover.');
  await emptyList.dispatchEvent('dragover');
  assert.ok((await emptyList.getAttribute('class')).includes('drag-over'), 'The drop target should enter its active state.');
  const activeHint = await emptyList.evaluate((element) => getComputedStyle(element, '::after').content);
  assert.equal(activeHint, '"Drop files here"', 'The drop instruction should appear while dragging over an empty list.');

  await openSurface(page, 'surface=changes');
  assert.equal(await page.locator('.commit-repository-name').textContent(), 'ack-k8s', 'The current repository name should be visible inside the sidebar, independent of VS Code view titles.');
  assert.match(await page.locator('.commit-repository-label').getAttribute('title'), /\/workspace\/ack-k8s/, 'Hover should expose the full repository path.');
  assert.equal(await page.locator('.commit-repository-picker').count(), 0, 'A single repository should appear as a plain label.');
  const initialLayout = await page.evaluate(() => {
    const upper = document.querySelector('.commit-upper').getBoundingClientRect();
    const tree = document.querySelector('.commit-changes-tree').getBoundingClientRect();
    const rows = [...document.querySelectorAll('[data-file-row]')].map((row) => row.getBoundingClientRect());
    return { upperHeight: upper.height, height: window.innerHeight, rowsFit: rows.every((row) => row.top >= tree.top && row.bottom <= tree.bottom) };
  });
  assert.ok(initialLayout.upperHeight > initialLayout.height * .6, 'The primary commit workflow should have most of the initial sidebar height.');
  assert.equal(initialLayout.rowsFit, true, 'All three fixture files should be visible without scrolling at the default sidebar size.');
  await page.getByRole('checkbox', { name: 'Select matching files in Default Changelist', exact: true }).check();
  assert.equal(await page.locator('[data-select]:checked').count(), 3, 'The checkbox decoration must not intercept mouse selection.');
  await page.getByRole('checkbox', { name: 'Select matching files in Default Changelist', exact: true }).uncheck();
  assert.equal(await page.locator('[data-select]:checked').count(), 0);
  assert.equal(await page.locator('.workspace-brief').count(), 0, 'The Commit view should leave repository status to History.');
  assert.equal(await page.locator('.commit-repository-context').count(), 0, 'The lower area should show recent commits without redundant status cards.');
  assert.match(await page.locator('.commit-recent').textContent(), /Recent commits/);
  assert.equal(await page.locator('[data-recent-commit]').count(), 5, 'The sidebar must show exactly five recent commits.');
  assert.equal(await page.locator('.commit-recent-branch span:last-child').textContent(), 'feature/keaton/ACKk8s');
  assert.match(await page.locator('.commit-recent-date').first().textContent(), /^\d{4}-\d{2}-\d{2}$/);
  assert.match(await page.locator('.commit-recent-row time').first().textContent(), /^\d{2}:\d{2}:\d{2}$/);
  assert.match(await page.locator('.commit-recent-row time').first().getAttribute('title'), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(await page.locator('.commit-changes-heading small').textContent(), '3 files');
  assert.equal(await page.locator('.list-heading .count').count(), 0, 'One changelist should not repeat the total count.');
  assert.equal(await page.locator('.file-group-heading').textContent(), 'Tracked', 'One file group should not repeat the total count.');
  assert.ok((await page.locator('.commit-lower').boundingBox()).height <= 288, 'Recent commits should fit their content instead of reserving a large empty panel.');
  await page.locator('#commit-message').fill('Keep this draft');
  const unselectedColor = await page.locator('.file-row .file-name').first().evaluate((element) => getComputedStyle(element).color);
  await page.locator('[data-select]').first().check({ force: true });
  const selectedColor = await page.locator('.file-row.selected .file-name').evaluate((element) => getComputedStyle(element).color);
  assert.equal(selectedColor, unselectedColor, 'Selection must retain the file change color.');
  await page.getByRole('button', { name: 'Collapse recent commits', exact: true }).click();
  assert.equal(await page.locator('.commit-recent-list').isVisible(), false);
  assert.equal(await page.locator('#commit-message').inputValue(), 'Keep this draft', 'Collapsing recent commits must preserve the draft.');
  assert.equal(await page.locator('[data-select]:checked').count(), 1, 'Collapsing recent commits must preserve the selection.');
  assert.ok((await page.locator('.commit-lower').boundingBox()).height <= 34, 'Collapsed history should occupy only its heading.');
  await page.getByRole('button', { name: 'Expand recent commits', exact: true }).click();
  await page.locator('[data-select]').first().uncheck({ force: true });
  await page.locator('#commit-message').fill('');
  await page.locator('[data-recent-commit]').first().click();
  await page.waitForSelector('[data-recent-file]');
  assert.equal(await page.locator('.commit-recent-preview').count(), 1, 'A recent commit should expand changed files in place.');
  assert.equal(await page.locator('[data-recent-file]').count(), await page.evaluate(() => fixture.commits[0].paths.length));
  const firstRecentRequest = await page.evaluate(() => window.__vscodeMessages.find((message) => message.type === 'recentCommitDetails'));
  await page.locator('[data-recent-file]').first().click();
  assert.ok(await page.evaluate(() => window.__vscodeMessages.some((message) => message.type === 'openRecentCommitDiff' && message.hash === fixture.commits[0].hash && message.root === fixture.root)), 'Clicking a recent file should open its committed diff in the correct repository.');
  await page.locator('[data-recent-history]').click();
  assert.ok(await page.evaluate(() => window.__vscodeMessages.some((message) => message.type === 'showRecentCommit')), 'The expanded preview should still link to full History.');
  await page.locator('[data-recent-commit]').first().click();
  assert.equal(await page.locator('.commit-recent-preview').count(), 0, 'Clicking the expanded commit should collapse its files.');
  await page.locator('[data-recent-commit]').first().click();
  assert.equal(await page.locator('[data-recent-file]').count(), await page.evaluate(() => fixture.commits[0].paths.length));
  assert.equal(await page.evaluate(() => window.__vscodeMessages.filter((message) => message.type === 'recentCommitDetails').length), 1, 'Reopening an immutable commit should reuse its cached files.');
  await page.locator('[data-recent-commit]').first().click();
  await page.evaluate(() => { window.__holdRecentDetails = true; });
  await page.locator('[data-recent-commit]').nth(1).click();
  const secondRecentRequest = await page.evaluate(() => window.__vscodeMessages.filter((message) => message.type === 'recentCommitDetails').at(-1));
  await page.evaluate(({ old, current }) => {
    emit({ type: 'recentCommitDetails', root: old.root, requestId: old.requestId, payload: { hash: old.hash, files: [{ path: 'stale.txt', status: 'M' }] } });
    emit({ type: 'recentCommitDetailsError', root: current.root, requestId: current.requestId, hash: current.hash, message: 'Temporary Git failure' });
  }, { old: firstRecentRequest, current: secondRecentRequest });
  assert.equal(await page.locator('[data-recent-file="stale.txt"]').count(), 0, 'A late response for another commit must not replace the preview.');
  assert.match(await page.locator('.commit-recent-preview').textContent(), /Temporary Git failure/);
  await page.evaluate(() => { window.__holdRecentDetails = false; });
  await page.locator('[data-recent-retry]').click();
  await page.waitForSelector('[data-recent-file]');
  assert.equal(await page.locator('[data-recent-commit]').nth(1).getAttribute('aria-expanded'), 'true');
  await page.locator('[data-recent-commit]').nth(1).click();
  const historyIconColor = await page.locator('.commit-toolbar [data-action="show-log"] svg').evaluate((element) => getComputedStyle(element).color);
  const branchIconColor = await page.locator('.commit-toolbar [data-action="branches"]').evaluate((element) => getComputedStyle(element).color);
  assert.equal(historyIconColor, branchIconColor, 'The History shortcut should use the same normal accent as Branches.');

  await page.locator('[data-commit-zone-splitter]').focus();
  await page.keyboard.press('ArrowUp');
  assert.equal(await page.locator('.changes-content.recent-resized').count(), 1, 'The split should still support manual resizing.');
  await page.keyboard.press('Home');
  assert.equal(await page.locator('.changes-content.recent-resized').count(), 0, 'Resetting the split should restore automatic sizing.');
  for (const viewport of [{ width: 240, height: 420 }, { width: 360, height: 1000 }]) {
    await page.setViewportSize(viewport);
    const layout = await page.evaluate(() => {
      const actions = document.querySelector('.commit-actions').getBoundingClientRect();
      const panel = document.querySelector('.commit-panel').getBoundingClientRect();
      const upper = document.querySelector('.commit-upper').getBoundingClientRect();
      return {
        actionsVisible: actions.top >= panel.top && actions.bottom <= upper.bottom,
        horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
        lowerHeight: document.querySelector('.commit-lower').getBoundingClientRect().height
      };
    });
    assert.equal(layout.actionsVisible, true, 'The Commit actions must remain visible in short or narrow sidebars.');
    assert.equal(layout.horizontalOverflow, false, 'The sidebar must not scroll horizontally.');
    assert.ok(layout.lowerHeight <= 288, 'Tall sidebars must not stretch the recent list into unused space.');
  }
  await page.setViewportSize({ width: 360, height: 820 });
  assert.equal(await page.locator('.commit-panel').evaluate((element) => getComputedStyle(element).flexBasis), '188px', 'The Commit form should reserve room for selection feedback.');
  assert.equal(await page.locator('.commit-toolbar [data-action="show-log"]').count(), 1, 'History should have a visible bottom-Panel shortcut.');
  await page.locator('.commit-toolbar [data-action="show-log"]').click();
  assert.ok(await page.evaluate(() => window.__vscodeMessages.some((message) => message.type === 'showLog')), 'The shortcut should focus History through VS Code.');
  await page.locator('.commit-toolbar [data-action="branches"]').click();
  assert.equal(await page.locator('.branch-popup').count(), 1, 'The branch shortcut should open the existing branch picker.');
  const popupFont = await page.locator('.branch-popup').evaluate((element) => getComputedStyle(element).fontFamily);
  const picker = await page.locator('.branch-popup').boundingBox();
  assert.ok(picker && picker.y >= 30 && picker.height <= 520, 'The branch picker should stay below the toolbar and leave the rest of the sidebar visible.');
  assert.equal(await page.locator('.branch-popup [data-checkout]').first().getAttribute('data-checkout'), 'feature/keaton/ACKk8s', 'The current branch should be first.');
  assert.equal(await page.locator('.branch-popup [data-checkout][data-remote="true"]').count(), 0, 'Remote branches should start collapsed.');
  await page.locator('[data-branch-popup-toggle="remote"]').click();
  assert.equal(await page.locator('.branch-popup [data-checkout][data-remote="true"]').count(), 3, 'The remote group should expand on demand.');
  await page.locator('[data-branch-popup-toggle="remote"]').click();
  await page.locator('#branch-search').fill('origin/master');
  assert.equal(await page.locator('.branch-popup [data-checkout][data-remote="true"]').count(), 1, 'Search should find remote branches even while their group is collapsed.');
  await page.keyboard.press('Escape');
  await page.locator('.commit-toolbar [data-action="toolbar-more"]').click();
  assert.equal(await page.locator('.commit-toolbar-menu.open').count(), 1, 'Secondary Commit actions should open as a readable menu.');
  await page.locator('[data-toolbar-action="fetch"]').click();
  assert.ok(await page.evaluate(() => window.__vscodeMessages.some((message) => message.type === 'fetch')), 'Fetch should reach the VS Code message bridge.');
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'syncStatus', phase: 'error', error: 'Remote unavailable' } })));
  assert.match(await page.locator('.commit-toolbar-more .has-error').getAttribute('aria-label'), /Remote check failed/, 'Remote failures should remain visible on the toolbar.');
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'syncStatus', phase: 'idle' } })));

  await openSurface(page, 'surface=changes&state=sync-clean');
  assert.equal(await page.locator('[data-action="pull-menu"]').isEnabled(), true, 'Pull should stay available with an upstream when cached incoming count is zero.');
  assert.equal(await page.locator('.commit-toolbar [data-action="push"]').isEnabled(), false, 'Push needs outgoing commits.');
  await page.locator('[data-action="pull-menu"]').click();
  await page.locator('[data-pull-strategy="ff-only"]').click();
  assert.ok(await page.evaluate(() => window.__vscodeMessages.some((message) => message.type === 'pull')), 'Pull should reach Git even when no incoming commits were cached.');
  await openSurface(page, 'surface=changes&state=no-upstream');
  assert.equal(await page.locator('[data-action="pull-menu"]').isEnabled(), false, 'Pull without a tracking branch should explain why it cannot run.');
  await page.locator('[data-action="toolbar-more"]').click();
  await page.locator('[data-toolbar-action="configure-upstream"]').click();
  assert.ok(await page.evaluate(() => window.__vscodeMessages.some((message) => message.type === 'configureUpstream')), 'An untracked branch should offer a direct setup action.');

  await openSurface(page, 'surface=changes&state=multi');
  const switchRepository = page.getByRole('button', { name: /Choose repository, current ack-k8s/ }).first();
  assert.equal(await switchRepository.count(), 1, 'Multiple workspace folders should expose a repository switcher.');
  await switchRepository.click();
  assert.ok(await page.evaluate(() => window.__vscodeMessages.some((message) => message.type === 'chooseRepository')), 'Repository switching should reach VS Code.');
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'snapshot', payload: { ...fixture, repositoryCount: 2,
      repositoryName: 'analytics-platform-with-a-long-repository-name',
      root: '/workspace/analytics-platform-with-a-long-repository-name' } }
  })));
  await page.evaluate((request) => emit({ type: 'recentCommitDetails', root: request.root, requestId: request.requestId, payload: { hash: request.hash, files: [{ path: 'wrong-repo.txt', status: 'M' }] } }), firstRecentRequest);
  assert.equal(await page.locator('.commit-recent-preview').count(), 0, 'Responses from a previous repository must not reopen a preview.');
  assert.equal(await page.locator('.commit-repository-name').textContent(), 'analytics-platform-with-a-long-repository-name', 'Switching repositories must update the visible name.');
  await page.setViewportSize({ width: 240, height: 420 });
  const repositoryLayout = await page.locator('.commit-repository-name').evaluate((element) => ({
    truncated: element.scrollWidth > element.clientWidth,
    horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth
  }));
  assert.equal(repositoryLayout.truncated, true, 'Long repository names should truncate within the sidebar.');
  assert.equal(repositoryLayout.horizontalOverflow, false, 'Long repository names must not push controls outside the sidebar.');
  assert.match(await page.locator('.commit-repository-picker').getAttribute('title'), /analytics-platform-with-a-long-repository-name/);
  await page.setViewportSize({ width: 360, height: 820 });

  await openSurface(page, 'surface=changes&state=grouped');
  assert.deepEqual(await page.locator('.file-group-heading').allTextContents(), ['Tracked4', 'Untracked2'], 'Tracked files should appear above the Untracked group.');
  assert.deepEqual(await page.locator('[data-file-row]').evaluateAll((rows) => rows.map((row) => row.dataset.path)), [
    'src/main/java/com/anker/mvp/provider/EksClusterProvider.java',
    'src/deleted-file.txt',
    'src/main/java/com/anker/mvp/config/AwsWebClientInitializer.java',
    'README.md',
    'src/new-file.txt',
    'src/another-new-file.txt'
  ]);
  const statusColors = await page.locator('[data-file-row]').evaluateAll((rows) => Object.fromEntries(rows.map((row) => [
    [...row.classList].find((kind) => ['modified', 'added', 'deleted', 'untracked'].includes(kind)),
    getComputedStyle(row.querySelector('.file-name')).color
  ])));
  assert.equal(new Set([statusColors.modified, statusColors.added, statusColors.deleted]).size, 3, 'Modified, added, and deleted files should use distinct theme colors.');
  assert.equal(await page.locator('.file-state').count(), 0, 'File rows should not repeat state labels beside colored file names.');
  assert.match(await page.locator('.file-row.deleted .file-main').getAttribute('title'), /deleted/);
  assert.match(await page.locator('.file-row.untracked .file-main').first().getAttribute('title'), /Git is not tracking/);
  await page.locator('.file-row.untracked [data-select]').first().check({ force: true });
  await page.locator('.file-row.untracked [data-select]').last().check({ force: true });
  await page.locator('[data-action="rollback-selected"]').click();
  const rollback = await page.evaluate(() => window.__vscodeMessages.find((message) => message.type === 'rollbackFiles'));
  assert.deepEqual(rollback?.paths, ['src/new-file.txt', 'src/another-new-file.txt'], 'Rollback should send only the two selected new files for confirmation.');
  await page.locator('.file-row.untracked [data-file-menu]').first().click({ force: true });
  assert.match(await page.locator('[data-file-context-action="rollback"]').textContent(), /Rollback 2 selected files/);

  await openSurface(page, 'surface=changes');
  assert.match(await page.locator('.file-row .file-main').first().getAttribute('aria-label'), /Staged|Modified|New file|Conflict/, 'Git state should remain accessible without a visible status label.');
  await page.locator('[data-action="toolbar-more"]').click();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.commit-toolbar-menu.open').count(), 0, 'Escape should dismiss the Commit action menu.');

  const firstFile = page.locator('[data-select]').first();
  await firstFile.check({ force: true });
  await page.locator('#commit-message').fill('test: verify browser commit flow');
  const commitButton = page.locator('[data-action="commit"]');
  assert.equal(await commitButton.isEnabled(), true, 'Selecting a file and entering a message should enable Commit.');
  await commitButton.click();
  assert.equal(await page.getByRole('dialog', { name: /Review 1 selected file/ }).count(), 1, 'Commit should review the exact selection first.');
  assert.equal(await page.locator('.commit-review-file').count(), 1);
  assert.equal(await page.evaluate(() => window.__vscodeMessages.some((message) => message.type === 'commit')), false, 'Opening review must not commit yet.');
  await page.locator('[data-review-diff]').click();
  assert.ok(await page.evaluate(() => window.__vscodeMessages.some((message) => message.type === 'openDiff' && message.path.endsWith('EksClusterProvider.java') && message.preview === false)), 'Reviewing a file should open its full diff.');
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog').count(), 0, 'Escape should return to the Commit form without submitting.');
  await commitButton.click();
  await page.locator('[data-action="confirm-commit-review"]').click();
  const commitMessage = await page.evaluate(() => window.__vscodeMessages.find((message) => message.type === 'commit'));
  assert.equal(commitMessage?.message, 'test: verify browser commit flow');
  assert.equal(commitMessage?.paths?.length, 1, 'Commit should include only the selected file.');

  await openSurface(page, 'surface=changes');
  await page.locator('[data-select]').nth(1).check({ force: true });
  await page.locator('#commit-message').fill('test: filtered selection');
  await page.locator('[data-action="search-changes"]').click();
  await page.locator('#change-filter').selectOption('staged');
  assert.match(await page.locator('.commit-selection-status').textContent(), /1 hidden/);
  assert.equal(await page.locator('[data-action="commit"]').isEnabled(), false);
  await page.locator('[data-action="clear-hidden-selection"]').click();
  await page.locator('[data-select-list]').check({ force: true });
  assert.equal(await page.locator('[data-select]:checked').count(), 2);
  assert.match(await page.locator('.commit-selection-note').textContent(), /all working-tree changes/);
  await page.locator('[data-action="commit"]').click();
  assert.equal(await page.locator('.commit-review-file').count(), 2, 'Review should show the post-filter selection.');
  await page.locator('[data-action="confirm-commit-review"]').click();
  const filteredCommit = await page.evaluate(() => window.__vscodeMessages.find((message) => message.type === 'commit'));
  assert.equal(filteredCommit.paths.length, 2);
  assert.ok(!filteredCommit.paths.some((file) => file.endsWith('AwsWebClientInitializer.java')));

  await page.setViewportSize({ width: 1450, height: 650 });
  await openSurface(page, 'surface=history');
  await page.locator('[data-action="toggle-history-focus"]').click();
  assert.equal(await page.locator('.log-workspace.history-focus').count(), 1, 'History focus mode should enlarge the commit graph.');
  assert.equal(await page.locator('.log-branch-pane:visible').count(), 0);
  await page.locator('[data-action="toggle-history-focus"]').click();
  assert.equal(await page.locator('.log-workspace.history-focus').count(), 0, 'History side panels should be recoverable.');
  const loadedCommitCount = await page.locator('.graph-row').count();
  const firstSubject = page.locator('.graph-row strong').first();
  assert.equal(await firstSubject.getAttribute('title'), await firstSubject.textContent(), 'Truncated commit subjects should expose their full text on hover.');
  await page.locator('#graph-search').fill('2d4411f');
  await page.locator('.graph-row').first().waitFor();
  assert.equal(await page.locator('.graph-row').count(), 1, 'Commit search should match by short hash.');
  await page.locator('[data-action="clear-graph-filters"]').first().click();
  assert.equal(await page.locator('.graph-row').count(), loadedCommitCount, 'Clearing filters should restore all loaded commits.');
  await page.locator('#graph-path').fill('config');
  await page.locator('.graph-row').first().waitFor();
  assert.equal(await page.locator('.graph-row').count(), 1, 'Path filtering should return commits that touched the path.');
  await page.locator('[data-action="clear-graph-filters"]').first().click();
  await page.locator('#graph-author').fill('jarvan.jiang');
  await page.locator('.graph-row').first().waitFor();
  assert.ok(await page.locator('.graph-row').count() > 0 && await page.locator('.graph-row').count() < loadedCommitCount, 'Author filtering should narrow the commit list.');
  await page.locator('[data-action="clear-graph-filters"]').first().click();
  await page.locator('[data-graph-filter="branch"]').selectOption('origin/master');
  assert.ok(await page.evaluate(() => window.__vscodeMessages.some((message) => message.type === 'setHistoryRef' && message.branch === 'origin/master')), 'Ref filtering should request the selected history from VS Code.');

  await openSurface(page, 'surface=history');
  await page.locator('[data-action="toggle-history-focus"]').click();
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'revealCommit', hash: '2d4411f0a1b2c3d4e5f678901234567890abcd12' }
  })));
  assert.equal(await page.locator('.log-workspace.history-focus').count(), 0, 'Blame navigation should reveal the commit detail pane.');
  await page.locator('.graph-row.selected').waitFor();
  assert.equal(await page.locator('.graph-row').count(), 1, 'Blame navigation should narrow History to the exact commit.');
  assert.equal(await page.locator('.graph-row.selected').count(), 1, 'Blame navigation should select the matching commit.');
  assert.ok(await page.evaluate(() => window.__vscodeMessages.some((message) => message.type === 'commitDetails' && message.hash === '2d4411f0a1b2c3d4e5f678901234567890abcd12')), 'Blame navigation should load commit details.');

  await openSurface(page, 'surface=history&state=multi');
  await page.locator('.log-action-rail [data-action="choose-repository"]').click();
  assert.ok(await page.evaluate(() => window.__vscodeMessages.some((message) => message.type === 'chooseRepository')), 'History should also allow repository switching.');

  await openSurface(page, 'surface=history');
  assert.equal(await page.locator('.log-workspace').evaluate((element) => getComputedStyle(element).fontFamily), popupFont, 'Branch picker and History should use the same font family.');
  assert.equal(await page.locator('.log-branch-row.current .branch-sync-indicator').count(), 1, 'Incoming and outgoing icons should sit beside the current branch.');
  assert.match(await page.locator('.log-date').first().textContent(), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, 'History dates should include local date and time to the second.');
  assert.equal(await page.locator('.log-head-group, .branch-pane-footer').count(), 0, 'History should not duplicate the current branch or reserve a status footer.');
  assert.match(await page.locator('.log-branch-row.current .branch-sync-indicator').getAttribute('title'), /2 incoming, 6 outgoing/);
  assert.equal(await page.locator('.log-branch-row.current .branch-sync-incoming, .log-branch-row.current .branch-sync-outgoing').count(), 2, 'A diverged branch should show both directions.');
  assert.equal(await page.locator('.log-branch-row[data-log-branch="feature/keaton/20260924-solar"] .branch-sync-incoming').count(), 1, 'Other local branches should also show their remote difference.');
  const otherBranch = 'feature/keaton/20260924-solar';
  await page.locator(`.log-branch-row[data-log-branch="${otherBranch}"]`).click();
  await page.locator(`[data-update-branch="${otherBranch}"]`).click();
  assert.ok(await page.evaluate((branch) => window.__vscodeMessages.some((message) => message.type === 'updateBranch' && message.branch === branch), otherBranch), 'Update should target the selected local branch without changing checkout.');
  assert.equal(await page.locator('.log-branch-row.current').getAttribute('data-log-branch'), 'feature/keaton/ACKk8s', 'Updating another branch must not switch the checked-out branch.');
  await page.locator(`.log-branch-row[data-log-branch="${otherBranch}"]`).click({ button: 'right' });
  assert.equal(await page.locator('[data-branch-context-action="update"]').count(), 1, 'Tracked branches expose Update in the context menu.');
  assert.equal(await page.locator('[data-branch-context-action="push"]').count(), 1, 'Tracked branches expose Push in the context menu.');
  await page.locator('[data-branch-context-action="push"]').click();
  assert.ok(await page.evaluate((branch) => window.__vscodeMessages.some((message) => message.type === 'pushBranch' && message.branch === branch), otherBranch), 'Push should target the selected local branch.');
  await openSurface(page, 'surface=history');
  const remoteBranchCount = await page.locator('.log-branch-row[data-branch-remote="true"]').count();
  const originFolder = page.locator('[data-log-folder-toggle="origin"]');
  assert.equal(await originFolder.getAttribute('aria-expanded'), 'true', 'Remote folder nodes should start expanded.');
  await originFolder.click();
  assert.equal(await page.locator('[data-log-folder-toggle="origin"]').getAttribute('aria-expanded'), 'false', 'Clicking a remote folder should collapse it.');
  assert.equal(await page.locator('.log-branch-row[data-branch-remote="true"]').count(), 0, 'Collapsing origin should hide all of its remote branches.');
  await page.locator('[data-log-folder-toggle="origin"]').click();
  assert.equal(await page.locator('.log-branch-row[data-branch-remote="true"]').count(), remoteBranchCount, 'Expanding origin should restore its remote branches.');
  await page.locator('.log-branch-row[data-branch-remote="true"]').first().click({ button: 'right' });
  assert.equal(await page.locator('[data-branch-context]').count(), 1, 'Right-click should open branch actions.');
  await page.locator('.log-branch-search').click();
  assert.equal(await page.locator('[data-branch-context]').count(), 0, 'Clicking outside should dismiss branch actions.');
  await page.locator('.log-branch-row[data-branch-remote="true"]').first().click({ button: 'right' });
  await page.locator('[data-branch-context-action="copy"]').press('Escape');
  assert.equal(await page.locator('[data-branch-context]').count(), 0, 'Escape should dismiss branch actions.');
  await page.locator('.log-branch-row[data-branch-remote="true"]').first().click({ button: 'right' });
  await page.locator('[data-branch-context-action="copy"]').click();
  assert.equal(await page.locator('[data-branch-context]').count(), 0, 'Choosing a branch action should close its menu.');
  assert.ok(await page.evaluate(() => window.__vscodeMessages.some((message) => message.type === 'copyBranchName')), 'The branch action should reach VS Code.');
  await page.locator('.graph-row').nth(1).click();
  await page.locator('.commit-detail-head strong').waitFor();
  assert.equal(await page.locator('.commit-detail-head strong').textContent(), 'fix: #0000 补充迁移模板中的 ssl_cert_file 配置', 'Selecting a commit should show matching detail data.');
  await page.locator('.commit-file').first().waitFor();
  assert.equal(await page.locator('.commit-file-folder').count(), 1, 'Single-child directory chains should collapse into one folder row.');
  assert.match(await page.locator('.commit-file-folder').getAttribute('title'), /src\/main\/java\/com\/anker\/mvp\/config/);
  assert.ok(await page.locator('.commit-file .file-type-icon').count() > 0, 'Changed files should reserve a file icon slot.');
  assert.match(await page.locator('.commit-file').first().getAttribute('data-commit-file'), /AwsWebClientInitializer\.java$/, 'The selected commit should show its own changed files.');
  await page.locator('.commit-file').first().click();
  assert.ok(await page.evaluate(() => window.__vscodeMessages.some((message) => message.type === 'openCommitDiff' && message.hash === '2d4411f0a1b2c3d4e5f678901234567890abcd12')), 'Opening a changed file should request its diff in VS Code.');
  assert.equal(await page.locator('[data-action="load-more-commits"]').count(), 0, 'History should not require a Load more button.');
  await page.addStyleTag({ content: '.graph-list[data-graph-list] { max-height: 120px !important; }' });
  await page.locator('[data-graph-list]').evaluate((list) => {
    list.scrollTop = Math.max(0, list.scrollHeight - list.clientHeight - 40);
    list.dispatchEvent(new Event('scroll'));
  });
  assert.equal(await page.evaluate(() => window.__vscodeMessages.filter((message) => message.type === 'loadMoreCommits').length), 0, 'Approaching the bottom should not load more history early.');
  await page.locator('[data-graph-list]').evaluate((list) => { list.scrollTop = list.scrollHeight; list.dispatchEvent(new Event('scroll')); });
  assert.ok(await page.evaluate(() => window.__vscodeMessages.some((message) => message.type === 'loadMoreCommits')), 'Scrolling to older history should load the next page.');

  assert.deepEqual(pageErrors, [], 'The webview should not throw browser runtime errors.');
  console.log('Webview E2E passed: reviewed commit, toolbar menu, file states, History focus and Blame reveal, search and filters, branch menus, commit details/diffs, and pagination.');
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
