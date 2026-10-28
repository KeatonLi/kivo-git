import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

export async function verifyCheckoutRecovery(page, openSurface) {
  const viewport = page.viewportSize();
  const capture = async name => {
    if (!process.env.KIVO_CAPTURE_DIR) return;
    await mkdir(process.env.KIVO_CAPTURE_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.KIVO_CAPTURE_DIR, `${name}.png`), animations: 'disabled' });
  };
  await page.setViewportSize({ width: 1440, height: 600 });
  await openSurface('surface=history');
  await page.evaluate(() => { fixture.worktrees = [{ path: fixture.root, branch: fixture.branch }]; emit({ type: 'snapshot', payload: structuredClone(fixture) }); });
  const worktrees = page.getByRole('button', { name: 'Manage Worktrees' });
  await worktrees.focus();
  await page.keyboard.press('Enter');
  assert.ok(await page.evaluate(() => window.__vscodeMessages.some(message => message.type === 'chooseWorktree' && message.root === fixture.root)),
    'Worktrees must remain discoverable and keyboard accessible with a single registered worktree.');
  await page.setViewportSize({ width: 1440, height: 260 });
  const lastRailAction = page.locator('.log-action-rail [data-action="toggle-history-focus"]');
  await lastRailAction.focus();
  assert.equal(await lastRailAction.evaluate(element => {
    const container = element.closest('.log-action-rail');
    const button = element.getBoundingClientRect(), bounds = container.getBoundingClientRect();
    return button.top >= bounds.top && button.bottom <= bounds.bottom;
  }), true, 'Keyboard focus must reveal the last History action in a short panel.');
  await page.setViewportSize({ width: 1440, height: 600 });
  await page.evaluate(() => {
    window.__checkoutFailure = { id: 40, root: fixture.root, kind: 'checkout', title: 'feature/login is already open in another worktree.',
      worktreePath: '/projects/登录 worktree', details: 'Open the registered worktree.\n<img src=x onerror="window.__unsafe=true">', actions: ['openWorktree', 'details', 'copy', 'refresh'] };
    emit({ type: 'operationFailure', root: fixture.root, id: 40, failure: window.__checkoutFailure });
  });
  const card = page.getByRole('region', { name: 'Last Git operation issue' });
  await card.waitFor();
  assert.match(await card.textContent(), /already open in another worktree/);
  await page.evaluate(() => {
    emit({ type: 'notice', phase: 'success', message: 'Unrelated refresh finished' });
    emit({ type: 'snapshot', payload: { ...fixture, commitsHasMore: !fixture.commitsHasMore } });
  });
  assert.equal(await card.count(), 1, 'A normal refresh or a toast must not erase a checkout failure.');
  await card.getByRole('button', { name: 'Open worktree', exact: true }).click();
  await card.getByRole('button', { name: 'Copy details', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.__vscodeMessages.filter(message => message.type === 'operationRecovery').map(({ action, root, id }) => ({ action, root, id }))),
    await page.evaluate(() => ['openWorktree', 'copy'].map(action => ({ action, root: fixture.root, id: 40 }))));
  await card.locator('summary').click();
  assert.equal(await card.locator('img').count(), 0, 'Git details must remain text.');
  assert.equal(await page.evaluate(() => window.__unsafe), undefined);
  await card.locator('summary').click();
  await page.evaluate(() => {
    window.__checkoutFailure.details = "fatal: 'feature/login' is already used by worktree at '/projects/登录 worktree'";
    const branch = { name: 'feature/login', current: false, remote: false, worktreePath: '/projects/登录 worktree' };
    fixture.branches.push(branch);
    fixture.worktrees = [{ path: fixture.root, branch: fixture.branch }, { path: branch.worktreePath, branch: branch.name }];
    emit({ type: 'snapshot', payload: { ...fixture, failure: window.__checkoutFailure } });
  });
  await page.locator('#toast-region .toast-close').click();
  await capture('checkout-worktree-error');

  await page.evaluate(() => emit({ type: 'operationFailure', root: '/foreign', id: 999, failure: { title: 'Wrong repository' } }));
  assert.equal(await card.getByText('Wrong repository').count(), 0);
  await card.getByRole('button', { name: 'Dismiss operation issue' }).click();
  await page.evaluate(() => {
    emit({ type: 'operationFailure', root: fixture.root, id: 40, failure: null });
    emit({ type: 'snapshot', payload: { ...fixture, failure: window.__checkoutFailure } });
    emit({ type: 'operationFailure', root: fixture.root, id: 40, failure: window.__checkoutFailure });
  });
  assert.equal(await card.count(), 0, 'Old snapshots and duplicated replies must not resurrect a dismissed error.');

  await page.evaluate(() => {
    const other = { ...fixture, root: '/projects/other', failure: undefined };
    emit({ type: 'snapshot', payload: other });
    emit({ type: 'operationFailure', root: fixture.root, id: 41, failure: { ...window.__checkoutFailure, id: 41 } });
    emit({ type: 'operation', root: fixture.root, id: 999, phase: 'loading', kind: 'checkout', message: 'Stale operation' });
  });
  assert.equal(await card.count(), 0, 'A previous repository cannot publish a failure into the new one.');
  assert.equal(await page.locator('.content').getAttribute('aria-busy'), 'false', 'Stale operations cannot disable a different repository.');
  await page.evaluate(() => emit({ type: 'snapshot', payload: { ...fixture, failure: { ...window.__checkoutFailure, id: 42 } } }));
  await card.waitFor();

  await page.setViewportSize({ width: 240, height: 420 });
  await capture('checkout-worktree-narrow');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Recovery controls must not widen a narrow panel.');
  await card.getByRole('button', { name: 'View log', exact: true }).focus();
  await page.keyboard.press('Enter');
  assert.ok(await page.evaluate(() => window.__vscodeMessages.some(message => message.type === 'operationRecovery' && message.action === 'details')));

  await openSurface('surface=changes');
  await page.evaluate(() => {
    const branch = fixture.branches.find(branch => !branch.current && !branch.remote);
    branch.worktreePath = '/projects/other worktree';
    fixture.worktrees = [{ path: fixture.root, branch: fixture.branch }, { path: branch.worktreePath, branch: branch.name }];
    window.__occupiedBranch = branch.name;
    emit({ type: 'snapshot', payload: fixture });
  });
  await page.locator('[data-action="branches"]').click();
  const occupied = page.locator('[data-checkout]').filter({ has: page.locator('.worktree-badge') });
  assert.equal(await occupied.count(), 1); await occupied.click();
  assert.ok(await page.evaluate(() => window.__vscodeMessages.some(message => message.type === 'openWorktree' && message.branch === window.__occupiedBranch && message.root === fixture.root)));
  assert.equal(await page.evaluate(() => window.__vscodeMessages.filter(message => message.type === 'checkout').length), 0, 'Opening an occupied branch must not attempt checkout.');

  await page.evaluate(() => {
    for (const type of ['checkout', 'createBranch', 'checkoutRevision']) post(type, { branch: 'test', startPoint: 'HEAD', hash: 'abc1234' });
  });
  assert.ok(await page.evaluate(() => window.__vscodeMessages.filter(message => ['checkout', 'createBranch', 'checkoutRevision'].includes(message.type)).every(message => message.root === fixture.root)), 'Every checkout command must identify its source worktree.');
  await page.setViewportSize({ width: 360, height: 820 });
  await page.evaluate(() => {
    fixture.branch = 'feature/login'; fixture.branches.forEach(branch => { branch.current = branch.name === fixture.branch && !branch.remote; });
    if (!fixture.branches.some(branch => branch.current)) fixture.branches.push({ name: fixture.branch, current: true, remote: false });
    emit({ type: 'snapshot', payload: fixture });
    emit({ type: 'operationFailure', root: fixture.root, id: 44, failure: {
    id: 44, root: fixture.root, kind: 'checkout', title: 'Now on feature/login, but Git reported a checkout error.', actualBranch: 'feature/login',
    stashHash: 'a'.repeat(40), details: 'post-checkout hook failed', actions: ['stashes', 'details', 'copy', 'refresh']
  } }); });
  await card.waitFor(); await capture('checkout-partial-success');
  await card.getByRole('button', { name: 'View saved changes', exact: true }).click();
  assert.ok(await page.evaluate(() => window.__vscodeMessages.some(message => message.type === 'operationRecovery' && message.action === 'stashes')));
  await page.evaluate(() => emit({ type: 'openSavedStash', root: fixture.root, hash: 'a'.repeat(40) }));
  await page.locator('.workflow-dialog').waitFor();
  assert.ok(await page.evaluate(() => window.__vscodeMessages.some(message => message.type === 'workflowRequest' && message.kind === 'stashDetails' && message.hash === 'a'.repeat(40))));
  await page.setViewportSize(viewport);
  console.log('Checkout recovery: persistence, action routing, stale replies, worktree opening, keyboard/narrow panel, exact stash recovery passed.');
}
