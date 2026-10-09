import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const selected = page => page.locator('[data-commit][aria-selected="true"]');
const hashAt = (page, index) => page.locator('[data-commit]').nth(index).getAttribute('data-commit');
const row = (page, hash) => page.locator(`[data-commit="${hash}"]`);
async function capture(page, name) {
  if (!process.env.KIVO_CAPTURE_DIR) return;
  await mkdir(process.env.KIVO_CAPTURE_DIR, { recursive: true });
  await page.screenshot({ path: path.join(process.env.KIVO_CAPTURE_DIR, name), animations: 'disabled' });
}

export async function verifyHistorySelection(page, openSurface) {
  const original = page.viewportSize(), failures = [];
  page.setDefaultTimeout(8000);
  const cases = [
    ['current checkout stays pinned while searching and viewing another branch', async () => {
      await openSurface('surface=history');
      const checkout = await page.locator('.log-current-branch [data-log-branch]').getAttribute('data-log-branch');
      await page.locator('#log-branch-search').fill('master');
      assert.equal(await page.locator(`.log-current-branch [data-log-branch="${checkout}"]`).count(), 1);
      assert.equal(await page.locator(`[data-log-branch="${checkout}"]`).count(), 1);
      const pin = await page.locator('.log-current-branch').boundingBox(), search = await page.locator('#log-branch-search').boundingBox();
      assert.ok(pin.y + pin.height <= search.y, 'Actual checkout must be above the branch search.');
      await page.locator('.log-branch-tree [data-log-branch="master"]').click({ button: 'right' });
      assert.equal(await page.locator('.log-current-branch [data-log-branch]').getAttribute('data-log-branch'), checkout);
      assert.equal(await page.evaluate(() => window.__vscodeMessages.filter(message => message.type === 'checkout').length), 0);
      await page.locator('[data-branch-context-action="filter"]').click();
      assert.ok(await page.evaluate(() => window.__vscodeMessages.some(message => message.type === 'setHistoryRef' && message.branch === 'master')));
      assert.equal(await page.locator('.log-current-branch [data-log-branch]').getAttribute('data-log-branch'), checkout);
      await capture(page, '25-current-checkout-pinned.png');
      await page.locator('#log-branch-search').fill('no-such-branch');
      assert.equal(await page.locator('.log-current-branch [data-log-branch]').getAttribute('data-log-branch'), checkout);
    }],
    ['Ctrl/Cmd selection, ranges and context menus preserve the selected batch', async () => {
      for (const modifier of ['Control', 'Meta']) {
        await openSurface('surface=history');
        const hashes = await page.locator('[data-commit]').evaluateAll(rows => rows.slice(0, 4).map(row => row.dataset.commit));
        await row(page, hashes[0]).click();
        await row(page, hashes[2]).click({ modifiers: [modifier] });
        assert.equal(await selected(page).count(), 2);
        await row(page, hashes[0]).click({ modifiers: [modifier] });
        assert.equal(await selected(page).count(), 1);
        await row(page, hashes[0]).click();
        await row(page, hashes[3]).click({ modifiers: ['Shift'] });
        assert.equal(await selected(page).count(), 4);
        await row(page, hashes[1]).click({ button: 'right' });
        assert.equal(await selected(page).count(), 4, 'Right-clicking a selected row must preserve the whole selection.');
        assert.match(await page.locator('[data-commit-context-action="cherry-pick"]').textContent(), /4 Commits/);
        await capture(page, '26-history-multi-select.png');
        await page.keyboard.press('Escape');
        assert.equal(await page.evaluate(() => document.activeElement?.dataset.commit), hashes[1], 'Closing the menu must restore its row before the next keyboard action.');
        await row(page, hashes[0]).focus();
        await page.keyboard.press('Shift+ArrowDown');
        assert.equal(await selected(page).count(), 2);
        await page.keyboard.press('Shift+ArrowDown');
        assert.equal(await selected(page).count(), 3);
        await page.keyboard.press('Shift+F10');
        assert.equal(await selected(page).count(), 3);
        await page.locator('[data-commit-context-action="cherry-pick"]').click();
        await page.waitForSelector('.cherry-pick-commits li');
        assert.equal(await page.locator('.cherry-pick-commits li').count(), 3);
        assert.deepEqual(await page.locator('.cherry-pick-commits li code').evaluateAll(items => items.map(item => item.title)), hashes.slice(0, 3).reverse());
        const request = await page.evaluate(() => window.__vscodeMessages.filter(message => message.type === 'workflowRequest').at(-1));
        assert.deepEqual(request.hashes, hashes.slice(0, 3));
        await capture(page, '27-cherry-pick-preview.png');
        await page.locator('.workflow-dialog [data-action="close-workflow"]').last().click();
        await page.waitForFunction(() => document.activeElement?.matches('[data-commit]'));
        assert.equal(await selected(page).count(), 3);
        assert.equal(await page.evaluate(() => window.__vscodeMessages.filter(message => message.type === 'cherryPick').length), 0, 'Cancel must not execute Git.');
      }
    }],
    ['right-button dragging selects a range and offers batch cherry-pick on release', async () => {
      await openSurface('surface=history');
      const first = await page.locator('[data-commit]').nth(0).boundingBox(), fourth = await page.locator('[data-commit]').nth(3).boundingBox();
      await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
      await page.mouse.down({ button: 'right' });
      await page.mouse.move(fourth.x + fourth.width / 2, fourth.y + fourth.height / 2, { steps: 8 });
      await page.mouse.up({ button: 'right' });
      assert.equal(await selected(page).count(), 4);
      assert.equal(await page.locator('[data-commit-context-action="cherry-pick"]').isEnabled(), true);
      await page.locator('[data-commit-context-action="cherry-pick"]').click();
      await page.waitForSelector('[data-action="confirm-cherry-pick"]');
      const request = await page.evaluate(() => window.__vscodeMessages.filter(message => message.type === 'workflowRequest').at(-1));
      await page.locator('[data-action="confirm-cherry-pick"]').click();
      const confirmed = await page.evaluate(() => window.__vscodeMessages.filter(message => message.type === 'cherryPick'));
      assert.deepEqual(confirmed, [{ type: 'cherryPick', root: request.root, requestId: request.requestId }], 'Confirm executes only the reviewed host session.');
      assert.equal(await page.locator('.workflow-dialog').count(), 0);
    }],
    ['merge selection and stale checkout previews explain why cherry-pick cannot run', async () => {
      await openSurface('surface=history');
      await page.locator('[data-commit]').nth(4).click({ button: 'right' });
      assert.equal(await page.locator('[data-commit-context-action="cherry-pick"]').isDisabled(), true);
      assert.match(await page.locator('[data-commit-context-action="cherry-pick"]').getAttribute('title'), /mainline parent/);
      await page.keyboard.press('Escape');
      await page.locator('[data-commit]').nth(1).click({ button: 'right' });
      await page.locator('[data-commit-context-action="cherry-pick"]').click();
      await page.waitForSelector('[data-action="confirm-cherry-pick"]');
      await page.evaluate(() => emit({ type: 'snapshot', payload: { ...fixture, headOid: 'a'.repeat(40) } }));
      assert.equal(await page.locator('[data-action="confirm-cherry-pick"]').isDisabled(), true);
      assert.match(await page.locator('.workflow-dialog [role="alert"]').textContent(), /branch changed/);
      await page.evaluate(() => emit({ type: 'snapshot', payload: { ...fixture, root: '/workspace/another-repo' } }));
      assert.equal(await page.locator('.workflow-dialog').count(), 0, 'Switching repositories must close the old preview.');
    }],
    ['selection survives refresh and virtual scrolling, and clears with filters or a repository switch', async () => {
      await openSurface('surface=history');
      await page.evaluate(() => {
        fixture.commits = Array.from({ length: 220 }, (_, index) => ({ ...fixture.commits[1], hash: String(index + 40000).padStart(40, '0'), shortHash: String(index + 40000), subject: `Commit ${index}`, parents: index < 219 ? [String(index + 40001).padStart(40, '0')] : [], refs: [] }));
        fixture.commitsHasMore = false;
        emit({ type: 'snapshot', payload: fixture });
      });
      const first = await hashAt(page, 0);
      await row(page, first).click();
      await page.keyboard.press('Shift+End');
      await page.waitForFunction(() => window.__vscodeState.repositoryStates[fixture.root].selectedCommitHashes.length === 220);
      await page.waitForFunction(() => document.activeElement?.dataset.commit === window.__vscodeState.repositoryStates[fixture.root].selectedCommitHash);
      assert.match(await page.locator('.history-selection-bar').textContent(), /220 commits selected/);
      assert.equal(await page.locator('[data-action="cherry-pick-selected"]').isDisabled(), true);
      await page.evaluate(() => emit({ type: 'snapshot', payload: { ...fixture, ahead: 4 } }));
      assert.match(await page.locator('.history-selection-bar').textContent(), /220 commits selected/);
      assert.equal(await page.evaluate(() => document.activeElement?.dataset.commit), String(40219).padStart(40, '0'), 'A snapshot must keep focus on the same virtual commit.');
      await page.keyboard.press('Shift+Home');
      await page.waitForFunction(() => document.activeElement?.dataset.commit === window.__vscodeState.repositoryStates[fixture.root].selectedCommitHash);
      assert.equal(await selected(page).count(), 1, 'Shrinking a keyboard range across virtual rows must use the original anchor.');
      await page.keyboard.press('Shift+ArrowDown');
      assert.equal(await selected(page).count(), 2);
      await page.locator('#graph-search').fill('Commit 99');
      await page.waitForFunction(() => !document.querySelector('[data-graph-list]')?.getAttribute('aria-busy').includes('true'));
      assert.ok(await selected(page).count() <= 1, 'Filtering must not retain hidden selected commits.');
      await page.evaluate(() => emit({ type: 'snapshot', payload: { ...fixture, root: '/workspace/new-root' } }));
      assert.equal(await page.locator('.history-selection-bar').count(), 0);
    }],
    ['empty cherry-pick offers Skip without dropping staged edits', async () => {
      await openSurface('surface=history');
      await page.evaluate(() => emit({ type: 'snapshot', payload: { ...fixture, operation: { kind: 'cherry-pick', token: 'empty-pick', files: [], canSkip: true } } }));
      assert.equal(await page.locator('[data-action="continue-operation"]').isDisabled(), true);
      await page.locator('[data-action="skip-operation"]').click();
      assert.ok(await page.evaluate(() => window.__vscodeMessages.some(message => message.type === 'skipOperation' && message.token === 'empty-pick' && message.root === fixture.root)));
      await page.evaluate(() => emit({ type: 'snapshot', payload: { ...fixture, operation: { kind: 'cherry-pick', token: 'resolved-pick', files: [] } } }));
      assert.equal(await page.locator('[data-action="skip-operation"]').count(), 0);
      assert.equal(await page.locator('[data-action="continue-operation"]').isEnabled(), true);
    }]
  ];
  try {
    for (const [name, run] of cases) {
      try { await page.setViewportSize({ width: 1450, height: 680 }); await run(); console.log(`PASS History regression: ${name}`); }
      catch (error) { failures.push(`${name}: ${error.stack}`); console.error(`FAIL History regression: ${name}: ${error.message}`); }
    }
  } finally { page.setDefaultTimeout(30000); await page.setViewportSize(original); }
  assert.equal(failures.length, 0, failures.join('\n\n'));
}
