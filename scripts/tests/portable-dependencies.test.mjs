import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { copyRuntimeDependencies, filesUnder } from '../lib/portable-dependencies.mjs';

test('portable dependencies preserve shared module state, cycles, and conflicting versions without links', t => {
  const root = mkdtempSync(join(tmpdir(), 'palmagent-portable-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source'), output = join(root, 'output');
  mkdirSync(join(source, 'node_modules'), { recursive: true });
  writeFileSync(join(source, 'package.json'), '{}');
  function pkg(id, name, version, dependencies, code) {
    const directory = join(root, 'store', id);
    mkdirSync(join(directory, 'node_modules'), { recursive: true });
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, version, main: 'index.cjs', dependencies }));
    writeFileSync(join(directory, 'index.cjs'), code);
    return directory;
  }
  const shared = pkg('registry', 'registry', '1.0.0', {}, 'module.exports = new Map();');
  const v1 = pkg('value-v1', 'value', '1.0.0', {}, 'module.exports = 1;');
  const v2 = pkg('value-v2', 'value', '2.0.0', {}, 'module.exports = 2;');
  const a = pkg('a', 'a', '1.0.0', { registry: '*', value: '1', b: '*' }, "exports.registry = require('registry'); exports.value = require('value'); exports.other = () => require('b');");
  const b = pkg('b', 'b', '1.0.0', { registry: '*', value: '2', a: '*' }, "exports.registry = require('registry'); exports.value = require('value'); exports.other = () => require('a');");
  for (const [parent, name, target] of [[source, 'a', a], [source, 'b', b], [a, 'registry', shared], [b, 'registry', shared], [a, 'value', v1], [b, 'value', v2], [a, 'b', b], [b, 'a', a]]) {
    symlinkSync(target, join(parent, 'node_modules', name));
  }
  assert.deepEqual(copyRuntimeDependencies(['a', 'b'], source, join(output, 'node_modules')), { a: '1.0.0', b: '1.0.0' });
  // The copied graph must be independent of the original pnpm store.
  rmSync(join(root, 'store'), { recursive: true });
  const require = createRequire(join(output, 'package.json'));
  const first = require('a'), second = require('b');
  assert.equal(first.registry, second.registry);
  first.registry.set('schema', 'registered');
  assert.equal(second.registry.get('schema'), 'registered');
  assert.equal(first.value, 1); assert.equal(second.value, 2);
  assert.equal(first.other(), second); assert.equal(second.other(), first);
  assert(filesUnder(output).length > 0);
});

test('portable WebAuthn dependencies load with one shared ASN.1 schema registry', t => {
  const root = mkdtempSync(join(tmpdir(), 'palmagent-webauthn-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  copyRuntimeDependencies(['@simplewebauthn/server'], new URL('../../apps/server/', import.meta.url).pathname, join(root, 'node_modules'));
  const require = createRequire(join(root, 'package.json'));
  assert.equal(typeof require('@simplewebauthn/server').generateRegistrationOptions, 'function');
});
