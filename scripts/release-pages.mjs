#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildReleasePages, assertPagesHead, verifyReleasePages } from './lib/release-pages.mjs';
import { DISTRIBUTION } from './lib/product.mjs';

try {
  const [command, directory, commit] = process.argv.slice(2);
  if (!directory || !['build', 'check', 'verify'].includes(command)) throw new Error('Usage: release-pages.mjs build|check|verify <directory> [channel-commit]');
  if (process.env.GH_REPO !== DISTRIBUTION.repositoryUrl.replace('https://github.com/', '')) throw new Error('Unexpected release Pages repository');
  const output = resolve(directory);
  if (command === 'build') console.log(JSON.stringify(buildReleasePages(output, process.env, { expectedCommit: commit })));
  else {
    assertPagesHead(output, process.env);
    if (command === 'verify') {
      await verifyReleasePages(output);
      const message = `Verified installer and both release channels at ${DISTRIBUTION.releaseOrigin}.`;
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
      console.log(message);
    }
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
