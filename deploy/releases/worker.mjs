import { ChannelIndexSchema, RELEASE_PUBLIC_KEYS } from '../../packages/shared/src/standalone.ts';
import { compareProductVersions } from '../../packages/shared/src/product-version.mjs';
import distribution from '../../packages/shared/src/distribution.json' with { type: 'json' };

const issuer = 'https://token.actions.githubusercontent.com';
const repository = distribution.repositoryUrl.replace('https://github.com/', '');
const decode = value => Uint8Array.from(atob(value), character => character.charCodeAt(0));
const decodeUrl = value => decode(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4));
const jsonPart = value => JSON.parse(new TextDecoder().decode(decodeUrl(value)));

export async function authorizePublisher(request, channel, env, fetcher = fetch, now = Date.now()) {
  const token = request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_.-]+)$/)?.[1];
  if (!token || token.length > 32_768 || !/^[1-9]\d*$/.test(env.REPOSITORY_ID ?? '')) throw new Error('Publication identity required');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid publication identity');
  const header = jsonPart(parts[0]), claims = jsonPart(parts[1]);
  const branch = channel === 'preview' ? 'develop' : 'main';
  const environment = channel === 'preview' ? 'standalone-preview' : 'npm-latest';
  const workflow = `${repository}/.github/workflows/npm-publish.yml@refs/heads/${branch}`;
  const seconds = now / 1000;
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || claims.iss !== issuer || claims.aud !== distribution.releaseOrigin ||
      claims.repository !== repository || claims.repository_id !== env.REPOSITORY_ID || claims.ref !== `refs/heads/${branch}` ||
      claims.sub !== `repo:${repository}:environment:${environment}` || claims.workflow_ref !== workflow ||
      (claims.job_workflow_ref && claims.job_workflow_ref !== workflow) ||
      !Number.isFinite(claims.exp) || !Number.isFinite(claims.nbf) || !Number.isFinite(claims.iat) ||
      claims.exp <= seconds || claims.nbf > seconds + 30 || claims.iat > seconds + 30 || claims.exp - claims.iat > 600)
    throw new Error('Publication identity is not authorized for this channel');
  const response = await fetcher(`${issuer}/.well-known/jwks`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error('Cannot verify publication identity');
  const jwks = await response.json();
  const matching = jwks.keys.filter(key => key.kid === header.kid && key.kty === 'RSA' && key.use === 'sig');
  if (matching.length !== 1) throw new Error('Unknown publication key');
  const key = await crypto.subtle.importKey('jwk', matching[0], { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, decodeUrl(parts[2]), new TextEncoder().encode(parts.slice(0, 2).join('.'))))
    throw new Error('Invalid publication signature');
}

export async function verifyChannelDocument(bytes, keys = RELEASE_PUBLIC_KEYS) {
  if (bytes.byteLength > 64 * 1024) throw new Error('Channel document is too large');
  const envelope = JSON.parse(new TextDecoder().decode(bytes));
  if (envelope.schemaVersion !== 1 || typeof envelope.payload !== 'string' || !Array.isArray(envelope.signatures) || envelope.signatures.length > 8)
    throw new Error('Invalid channel envelope');
  const payload = decode(envelope.payload);
  let trusted = false;
  for (const entry of envelope.signatures) {
    if (!Object.hasOwn(keys, entry.keyId)) continue;
    const pem = keys[entry.keyId].replace(/-----[^-]+-----|\s/g, '');
    const key = await crypto.subtle.importKey('spki', decode(pem), 'Ed25519', false, ['verify']);
    if (await crypto.subtle.verify('Ed25519', key, decode(entry.signature), payload)) { trusted = true; break; }
  }
  if (!trusted) throw new Error('Untrusted channel signature');
  const value = ChannelIndexSchema.parse(JSON.parse(new TextDecoder().decode(payload)));
  if (value.releaseManifestUrl !== `${distribution.repositoryUrl}/releases/download/v${value.version}/standalone.json`)
    throw new Error('Channel manifest must belong to the official versioned release');
  return value;
}

async function boundedBody(request) {
  if (!request.body) throw new Error('Missing channel document');
  const reader = request.body.getReader(), chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 64 * 1024) throw new Error('Channel document is too large');
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export async function handleReleaseRequest(request, env, { authorize = authorizePublisher, verifyDocument = verifyChannelDocument } = {}) {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/health') return Response.json({ ok: true, schemaVersion: 1 });
  if (request.method === 'GET' && url.pathname === '/install.sh') {
    const response = await env.ASSETS.fetch(new Request(`${distribution.releaseOrigin}/install.sh`));
    return new Response(response.body, { status: response.status, headers: { 'Content-Type': 'text/x-shellscript; charset=utf-8',
      'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff' } });
  }
  const channel = url.pathname.match(/^\/channels\/(stable|preview)\.json$/)?.[1];
  if (!channel) return new Response('Not found', { status: 404 });
  const key = `channels/${channel}.json`;
  if (request.method === 'GET' || request.method === 'HEAD') {
    const object = await env.RELEASE_INDEX.get(key);
    if (!object) return new Response('Channel is not published', { status: 404, headers: { 'Cache-Control': 'no-store' } });
    return new Response(request.method === 'HEAD' ? null : object.body, { headers: {
      'Content-Type': 'application/json', 'Cache-Control': 'no-store', ETag: object.httpEtag,
    } });
  }
  if (request.method !== 'PUT' && request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  try { await authorize(request, channel, env); }
  catch { return new Response('Publication is not authorized', { status: 403 }); }
  try {
    const bytes = await boundedBody(request), value = await verifyDocument(bytes);
    if (value.channel !== channel) return new Response('Channel mismatch', { status: 400 });
    const previous = await env.RELEASE_INDEX.get(key);
    // Authenticated preflight verifies the deployed trust keys and bucket before
    // the publisher creates an immutable tag or exposes release assets.
    if (request.method === 'POST') return new Response(null, { status: 204 });
    if (previous) {
      if (request.headers.get('if-match') !== previous.httpEtag) return new Response('Channel changed', { status: 412 });
      const before = await verifyDocument(new Uint8Array(await previous.arrayBuffer()));
      if (value.revision !== before.revision + 1 || compareProductVersions(value.version, before.version) <= 0)
        return new Response('Channel must advance to a newer release', { status: 409 });
    } else if (request.headers.get('if-none-match') !== '*' || value.revision !== 1) return new Response('Initial channel precondition required', { status: 412 });
    // R2 applies this condition atomically; a read followed by an unconditional
    // write would allow an older concurrent publisher to overwrite a newer one.
    const stored = await env.RELEASE_INDEX.put(key, bytes, { onlyIf: new Headers(previous ? { 'If-Match': previous.httpEtag } : { 'If-None-Match': '*' }),
      httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' } });
    if (!stored) return new Response('Channel changed', { status: 412 });
    return new Response(null, { status: 204, headers: { ETag: stored.httpEtag } });
  } catch { return new Response('Invalid channel document', { status: 400 }); }
}

export default { fetch: handleReleaseRequest };
