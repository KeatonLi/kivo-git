import assert from 'node:assert/strict';

async function observeMotion(page) {
  await page.evaluate(() => {
    window.__motionCalls = [];
    window.__motionCancellations = 0;
    const original = Element.prototype.animate;
    Element.prototype.animate = function(frames, options) {
      window.__motionCalls.push({ classes: String(this.className), branch: Boolean(this.closest('.log-current-branch')), duration: options.duration });
      const animation = original.call(this, frames, options);
      const cancel = animation.cancel.bind(animation);
      animation.cancel = () => { window.__motionCancellations += 1; cancel(); };
      return animation;
    };
  });
}
const issue = (root, id) => ({ root, id, title: 'feature/login is already open in another worktree.', kind: 'checkout',
  worktreePath: '/projects/login-worktree', details: 'Open the registered worktree to continue.', actions: ['openWorktree', 'details', 'copy', 'refresh'] });

export async function verifyInteractionMotion(page, openSurface) {
  const viewport = page.viewportSize();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 360, height: 820 });
  await openSurface('surface=changes');
  await observeMotion(page);
  await page.locator('[data-action="branches"]').click();
  assert.equal(await page.evaluate(() => window.__motionCalls.filter(call => call.classes.includes('branch-popup')).length), 1, 'Opening a branch picker should animate once.');
  assert.ok(await page.locator('.branch-popup').evaluate(element => getComputedStyle(element).backgroundColor !== 'rgba(0, 0, 0, 0)'), 'A picker must stay opaque while animating.');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('[data-action="branches"]').evaluate(element => element === document.activeElement), true);

  const root = await page.evaluate(() => fixture.root);
  await page.evaluate(failure => emit({ type: 'operationFailure', root: failure.root, id: failure.id, failure }), issue(root, 60));
  const region = page.getByRole('region', { name: 'Last Git operation issue' });
  await region.waitFor();
  assert.equal(await page.evaluate(() => window.__motionCalls.filter(call => call.classes.includes('operation-failure')).length), 1);
  await page.evaluate(() => emit({ type: 'snapshot', payload: { ...fixture, commitsHasMore: !fixture.commitsHasMore } }));
  assert.equal(await page.evaluate(() => window.__motionCalls.filter(call => call.classes.includes('operation-failure')).length), 1, 'A background refresh must not replay the same error entrance.');
  await region.getByRole('button', { name: 'Dismiss operation issue' }).focus();
  await page.evaluate(() => emit({ type: 'operationFailure', root: fixture.root, id: 60, failure: null }));
  assert.equal(await region.count(), 0, 'A closing card must immediately leave the accessibility and keyboard path.');
  await page.evaluate(failure => emit({ type: 'operationFailure', root: failure.root, id: failure.id, failure }), issue(root, 61));
  await page.waitForTimeout(200);
  assert.equal(await region.getAttribute('data-failure-id'), '61', 'Completing an older exit must not remove a newer error.');

  assert.ok(await page.evaluate(failure => {
    emit({ type: 'operationFailure', root: failure.root, id: failure.id, failure });
    // Slow this real animation before yielding so a busy CI runner cannot let it
    // finish naturally before the preference-change event is delivered.
    for (const animation of runningMotion) animation.updatePlaybackRate(.05);
    return runningMotion.size > 0;
  }, issue(root, 62)), 'The preference switch must interrupt a running entrance.');
  const cancellations = await page.evaluate(() => window.__motionCancellations);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForFunction(before => reducedMotion.matches && window.__motionCancellations > before && runningMotion.size === 0, cancellations, { timeout: 2000 });
  assert.equal(await page.evaluate(() => runningMotion.size), 0, 'Enabling reduced motion must cancel active animations.');
  const before = await page.evaluate(() => window.__motionCalls.length);
  await page.evaluate(failure => emit({ type: 'operationFailure', root: failure.root, id: failure.id, failure }), issue(root, 63));
  assert.equal(await page.evaluate(() => window.__motionCalls.length), before, 'Reduced-motion users still receive the error without a WAAPI transition.');
  await page.evaluate(() => emit({ type: 'operationFailure', root: fixture.root, id: 63, failure: null }));
  assert.equal(await region.count(), 0);

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 1280, height: 650 });
  await openSurface('surface=history');
  await observeMotion(page);
  await page.evaluate(() => {
    emit({ type: 'operation', root: fixture.root, id: 80, kind: 'checkout', phase: 'loading', message: 'Switching to feature/login…' });
    emit({ type: 'operation', root: fixture.root, id: 80, kind: 'checkout', phase: 'success', message: 'Switched to feature/login' });
  });
  await page.waitForTimeout(180);
  assert.equal(await page.locator('[data-checkout-pending="true"]').count(), 0, 'A fast operation must never flash a waiting indicator after completion.');
  assert.equal(await page.locator('.toast.loading').count(), 0);

  await page.evaluate(() => emit({ type: 'operation', root: fixture.root, id: 81, kind: 'checkout', phase: 'loading', message: 'Switching to feature/login…' }));
  await page.locator('[data-checkout-pending="true"]').waitFor();
  assert.match(await page.locator('.log-current-branch > small').textContent(), /Switching to feature\/login/);
  await page.evaluate(() => {
    fixture.branches.forEach(branch => { branch.current = false; });
    fixture.branches.push({ name: 'feature/login', current: true, remote: false });
    fixture.branch = 'feature/login';
    emit({ type: 'snapshot', payload: fixture });
    emit({ type: 'operation', root: fixture.root, id: 81, kind: 'checkout', phase: 'success', message: 'Switched to feature/login' });
  });
  await page.waitForTimeout(220);
  assert.match(await page.locator('.log-current-branch').textContent(), /feature\/login/);
  assert.equal(await page.locator('.content').getAttribute('aria-busy'), 'false', 'Motion must not delay releasing completed controls.');
  const branchCalls = await page.evaluate(() => window.__motionCalls.filter(call => call.branch).length);
  await page.evaluate(() => emit({ type: 'snapshot', payload: { ...fixture, commitsHasMore: !fixture.commitsHasMore } }));
  assert.equal(await page.evaluate(() => window.__motionCalls.filter(call => call.branch).length), branchCalls, 'A no-op snapshot must not animate the current branch again.');
  await page.emulateMedia({ reducedMotion: null });
  await page.setViewportSize(viewport);
  console.log('Interaction motion passed: picker entry/opacity/focus, stable error refresh, interruption-safe exit, reduced motion, fast/slow checkout and stable branch updates.');
}
