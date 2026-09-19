import test from 'node:test';
import assert from 'node:assert/strict';
import { github, registryMetadata } from '../lib/release-github.mjs';

const repository = 'example/palmagent';
const failure = (stderr, code) => Object.assign(new Error('gh failed'), { stderr: Buffer.from(stderr), code });

test('registry validation bypasses cached metadata without hiding lookup failures', async () => {
  const urls = [];
  const metadata = { versions: {}, 'dist-tags': {} };
  const request = async (url, options) => {
    urls.push(url);
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://registry.npmjs.org');
    assert.equal(parsed.pathname, '/palmagent');
    assert(parsed.searchParams.get('validation'));
    assert.equal(options.cache, 'no-store');
    return { ok: true, json: async () => metadata };
  };
  assert.deepEqual(await registryMetadata(request), metadata);
  assert.deepEqual(await registryMetadata(request), metadata);
  assert.notEqual(urls[0], urls[1]);
  assert.deepEqual(await registryMetadata(async () => ({ status: 404 })), metadata);
  await assert.rejects(registryMetadata(async () => ({ status: 503, ok: false })), /lookup failed/);
  await assert.rejects(registryMetadata(async () => ({ ok: true, json: async () => ({}) })), /Malformed/);
});

test('release asset reads retry connection resets with bounded backoff and preserve binary bytes', () => {
  const bytes = Buffer.from([0, 255, 1, 128]);
  const waits = [], warnings = [], requests = [];
  const result = github(repository, 'releases/assets/42', { binary: true }, {
    execute: (command, args, options) => {
      requests.push({ command, args, options });
      if (requests.length <= 2) throw failure('read: connection reset by peer');
      return bytes;
    },
    sleep: (ms) => waits.push(ms), warn: (message) => warnings.push(message),
  });
  assert.equal(result, bytes);
  assert.deepEqual(waits, [1000, 2000]);
  assert.equal(warnings.length, 2);
  assert.deepEqual(requests[0].args, ['api', 'repos/example/palmagent/releases/assets/42', '--method', 'GET', '-H', 'Accept: application/octet-stream']);
  assert.equal(requests[0].options.encoding, undefined);
  assert.equal(requests[0].options.timeout, 60000);
  assert.equal(requests[0].options.killSignal, 'SIGKILL');
  assert.deepEqual(requests[0], requests[2]);
});

test('retryable read failures stop after four attempts, including timeouts and transient HTTP responses', () => {
  for (const error of [failure('', 'ETIMEDOUT'), failure('unexpected EOF'), ...[429, 500, 502, 503, 504].map((status) => failure(`gh: unavailable (HTTP ${status})`))]) {
    let calls = 0; const waits = [];
    assert.throws(() => github(repository, 'releases', {}, {
      execute: () => { calls++; throw error; }, sleep: (ms) => waits.push(ms), warn: () => {},
    }), (thrown) => thrown === error);
    assert.equal(calls, 4);
    assert.deepEqual(waits, [1000, 2000, 4000]);
  }
});

test('permission, missing resource, validation, and malformed response failures do not retry', () => {
  for (const status of [401, 403, 404, 422]) {
    let calls = 0;
    assert.throws(() => github(repository, 'releases', {}, {
      execute: () => { calls++; throw failure(`gh: rejected (HTTP ${status})`); },
      sleep: () => assert.fail('must not retry'),
    }));
    assert.equal(calls, 1);
  }
  let calls = 0;
  assert.throws(() => github(repository, 'releases', {}, {
    execute: () => { calls++; return 'invalid JSON'; }, sleep: () => assert.fail('must not retry'),
  }), SyntaxError);
  assert.equal(calls, 1);
});

test('writes never retry an ambiguous transport failure or server error', () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    for (const error of [failure('connection reset by peer'), failure('gh: unavailable (HTTP 503)')]) {
      let calls = 0;
      assert.throws(() => github(repository, 'pulls/1/merge', { method, body: { sha: 'a'.repeat(40) } }, {
        execute: (_command, args, options) => {
          calls++;
          assert(args.includes('--input'));
          assert.deepEqual(JSON.parse(options.input), { sha: 'a'.repeat(40) });
          throw error;
        }, sleep: () => assert.fail('must not retry a write'),
      }), (thrown) => thrown === error);
      assert.equal(calls, 1);
    }
  }
});

test('a recovered JSON read is parsed only after a successful response', () => {
  let calls = 0;
  assert.deepEqual(github(repository, 'pulls/1', {}, {
    execute: () => { if (!calls++) throw failure('gh: unavailable (HTTP 502)'); return '{"number":1}'; },
    sleep: () => {}, warn: () => {},
  }), { number: 1 });
  assert.equal(calls, 2);
});
