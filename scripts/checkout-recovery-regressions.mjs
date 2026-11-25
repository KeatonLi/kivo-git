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
  const toolbar = page.getByRole('group', { name: 'History actions' });
  const focusHistory = toolbar.getByRole('button', { name: 'Focus on commit history' });
  await focusHistory.focus();
  assert.equal(await focusHistory.evaluate(element => {
    const toolbar = element.closest('.log-action-toolbar');
    const button = element.getBoundingClientRect(), bounds = toolbar.getBoundingClientRect();
    const workspace = toolbar.closest('.log-workspace').getBoundingClientRect();
    return button.top >= bounds.top && button.bottom <= bounds.bottom
      && bounds.top === workspace.top && bounds.width === workspace.width;
  }), true, 'History Focus must remain keyboard accessible in the full-width top toolbar of a short panel.');
  assert.equal(await toolbar.getByRole('button', { name: 'Refresh History' }).isVisible(), true);
  assert.equal(await toolbar.getByRole('button', { name: 'Locate current commit' }).isVisible(), true);
  const more = toolbar.getByRole('button', { name: 'More History actions' });
  const menu = toolbar.locator('#kivo-history-actions-menu');
  assert.equal(await more.getAttribute('aria-haspopup'), 'menu');
  assert.equal(await more.getAttribute('aria-expanded'), 'false');
  assert.equal(await menu.isVisible(), false);
  await more.press('Enter');
  assert.equal(await more.getAttribute('aria-expanded'), 'true');
  assert.equal(await menu.locator('[data-action="choose-repository"]').count(), 0, 'A single repository needs no chooser.');
  assert.equal(await menu.getByRole('menuitem', { name: 'Open saved Stashes' }).evaluate(element => document.activeElement === element), true);
  await page.keyboard.press('ArrowDown');
  assert.equal(await menu.getByRole('menuitem', { name: 'Open Commit tool window' }).evaluate(element => document.activeElement === element), true);
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  assert.equal(await menu.isVisible(), false);
  assert.equal(await more.evaluate(element => document.activeElement === element), true);
  assert.ok(await page.evaluate(() => window.__vscodeMessages.some(message => message.type === 'fetch')), 'Fetch from History More still reaches VS Code.');
  await more.press('ArrowDown');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await menu.isVisible(), false);
  assert.equal(await focusHistory.evaluate(element => document.activeElement === element), true, 'Tab leaves More in the toolbar focus order.');

  await page.setViewportSize({ width: 240, height: 260 });
  await page.evaluate(() => emit({ type: 'snapshot', payload: { ...fixture, repositoryCount: 2 } }));
  const selectedCommit = await page.locator('.graph-row.selected').getAttribute('data-commit');
  await more.press('ArrowUp');
  assert.equal(await menu.getByRole('menuitem', { name: /^Choose repository/ }).evaluate(element => document.activeElement === element), true);
  assert.equal(await menu.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return rect.left >= 7 && rect.right <= innerWidth - 7 && rect.top >= 0 && rect.bottom <= innerHeight - 7 && element.scrollWidth <= element.clientWidth;
  }), true, 'The overflow menu must be readable in a narrow, short History panel.');
  await page.keyboard.press('Escape');
  assert.equal(await menu.isVisible(), false);
  assert.equal(await more.evaluate(element => document.activeElement === element), true);
  assert.equal(await page.locator('.graph-row.selected').getAttribute('data-commit'), selectedCommit, 'Dismissing More must not clear the selected commit.');
  await more.click();
  const search = page.locator('#graph-search');
  await search.click();
  assert.equal(await menu.isVisible(), false);
  assert.equal(await search.evaluate(element => document.activeElement === element), true, 'Outside dismissal must not steal focus.');
  await page.evaluate(() => emit({ type: 'snapshot', payload: fixture }));
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
