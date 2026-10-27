#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Defense in depth for the workflow_run job condition. A stale run is skipped;
// unexpected event or checkout data fails closed.
export function releaseGate(event, repository, checkout, mainHead) {
  const run = event?.workflow_run;
  const hash = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/i;
  if (event?.action !== 'completed' || run?.name !== 'CI' || run?.conclusion !== 'success' ||
      run?.event !== 'push' || run?.head_branch !== 'main' ||
      !repository || run?.head_repository?.full_name !== repository) {
    throw new Error('Release requires a successful CI run for a push to this repository’s main branch.');
  }
  if (!hash.test(run.head_sha ?? '') || !hash.test(checkout) || !hash.test(mainHead)) {
    throw new Error('Unable to verify the CI commit and current main branch.');
  }
  if (checkout !== run.head_sha) throw new Error('Checked-out commit does not match the successful CI run.');
  return checkout === mainHead;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [eventFile, repository, checkout, mainHead] = process.argv.slice(2);
  if (!eventFile || !repository || !checkout || !mainHead) throw new Error('Missing release gate input.');
  const current = releaseGate(JSON.parse(readFileSync(eventFile, 'utf8')), repository, checkout, mainHead);
  if (!current) console.error('CI commit is no longer the tip of main; skipping release.');
  console.log(`current=${current}`);
}
