import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

async function settle(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

export async function verifyExperienceRegressions(page, openSurface) {
  const originalViewport = page.viewportSize();
  const failures = [];
  const capture = async name => {
    if (!process.env.KIVO_CAPTURE_DIR) return;
    const directory = path.resolve(process.env.KIVO_CAPTURE_DIR);
    await mkdir(directory, { recursive: true });
    await page.screenshot({ path: path.join(directory, `${name}.png`), animations: 'disabled' });
  };
  const cases = [
    ['search editing preserves the caret and selection', async () => {
      for (const { surface, selector, open } of [
        { surface: 'changes', selector: '#change-search', open: '[data-action="search-changes"]' },
        { surface: 'changes', selector: '#branch-search', open: '[data-action="branches"]' },
        { surface: 'history', selector: '#graph-search' },
        { surface: 'history', selector: '#graph-path' },
        { surface: 'history', selector: '#graph-author' },
        { surface: 'history', selector: '#log-branch-search', open: '.log-branch-search' }
      ]) {
        await page.setViewportSize(surface === 'changes' ? { width: 360, height: 820 } : { width: 1450, height: 650 });
        await openSurface(`surface=${surface}`);
        if (open) await page.locator(open).click();
        const input = page.locator(selector);
        await input.fill('README');
        await input.press('Home');
        await input.press('X');
        await settle(page);
        assert.equal(await input.evaluate(element => element.selectionStart), 1, `${selector}: inserting at the beginning must keep the caret there.`);
        await input.press('Y');
        await settle(page);
        assert.equal(await input.inputValue(), 'XYREADME', `${selector}: the next keystroke must continue at the insertion point.`);
        await input.fill('abcdef');
        await input.evaluate(element => element.setSelectionRange(2, 4, 'backward'));
        await page.keyboard.insertText('X');
        await settle(page);
        assert.equal(await input.inputValue(), 'abXef', `${selector}: replacing a selection must keep the correct text.`);
        assert.equal(await input.evaluate(element => element.selectionStart), 3, `${selector}: replacing a selection must preserve its resulting caret.`);
        await input.evaluate(element => {
          window.__editingInput = element;
          element.setSelectionRange(1, 3, 'backward');
          emit({ type: 'syncStatus', phase: 'idle' });
        });
        assert.deepEqual(await input.evaluate(element => ({ same: element === window.__editingInput, start: element.selectionStart, end: element.selectionEnd, direction: element.selectionDirection })),
          { same: true, start: 1, end: 3, direction: 'backward' }, `${selector}: background rendering must retain the same control and selection.`);
        if (selector === '#change-search') {
          await input.fill('README');
          await input.evaluate(element => {
            element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
            element.setSelectionRange(1, 1);
            element.setRangeText('中', 1, 1, 'end');
            element.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true, inputType: 'insertCompositionText', data: '中' }));
            element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中' }));
          });
          await settle(page);
          assert.equal(await input.inputValue(), 'R中EADME', 'Composition updates must retain text inserted in the middle.');
          assert.equal(await input.evaluate(element => element.selectionStart), 2, 'Composition updates must not move the caret to the end.');
          await capture('17-search-editing');
        }
      }
    }],
    ['clearing filters synchronizes live controls without losing work', async () => {
      await page.setViewportSize({ width: 360, height: 820 });
      await openSurface('surface=changes&state=grouped');
      const count = await page.locator('[data-file-row]').count();
      await page.locator('[data-select]').first().check({ force: true });
      await page.locator('#commit-message').fill('Keep this draft');
      await page.locator('[data-action="search-changes"]').click();
      await page.locator('#change-search').fill('no-such-file');
      await page.locator('[data-action="clear-change-filters"]').first().click();
      assert.equal(await page.locator('#change-search').inputValue(), '', 'Clear filters must clear the visible search text.');
      assert.equal(await page.locator('[data-file-row]').count(), count);
      assert.equal(await page.locator('[data-select]:checked').count(), 1);
      assert.equal(await page.locator('#commit-message').inputValue(), 'Keep this draft');
      await capture('18-cleared-filters');
      await page.locator('#change-filter').selectOption('untracked');
      await page.locator('[data-action="clear-change-filters"]').first().click();
      assert.equal(await page.locator('#change-filter').inputValue(), 'all', 'Clear filters must reset the live kind selector too.');
      assert.equal(await page.locator('[data-file-row]').count(), count);

      await page.setViewportSize({ width: 1450, height: 650 });
      await openSurface('surface=history');
      const commits = await page.locator('.graph-row').count();
      for (const selector of ['#graph-search', '#graph-path', '#graph-author']) await page.locator(selector).fill('no-such-value');
      await page.locator('[data-action="clear-graph-filters"]').click();
      for (const selector of ['#graph-search', '#graph-path', '#graph-author']) {
        assert.equal(await page.locator(selector).inputValue(), '', `${selector}: clearing History filters must clear its visible value.`);
      }
      assert.equal(await page.locator('.graph-row').count(), commits);
    }],
    ['complete-history search opens details outside the initial page', async () => {
      await page.setViewportSize({ width: 1450, height: 650 });
      await openSurface('surface=history');
      const hash = await page.evaluate(() => {
        const base = fixture.commits[0];
        window.__completeHistory = Array.from({ length: 240 }, (_, index) => ({ ...base,
          hash: (index + 1).toString(16).padStart(40, '0'), shortHash: (index + 1).toString(16).padStart(7, '0'),
          subject: index === 220 ? 'deep-history-marker' : `History commit ${index + 1}`, refs: [], body: 'Older commit explanation',
          parents: index < 239 ? [(index + 2).toString(16).padStart(40, '0')] : [], paths: ['src/archive/Legacy.ts'] }));
        fixture.commits = window.__completeHistory.slice(0, 80);
        fixture.commitsHasMore = true;
        emit({ type: 'snapshot', payload: fixture });
        return window.__completeHistory[220].hash;
      });
      await page.locator('#graph-search').fill('deep-history-marker');
      const row = page.locator(`[data-commit="${hash}"]`);
      await row.waitFor();
      await row.click();
      assert.equal(await page.locator('#kivo-log-details').count(), 1, 'A search result outside snapshot.commits must still render the detail pane.');
      await page.waitForSelector('[data-commit-file="src/archive/Legacy.ts"]');
      assert.match(await page.locator('.commit-metadata').textContent(), /deep-history-marker/);
      assert.match(await page.locator('.commit-body').textContent(), /Older commit explanation/);
      await capture('19-older-search-details');
      await page.locator('[data-commit-file="src/archive/Legacy.ts"]').click();
      assert.ok(await page.evaluate(hash => window.__vscodeMessages.some(message => message.type === 'openCommitDiff' && message.hash === hash && message.path === 'src/archive/Legacy.ts'), hash),
        'The searched commit must open its exact immutable file diff.');
      await page.locator('[data-action="clear-graph-filters"]').click();
      await page.waitForFunction(() => document.querySelector('.commit-metadata')?.textContent.includes('History commit 1'));
      await page.evaluate(hash => emit({ type: 'commitDetails', payload: { hash, subject: 'STALE SEARCH DETAILS', files: [] } }), hash);
      assert.doesNotMatch(await page.locator('.commit-metadata').textContent(), /STALE SEARCH DETAILS/);
    }],
    ['short History panes keep all commit information reachable', async () => {
      for (const viewport of [{ width: 700, height: 420 }, { width: 520, height: 420 }, { width: 960, height: 260 }]) {
        await page.setViewportSize(viewport);
        await openSurface('surface=history');
        await page.waitForSelector('.commit-metadata');
        await page.waitForSelector('[data-commit-file]');
        await page.evaluate(() => {
          const commit = fixture.commits[0];
          emit({ type: 'commitDetails', payload: { ...commit,
            body: Array.from({ length: 40 }, (_, index) => index === 39 ? 'READABLE_BODY_END' : `Commit explanation ${index + 1}`).join('\n'),
            files: Array.from({ length: 30 }, (_, index) => ({ path: `src/files/File${index}.ts`, status: 'M' })) } });
        });
        const overflow = await page.locator('#kivo-log-details').evaluate(element => ({
          extra: element.scrollHeight - element.clientHeight, policy: getComputedStyle(element).overflowY
        }));
        assert.ok(overflow.extra <= 1 || ['auto', 'scroll'].includes(overflow.policy), `${viewport.width}×${viewport.height}: overflowing sections must have a native scroll path.`);
        const metadata = page.locator('.commit-metadata');
        await metadata.focus();
        const readable = await metadata.evaluate(element => {
          const pane = element.closest('.commit-detail');
          const bounds = pane.getBoundingClientRect();
          const rect = element.getBoundingClientRect();
          return Math.min(bounds.bottom, rect.bottom, innerHeight) - Math.max(bounds.top, rect.top, 0);
        });
        assert.ok(readable >= 48, 'Focusing commit metadata must bring a readable portion into the short pane.');
        await metadata.press('Control+End');
        await page.waitForFunction(() => {
          const element = document.querySelector('.commit-metadata');
          return element.scrollTop + element.clientHeight >= element.scrollHeight - 1;
        }, undefined, { timeout: 1500 });
        assert.equal(await metadata.evaluate(element => element.scrollTop + element.clientHeight >= element.scrollHeight - 1), true,
          'The end of the commit body and parents must be reachable.');
        assert.equal(await metadata.evaluate(element => {
          const bounds = element.closest('.commit-detail').getBoundingClientRect();
          const body = element.querySelector('.commit-body').firstChild;
          const range = document.createRange();
          range.setStart(body, body.length - 'READABLE_BODY_END'.length);
          range.setEnd(body, body.length);
          return [range.getBoundingClientRect(), element.querySelector('.detail-parents').getBoundingClientRect()].every(rect =>
            rect.top >= Math.max(0, bounds.top) - 1 && rect.bottom <= Math.min(innerHeight, bounds.bottom) + 1);
        }), true, 'The last metadata section must actually be inside the visible pane.');
        if (viewport.width === 700) await capture('20-short-history-metadata');
        await page.locator('[data-commit-file="src/files/File29.ts"]').focus();
        assert.equal(await page.locator('[data-commit-file="src/files/File29.ts"]').evaluate(element => {
          const rect = element.getBoundingClientRect();
          const pane = element.closest('.commit-detail').getBoundingClientRect();
          return rect.top >= Math.max(0, pane.top) - 1 && rect.bottom <= Math.min(innerHeight, pane.bottom) + 1;
        }), true, 'Keyboard focus must also reveal the last changed file.');
      }
    }],
    ['workflow close restores its actual entry point', async () => {
      await page.setViewportSize({ width: 360, height: 820 });
      await openSurface('surface=changes');
      for (const close of ['button', 'escape']) {
        await page.locator('[data-action="toolbar-more"]').click();
        await page.locator('[data-action="stashes"]').click();
        await page.waitForSelector('.workflow-stash');
        await page.locator('.workflow-stash').click();
        await page.waitForSelector('[data-action="apply-stash"]');
        if (close === 'button') await page.getByRole('button', { name: 'Close workflow', exact: true }).click();
        else await page.keyboard.press('Escape');
        await settle(page);
        assert.equal(await page.locator('[data-action="toolbar-more"]').evaluate(element => element === document.activeElement), true,
          `Stash ${close}: return to More after nested stash navigation.`);
        if (close === 'escape') await capture('21-restored-stash-focus');
      }
      await page.setViewportSize({ width: 1450, height: 650 });
      await openSurface('surface=history');
      await page.locator('[data-action="stashes"]').click();
      await page.waitForSelector('.workflow-stash');
      await page.keyboard.press('Escape');
      await settle(page);
      assert.equal(await page.locator('[data-action="stashes"]').evaluate(element => element === document.activeElement), true,
        'A direct Stashes entry must regain focus.');
      const branch = page.locator('[data-log-branch="feature/keaton/20260924-solar"]');
      await branch.click({ button: 'right' });
      await page.locator('[data-branch-context-action="compare"]').click();
      await page.waitForSelector('.workflow-file');
      await page.keyboard.press('Escape');
      await settle(page);
      assert.equal(await branch.evaluate(element => element === document.activeElement), true, 'Comparison must return to the branch that opened it.');
      await page.setViewportSize({ width: 360, height: 820 });
      await openSurface('surface=changes');
      await page.locator('[data-action="branches"]').click();
      await page.locator('[data-checkout="feature/keaton/20260924-solar"]').click({ button: 'right' });
      await page.locator('[data-branch-context-action="compare"]').click();
      await page.waitForSelector('.workflow-file');
      await page.keyboard.press('Escape');
      await settle(page);
      assert.equal(await page.locator('[data-action="branches"]').evaluate(element => element === document.activeElement), true,
        'Closing a comparison from the branch popup must return to the visible branch picker entry.');
    }]
  ];
  try {
    for (const [name, run] of cases) {
      try { await run(); }
      catch (error) { failures.push(new Error(`${name}: ${error.message}`, { cause: error })); }
    }
    if (failures.length) throw new AggregateError(failures, 'Experience regression checks failed');
    console.log('Experience regressions passed: caret, cleared filters, complete-history details, short panes and workflow focus.');
  } finally {
    await page.setViewportSize(originalViewport);
  }
}
