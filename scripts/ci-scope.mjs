import { appendFileSync, readFileSync } from 'node:fs';
import { changedPaths, classifyChanges } from './lib/ci-scope.mjs';

let paths;
try {
  if (process.env.GITHUB_EVENT_NAME === 'pull_request') {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    paths = changedPaths(process.cwd(), event.pull_request.base.sha, event.pull_request.head.sha);
  }
} catch {
  console.log('Changed paths unavailable; selecting the full gate.');
}
const scope = classifyChanges(paths, process.env.GITHUB_EVENT_NAME);
const output = Object.entries(scope).map(([name, value]) => `${name}=${value}`).join('\n') + '\n';
console.log(output.trim());
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
