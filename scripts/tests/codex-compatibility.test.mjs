import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allowedChanges, gateVersion, lastSupported, nextCandidate, nextPatch, saveState, updateCompatibility } from '../lib/codex-compatibility.mjs';
import { compareProtocolContracts, projectSchema, protocolContracts, schemaDifferences } from '../lib/codex-schema-contract.mjs';

const object = (properties, required = []) => ({ type: 'object', properties, required });
const text = { type: 'string' };
const number = { type: 'integer' };
const clone = value => structuredClone(value);

test('every App Server method referenced by the adapter has a schema contract', () => {
  const source = readFileSync(new URL('../../apps/server/src/codex-interactive.ts', import.meta.url), 'utf8');
  const declared = new Set(protocolContracts.flatMap(([, , methods]) => Object.keys(methods)));
  const referenced = [...source.matchAll(/"([a-zA-Z]+(?:\/[a-zA-Z]+)+|initialize|initialized)"/g)].map(match => match[1]);
  assert.ok(referenced.length > 10, 'Adapter method discovery must not become an empty check');
  for (const method of referenced) assert.ok(declared.has(method), 'Missing consumed method contract: ' + method);
});

test('stable discovery advances one published release at a time without accepting prereleases or rollback', () => {
  const registry = { versions: ['0.160.0', '0.160.1', '0.161.0-alpha.1', '0.161.0', '0.162.0'],
    'dist-tags': { latest: '0.161.0' } };
  assert.equal(nextCandidate(registry, '0.160.0'), '0.160.1');
  assert.equal(nextCandidate(registry, '0.160.1'), '0.161.0');
  assert.equal(nextCandidate(registry, '0.161.0'), null);
  assert.equal(nextCandidate(registry, '0.162.0'), null);
  assert.throws(() => nextCandidate({ ...registry, 'dist-tags': { latest: '0.162.0-alpha.1' } }, '0.161.0'));
  assert.equal(nextPatch('0.160.9'), '0.160.10');
  assert.equal(lastSupported({ range: '>=0.154.0 <0.160.1', minimum: '0.154.0', exclusiveMaximum: '0.160.1' }), '0.160.0');
  assert.throws(() => lastSupported({ range: '>=0.154.0 <0.161.0', minimum: '0.154.0', exclusiveMaximum: '0.161.0' }));
});

test('schema checks ignore descriptions and unrelated fields, but find removed consumed fields and new required inputs', () => {
  const before = object({ id: text, optional: text }, ['id']);
  const after = clone(before);
  after.description = 'Updated upstream documentation';
  after.properties.unrelated = { type: 'boolean' };
  const project = schema => projectSchema(schema, { id: true });
  assert.deepEqual(schemaDifferences(project(before), project(after)), []);
  after.required.push('unrelated');
  assert.match(schemaDifferences(project(before), project(after)).join(), /required/);
  delete after.properties.id;
  assert.throws(() => project(after), /Missing consumed property/);
});

test('outgoing enums may expand and incoming enums may narrow, but incompatible type/status changes fail', () => {
  const a = { type: 'string', enum: ['completed', 'failed'] };
  const b = { type: 'string', enum: ['completed', 'failed', 'interrupted'] };
  assert.deepEqual(schemaDifferences(a, b, 'out'), []);
  assert.match(schemaDifferences(a, b, 'in').join(), /enum/);
  assert.deepEqual(schemaDifferences(b, a, 'in'), []);
  assert.match(schemaDifferences(a, { type: 'integer' }, 'in').join(), /type/);
  assert.match(schemaDifferences(object({ id: text }, ['id']), object({ id: text }), 'in').join(), /required/);
});

test('schema union ordering and additive request variants are harmless; deleted text variant is not', () => {
  const variant = type => object({ type: { type: 'string', enum: [type] }, value: text }, ['type', 'value']);
  const a = { oneOf: [variant('text'), variant('image')] };
  const b = { oneOf: [variant('image'), variant('audio'), variant('text')] };
  assert.deepEqual(schemaDifferences(a, b), []);
  assert.ok(schemaDifferences(b, a).length);
  const projected = projectSchema(b, { $variants: { text: true, image: true } });
  assert.equal(projected.oneOf.length, 2);
  assert.throws(() => projectSchema({ oneOf: [variant('audio')] }, { $variants: { text: true } }), /variant/);
});

test('local refs are resolved and cyclic JSON definitions terminate; unsupported references fail closed', () => {
  const schema = { ...object({ id: { $ref: '#/definitions/Id' } }, ['id']), definitions: { Id: text } };
  assert.deepEqual(projectSchema(schema).properties.id, text);
  const recursive = { $ref: '#/definitions/Node', definitions: { Node: object({ child: { $ref: '#/definitions/Node' } }) } };
  assert.ok(JSON.stringify(projectSchema(recursive)).includes('$recursiveRef'));
  assert.throws(() => projectSchema({ $ref: 'https://example.test/schema' }), /local/);
});

test('nullable nested responses and arrays retain consumed constraints', () => {
  const schema = object({ error: { anyOf: [object({ message: text, extra: number }), { type: 'null' }] },
    questions: { type: 'array', items: object({ id: text, question: text, extra: number }, ['id', 'question']) } });
  const projected = projectSchema(schema, { error: { message: true }, questions: { $items: { id: true, question: true } } }, schema, [], 'in');
  assert.deepEqual(Object.keys(projected.properties.error.anyOf[0].properties), ['message']);
  assert.deepEqual(Object.keys(projected.properties.questions.items.properties), ['id', 'question']);
  const changed = clone(projected);
  changed.properties.questions.items.properties.id = number;
  assert.ok(schemaDifferences(projected, changed, 'in').length);
});

test('missing contract methods and unknown constraint changes fail closed', () => {
  assert.deepEqual(compareProtocolContracts({ initialize: { schema: text, direction: 'out' } }, {}), ['Missing contract: initialize']);
  assert.match(schemaDifferences(text, { ...text, pattern: '^id' }).join(), /constraint/);
});

function gateFixture(issues = []) {
  const calls = [];
  const state = { repairAttempts: 0 };
  const ports = {
    inspectBaseline: async () => { calls.push('baseline'); return {}; },
    inspectCandidate: async () => { calls.push('candidate'); return issues; },
    save: async () => { calls.push('save:' + state.repairAttempts); },
    repair: async () => { calls.push('repair'); },
    verifyRepair: async () => { calls.push('live'); },
  };
  return { calls, state, ports };
}
test('passing checks never invoke an agent or live inference even when repair is enabled', async () => {
  const f = gateFixture();
  assert.deepEqual(await gateVersion(f.ports, f.state, true), { status: 'passed', mode: 'schema-contract' });
  assert.deepEqual(f.calls, ['baseline', 'candidate']);
});
test('baseline/setup errors never authorize paid repair', async () => {
  for (const name of ['inspectBaseline', 'inspectCandidate']) {
    const f = gateFixture(['broken']);
    f.ports[name] = async () => { throw new Error('infrastructure failure'); };
    await assert.rejects(gateVersion(f.ports, f.state, true), /infrastructure/);
    assert.equal(f.state.repairAttempts, 0);
    assert.ok(!f.calls.includes('repair'));
  }
});
test('confirmed failure is persisted before a single paid attempt and live verification', async () => {
  const f = gateFixture(['removed turn/start']);
  assert.deepEqual(await gateVersion(f.ports, f.state, true), { status: 'passed', mode: 'repaired-live' });
  assert.deepEqual(f.calls, ['baseline', 'candidate', 'save:0', 'save:1', 'repair', 'live']);
  assert.equal((await gateVersion(f.ports, f.state, true)).status, 'held');
  assert.equal(f.calls.filter(call => call === 'repair').length, 1);
});
test('repair failure, crash and verification failure cannot spend again after restart', async () => {
  for (const name of ['repair', 'verifyRepair']) {
    const f = gateFixture(['broken']);
    f.ports[name] = async () => { throw new Error('interrupted'); };
    await assert.rejects(gateVersion(f.ports, f.state, true), /interrupted/);
    assert.equal(f.state.repairAttempts, 1);
    assert.equal((await gateVersion(f.ports, JSON.parse(JSON.stringify(f.state)), true)).status, 'held');
  }
});
test('disabled paid repair records the failure but cannot invoke Codex', async () => {
  const f = gateFixture(['broken']);
  assert.equal((await gateVersion(f.ports, f.state, false)).status, 'held');
  assert.deepEqual(f.calls, ['baseline', 'candidate', 'save:0']);
});
test('metadata-only promotion and repair file allowlists reject workflow and gate changes', () => {
  assert.equal(allowedChanges(['packages/shared/src/agent-compatibility.json']), true);
  assert.equal(allowedChanges(['apps/server/src/codex.ts']), false);
  assert.equal(allowedChanges(['apps/server/src/codex.ts'], true), true);
  for (const path of ['.github/workflows/ci.yml', 'scripts/codex-compat-routine.mjs', 'AGENTS.md', 'private.log']) {
    assert.equal(allowedChanges([path], true), false);
  }
  assert.equal(allowedChanges([]), false);
});
test('support update retains historical evidence, preserves Claude and records accurate verification mode', t => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-support-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'packages/shared/src'), { recursive: true });
  mkdirSync(join(dir, 'docs'));
  const path = join(dir, 'packages/shared/src/agent-compatibility.json');
  writeFileSync(path, JSON.stringify({ claude: { range: 'unchanged' }, codex: {
    range: '>=0.154.0 <0.160.1', minimum: '0.154.0', exclusiveMaximum: '0.160.1',
  } }));
  writeFileSync(join(dir, 'docs/CODEX-COMPATIBILITY.md'),
    '# Verification\n\nThe declared Codex range is ' + String.fromCharCode(96) + 'old' + String.fromCharCode(96) + '.\nOld explanation.\nThe shared metadata is copied.\nHistorical live evidence.\n');
  updateCompatibility(dir, '0.160.1', { mode: 'schema-contract', source: 'a'.repeat(40) });
  const result = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(result.codex.range, '>=0.154.0 <0.160.2');
  assert.deepEqual(result.claude, { range: 'unchanged' });
  assert.match(readFileSync(join(dir, 'docs/CODEX-COMPATIBILITY.md'), 'utf8'), /Historical live evidence/);
  assert.equal(JSON.parse(readFileSync(join(dir, 'docs/codex-compatibility-runs.json'), 'utf8'))[0].mode, 'schema-contract');
  assert.throws(() => updateCompatibility(dir, '0.160.0', {}), /non-increasing/);
  saveState(join(dir, 'state.json'), { repairAttempts: 1 });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')), { repairAttempts: 1 });
});
