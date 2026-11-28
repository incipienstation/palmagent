// Dispatch from the trusted develop ref and follow the specific run returned by GitHub.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const [pr, head, base] = process.argv.slice(2);
assert(process.argv.length <= 5 && /^[1-9]\d*$/.test(pr) && /^[a-f0-9]{40}$/.test(head)
  && (!base || /^[a-f0-9]{40}$/.test(base)), 'Usage: node scripts/queue-develop.mjs <PR> <verified-head> [pinned-base]');
const response = execFileSync('gh', [
  'api', 'repos/{owner}/{repo}/actions/workflows/merge-develop.yml/dispatches', '--method', 'POST',
  '-H', 'X-GitHub-Api-Version: 2026-03-10', '--input', '-',
], { encoding: 'utf8', input: JSON.stringify({ ref: 'develop', inputs: { pr, head, base: base ?? '' } }) });
const { workflow_run_id: id, html_url: url } = JSON.parse(response);
assert(Number.isSafeInteger(id) && id > 0, 'Dispatch returned no run ID. Inspect Actions before retrying.');
console.log(`Queued PR #${pr}: ${url}`);
execFileSync('gh', ['run', 'watch', String(id), '--exit-status', '--interval', '15'], { stdio: 'inherit' });
