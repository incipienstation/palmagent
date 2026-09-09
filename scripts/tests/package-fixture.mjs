import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const commit = 'a'.repeat(40);
export function packageFixture(root, { version = '0.1.0-alpha.1', legacy = false, dirty = false, scripts = {}, sourceCommit = commit } = {}) {
  const directory = join(root, 'package');
  mkdirSync(join(directory, 'web/assets'), { recursive: true });
  const files = {
    'package.json': JSON.stringify({ name: 'palmagent', version, private: false, scripts }),
    'cli.js': 'console.log("cli");', 'server.js': 'console.log("server");', 'runner-daemon.js': 'console.log("runner");',
    'web/index.html': '<div id="root"></div><script type="module" src="/assets/app.js"></script>',
    'web/assets/app.js': `console.log(${JSON.stringify(version)});`,
  };
  if (!legacy) files['build-info.json'] = JSON.stringify({ version, sourceCommit, dirty });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(directory, name), text);
  const path = join(root, `palmagent-${version}.tgz`);
  execFileSync('tar', ['-czf', path, '-C', root, 'package']);
  return { path, directory, files };
}
