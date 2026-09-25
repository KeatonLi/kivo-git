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
  await page.waitForSelector('.commit-toolbar');
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
  const syncCounts = await page.locator('.workspace-brief-metrics strong').allTextContents();
  assert.deepEqual(syncCounts, ['2', '6'], 'The sidebar should show incoming and outgoing commit counts.');
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

  assert.deepEqual(pageErrors, [], 'The webview should not throw browser runtime errors.');
  console.log('Webview E2E passed: empty drop target, sync counts, fetch bridge, and selected-file commit.');
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
