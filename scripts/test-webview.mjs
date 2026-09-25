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
  assert.equal(await page.locator('.workspace-brief').count(), 0, 'The Commit view should leave repository status to History.');
  await page.locator('.commit-toolbar [data-action="fetch"]').click();
  assert.ok(await page.evaluate(() => window.__vscodeMessages.some((message) => message.type === 'fetch')), 'Fetch should reach the VS Code message bridge.');

  const firstFile = page.locator('[data-select]').first();
  await firstFile.check({ force: true });
  await page.locator('#commit-message').fill('test: verify browser commit flow');
  const commitButton = page.locator('[data-action="commit"]');
  assert.equal(await commitButton.isEnabled(), true, 'Selecting a file and entering a message should enable Commit.');
  await commitButton.click();
  const commitMessage = await page.evaluate(() => window.__vscodeMessages.find((message) => message.type === 'commit'));
  assert.equal(commitMessage?.message, 'test: verify browser commit flow');
  assert.equal(commitMessage?.paths?.length, 1, 'Commit should include only the selected file.');

  await page.setViewportSize({ width: 1450, height: 650 });
  await openSurface(page, 'surface=history');
  const loadedCommitCount = await page.locator('.graph-row').count();
  const firstSubject = page.locator('.graph-row strong').first();
  assert.equal(await firstSubject.getAttribute('title'), await firstSubject.textContent(), 'Truncated commit subjects should expose their full text on hover.');
  await page.locator('#graph-search').fill('2d4411f');
  assert.equal(await page.locator('.graph-row').count(), 1, 'Commit search should match by short hash.');
  await page.locator('[data-action="clear-graph-filters"]').first().click();
  assert.equal(await page.locator('.graph-row').count(), loadedCommitCount, 'Clearing filters should restore all loaded commits.');
  await page.locator('#graph-path').fill('config');
  assert.equal(await page.locator('.graph-row').count(), 1, 'Path filtering should return commits that touched the path.');
  await page.locator('[data-action="clear-graph-filters"]').first().click();
  await page.locator('[data-graph-filter="author"]').selectOption('jarvan.jiang');
  assert.ok(await page.locator('.graph-row').count() > 0 && await page.locator('.graph-row').count() < loadedCommitCount, 'Author filtering should narrow the commit list.');
  await page.locator('[data-action="clear-graph-filters"]').first().click();
  await page.locator('[data-graph-filter="branch"]').selectOption('origin/master');
  assert.ok(await page.evaluate(() => window.__vscodeMessages.some((message) => message.type === 'setHistoryRef' && message.branch === 'origin/master')), 'Ref filtering should request the selected history from VS Code.');

  await openSurface(page, 'surface=history');
  assert.equal(await page.locator('.log-branch-row.current .branch-current-sync').count(), 1, 'Sync status should sit beside the current branch.');
  assert.equal(await page.locator('.log-head-group, .branch-pane-footer').count(), 0, 'History should not duplicate the current branch or reserve a status footer.');
  assert.match(await page.locator('.log-branch-row.current .branch-current-sync').getAttribute('title'), /2 incoming, 6 outgoing/);
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
  assert.ok(await page.locator('.commit-file .file-type-icon').count() > 0, 'Changed files should reserve a file icon slot.');
  assert.match(await page.locator('.commit-file').first().getAttribute('data-commit-file'), /AwsWebClientInitializer\.java$/, 'The selected commit should show its own changed files.');
  await page.locator('.commit-file').first().click();
  assert.ok(await page.evaluate(() => window.__vscodeMessages.some((message) => message.type === 'openCommitDiff' && message.hash === '2d4411f0a1b2c3d4e5f678901234567890abcd12')), 'Opening a changed file should request its diff in VS Code.');
  await page.locator('[data-action="load-more-commits"]').click();
  assert.ok(await page.evaluate(() => window.__vscodeMessages.some((message) => message.type === 'loadMoreCommits')), 'Load more history should reach VS Code.');

  assert.deepEqual(pageErrors, [], 'The webview should not throw browser runtime errors.');
  console.log('Webview E2E passed: commit, fetch, History search and filters, ref loading, branch-folder collapse, menu dismissal, commit details/diffs, and pagination.');
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
