import assert from 'node:assert/strict';
import test from 'node:test';
import { downloadPinnedCompiler } from '../lib/native-toolchain.mjs';

test('native compiler recovery tries one mirror on timeout and enforces the pin on either source', async () => {
  const sources = [];
  const corrupt = () => new Response('unexpected archive');
  await assert.rejects(downloadPinnedCompiler('arm64', async url => {
    sources.push(new URL(url).host);
    if (sources.length === 1) throw new DOMException('fixture timeout', 'TimeoutError');
    return corrupt();
  }), /checksum mismatch/);
  assert.equal(new Set(sources).size, 2);

  let requests = 0;
  await assert.rejects(downloadPinnedCompiler('x64', async () => {
    requests++;
    return corrupt();
  }), /checksum mismatch/);
  assert.equal(requests, 1);
});
