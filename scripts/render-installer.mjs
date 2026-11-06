import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DISTRIBUTION } from './lib/product.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function renderInstaller({ trust = JSON.parse(readFileSync(resolve(root, 'packages/shared/src/release-trust.json'), 'utf8')) } = {}) {
  if (trust.schemaVersion !== 1 || !Object.keys(trust.keys).length) throw new Error('Installer requires release trust keys');
  let result = readFileSync(resolve(root, 'scripts/templates/install.sh'), 'utf8');
  for (const [key, value] of Object.entries({ RELEASE_ORIGIN: DISTRIBUTION.releaseOrigin, REPOSITORY_URL: DISTRIBUTION.repositoryUrl, RELEASE_TRUST: JSON.stringify(trust) })) {
    if (value.includes("'")) throw new Error('Installer constant cannot contain a shell quote');
    result = result.replaceAll(`@${key}@`, value);
  }
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const output = resolve(process.argv[2] ?? 'build/installer/install.sh');
  mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, renderInstaller(), { mode: 0o755 });
  console.log(output);
}
