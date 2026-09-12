import { execFileSync } from 'node:child_process';

export function github(repository, path, { method = 'GET', body, binary = false } = {}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid GitHub repository');
  const args = ['api', `repos/${repository}/${path}`, '--method', method];
  if (binary) args.push('-H', 'Accept: application/octet-stream');
  if (body !== undefined) args.push('--input', '-');
  const result = execFileSync('gh', args, { input: body === undefined ? undefined : JSON.stringify(body),
    encoding: binary ? undefined : 'utf8', maxBuffer: 128 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
  return binary ? result : result.trim() ? JSON.parse(result) : null;
}

export function githubPages(repository, path, field) {
  const result = [];
  for (let page = 1; ; page++) {
    const value = github(repository, `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    const entries = field ? value[field] : value;
    if (!Array.isArray(entries)) throw new Error('Unexpected GitHub list response');
    result.push(...entries);
    if (entries.length < 100) return result;
  }
}

export async function registryMetadata(request = fetch) {
  const response = await request('https://registry.npmjs.org/palmagent', { signal: AbortSignal.timeout(30000) });
  if (response.status === 404) return { versions: {}, 'dist-tags': {} };
  if (!response.ok) throw new Error('npm metadata lookup failed');
  const result = await response.json();
  if (!result.versions || !result['dist-tags']) throw new Error('Malformed npm metadata');
  return result;
}

export async function registryTarball(metadata, request = fetch) {
  const url = new URL(metadata.dist?.tarball);
  if (url.origin !== 'https://registry.npmjs.org') throw new Error('Unexpected npm tarball origin');
  const response = await request(url, { redirect: 'error', signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error('npm tarball download failed');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 128 * 1024 * 1024) throw new Error('npm tarball exceeds size limit');
  return bytes;
}

export const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
