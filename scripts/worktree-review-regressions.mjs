import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

export async function verifyWorktreeReview(page, openSurface) {
  const status = (revision, pending) => ({ type: 'worktreeReviewStatus', count: 2, revision, pending, stale: false });
  const send = payload => page.evaluate(payload => emit({ root: fixture.root, ...payload }), payload);
  const last = async type => {
    await page.waitForFunction(type => window.__vscodeMessages.some(message => message.type === type), type);
    return page.evaluate(type => window.__vscodeMessages.findLast(message => message.type === type), type);
  };
  const originalViewport = page.viewportSize();
  await page.setViewportSize({ width: 360, height: 770 });
  await openSurface('surface=changes');
  await send(status(1, 1));
  await page.locator('#worktree-review-trigger').click();
  assert.equal((await last('worktreeReviewOpen')).type, 'worktreeReviewOpen');
  await page.setViewportSize({ width: 960, height: 540 });
  await openSurface('surface=history');
  await send(status(1, 1));
  const trigger = page.locator('#worktree-review-trigger');
  assert.match(await trigger.textContent(), /2 · 1/);
  assert.equal(await page.locator('#worktree-review-dialog').count(), 0, 'Discovery must not open a dialog or take focus.');
  await trigger.click();
  await send({ type: 'worktreeReviewShown' });
  const dialog = page.locator('#worktree-review-dialog');
  await dialog.waitFor();
  assert.equal(await page.locator('.history-content').getAttribute('inert'), '');
  const hash = '3ecf5120cf0ca1d0f451a45170aefd18fe39a575';
  const parent = '2ecf5120cf0ca1d0f451a45170aefd18fe39a575';
  const selection = { id: 'external', version: 3 };
  const file = 'src/request handling.ts';
  const entry = { ...selection, path: '/workspace/remote task worktree', head: hash, branch: 'task/request-timeout', pending: true, kind: 'discovered' };
  const list = await last('worktreeReviewList');
  await send({ type: 'worktreeReviewListResult', requestId: list.requestId, entries: [
    { id: 'current', version: 1, path: '/workspace/primary', branch: 'main', isCurrent: true, pending: false, kind: 'unchanged' }, entry
  ] });
  await dialog.locator('[data-worktree-review-entry="external"]').click();
  const request = await last('worktreeReviewDetails');
  assert.equal(request.version, selection.version);
  const subject = 'Handle request timeouts without dropping queued work and keep the original error visible to the operator even when the request is retried';
  const target = { ref: 'refs/heads/main', label: 'main', oid: '4ecf5120cf0ca1d0f451a45170aefd18fe39a575' };
  await send({ type: 'worktreeReviewDetailsResult', ...selection, requestId: request.requestId, payload: {
    mode: 'recent', commits: [{ hash, shortHash: hash.slice(0, 7), subject, author: 'Dev User', date: '2026-11-23T10:22:00Z' }],
    hasMore: true, targets: [target], changes: [{ path: 'notes/local test.md', kind: 'untracked' }]
  } });
  const commitRow = dialog.locator(`[data-worktree-review-commit="${hash}"]`);
  await commitRow.locator('[data-commit-subject]').hover();
  const preview = page.locator('.commit-subject-preview');
  await preview.waitFor({ state: 'visible' });
  assert.equal(await preview.textContent(), subject);
  await commitRow.click();
  assert.equal(await dialog.locator('.worktree-review-commit-full-subject').textContent(), subject);
  assert.equal(await dialog.locator('.commit-author-avatar').textContent(), 'DU');
  const details = await last('worktreeReviewCommit');
  await send({ type: 'worktreeReviewCommitResult', ...selection, hash, requestId: details.requestId, payload: { hash, parents: [parent], files: [{ path: file, status: 'M' }] } });
  await dialog.locator('[data-worktree-review-file]').click();
  const diff = await last('worktreeReviewDiff');
  assert.equal(diff.hash, hash);
  assert.equal(diff.path, file);
  await send({ type: 'worktreeReviewDiffResult', ...selection, hash, path: file });
  const markButton = dialog.locator('[data-action="mark-worktree-review"]');
  assert.equal(await markButton.getAttribute('aria-disabled'), 'true', 'Do not mark after only the first page.');
  const more = dialog.locator('#worktree-review-load-more');
  await more.click();
  const firstPage = await last('worktreeReviewPage');
  assert.equal(firstPage.version, selection.version);
  await send({ type: 'worktreeReviewPageResult', ...selection, requestId: firstPage.requestId, error: 'Git read timed out' });
  await dialog.getByText('Git read timed out').waitFor();
  await more.click();
  const retry = await page.evaluate(() => window.__vscodeMessages.filter(message => message.type === 'worktreeReviewPage').at(-1));
  assert.notEqual(firstPage.requestId, retry.requestId);
  await send({ type: 'worktreeReviewPageResult', ...selection, requestId: retry.requestId, payload: {
    commits: [{ hash: parent, shortHash: parent.slice(0, 7), subject: 'Add request queue', author: 'Dev User', date: '2026-11-22T10:00:00Z' }], hasMore: false
  } });
  assert.equal(await dialog.locator('[data-worktree-review-commit]').count(), 2);
  assert.equal(await commitRow.getAttribute('aria-expanded'), 'true');
  assert.equal(await markButton.getAttribute('aria-disabled'), 'false');
  await dialog.locator('[data-worktree-review-section="delivery"]').click();
  const targetSelect = dialog.locator('#worktree-review-delivery-target');
  assert.equal(await targetSelect.inputValue(), '', 'Do not guess the target branch.');
  await targetSelect.selectOption(target.ref);
  const compare = await last('worktreeReviewDelivery');
  assert.equal(compare.ref, target.ref);
  const renamed = 'src/request-queue.ts';
  await send({ type: 'worktreeReviewDeliveryResult', ...selection, requestId: compare.requestId, payload: {
    deliveryId: compare.requestId, target, head: hash, base: parent, files: [{ path: renamed, originalPath: file, status: 'R', oldRevision: parent, newRevision: hash }]
  } });
  await dialog.locator('[data-worktree-review-delivery-file]').click();
  const deliveryDiff = await last('worktreeReviewDeliveryDiff');
  assert.equal(deliveryDiff.path, renamed);
  assert.equal(deliveryDiff.deliveryId, compare.requestId);
  if (process.env.KIVO_WORKTREE_CAPTURE) {
    const out = path.resolve(process.env.KIVO_WORKTREE_CAPTURE);
    await mkdir(path.dirname(out), { recursive: true });
    await page.screenshot({ path: out, animations: 'disabled' });
  }
  await dialog.locator('[data-worktree-review-section="changes"]').click();
  assert.match(await dialog.textContent(), /notes\/local test\.md/);
  assert.equal(await dialog.locator('[data-worktree-review-commit]').count(), 0);
  // Same count but a later observation must not replace the pinned object.
  await send(status(2, 1));
  assert.match(await dialog.textContent(), /Refresh to see/);
  await dialog.locator('[data-action="mark-worktree-review"]').click();
  const mark = await last('worktreeReviewMark');
  assert.equal(mark.version, selection.version);
  await send({ type: 'worktreeReviewMarkResult', ...selection, requestId: mark.requestId, error: 'Worktree changed. Refresh and review again.' });
  await dialog.getByText('Worktree changed. Refresh and review again.').waitFor();
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await trigger.evaluate(node => node === document.activeElement), true);
  const mutations = await page.evaluate(() => window.__vscodeMessages.filter(message => ['checkout', 'commit', 'push', 'openWorktree'].includes(message.type)));
  assert.deepEqual(mutations, []);
  await page.setViewportSize(originalViewport);
  console.log('Worktree Review passed: shared entry, discovery without interruption, exact pinned diff, separate uncommitted files, stale mark, and restored focus.');
}
