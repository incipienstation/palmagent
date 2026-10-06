import ts from "typescript";
import assert from 'node:assert/strict';
import test from 'node:test';
import { dependencyCycles, serverDependency, serverLocation, moduleReferences } from '../../../../scripts/lib/architecture.mjs';

const source = file => `apps/server/src/${file}`;
const check = (from, to, typeOnly = false) => serverDependency(source(from), source(to), './dependency.js', typeOnly);

test('core cannot import technology, composition, or another module implementation, even as a type', () => {
  for (const typeOnly of [false, true]) {
    assert.match(check('modules/tasks/application/use-cases/create.ts', 'modules/tasks/adapters/outbound/sqlite.ts', typeOnly), /outer technology/);
    assert.match(check('modules/tasks/application/ports/outbound/store.ts', 'modules/tasks/application/use-cases/create.ts', typeOnly), /port cannot/);
    assert.match(check('modules/tasks/domain/task.ts', 'composition/config.ts', typeOnly), /runtime assembly/);
    assert.match(check('modules/tasks/application/use-cases/create.ts', 'modules/spaces/application/ports/inbound/spaces.ts', typeOnly), /public API/);
  }
  assert.equal(check('modules/tasks/application/use-cases/create.ts', 'modules/agents/api.ts', true), undefined);
  assert.equal(check('modules/tasks/adapters/outbound/sqlite.ts', 'modules/tasks/application/ports/outbound/store.ts', true), undefined);
});

test('public APIs cannot expose service classes, persistence or outbound ports', () => {
  for (const target of ['application/use-cases/create.ts', 'application/ports/outbound/store.ts', 'adapters/outbound/sqlite.ts']) {
    assert.match(check('modules/tasks/api.ts', `modules/tasks/${target}`, true), /selected inbound/);
  }
  assert.match(check('modules/tasks/api.ts', 'modules/tasks/application/ports/inbound/tasks.ts'), /selected inbound/);
  assert.equal(check('modules/tasks/api.ts', 'modules/tasks/application/ports/inbound/tasks.ts', true), undefined);
  assert.equal(check('modules/tasks/api.ts', 'modules/tasks/domain/models.ts', true), undefined);
});

test('transport, platform and unclassified files cannot bypass ownership', () => {
  assert.match(check('modules/spaces/adapters/inbound/http.ts', 'modules/spaces/adapters/outbound/discovery.ts'), /input contracts/);
  assert.match(check('platform/sqlite/connection.ts', 'modules/tasks/api.ts', true), /platform cannot/);
  assert.match(check('kernel/events.ts', 'modules/tasks/domain/models.ts', true), /feature-independent/);
  assert.equal(serverLocation(source('unregistered/hidden.ts')).area, 'unknown');
  assert.match(check('unregistered/hidden.ts', 'kernel/errors.ts'), /unclassified/);
});

test('dependency cycles include type edges and ignore legal shared dependencies', () => {
  assert.deepEqual(dependencyCycles([['tasks', 'agents'], ['installation', 'agents']]), []);
  assert.deepEqual(dependencyCycles([['tasks', 'agents'], ['agents', 'tasks']]), [['tasks', 'agents', 'tasks']]);
});

test('AST scan covers type imports, re-exports, require and dynamic imports', () => {
  const source = ts.createSourceFile('fixture.ts', `
    import type { Contract } from './type.js';
    import { type Other } from './named-type.js';
    export type { Contract } from './export-type.js';
    export * from './wildcard.js';
    type T = import('./inline.js').Contract;
    const a = require('./required.js');
    const b = import('./dynamic.js');
    import legacy = require('./legacy.js');
  `, ts.ScriptTarget.Latest, true);
  assert.deepEqual(moduleReferences(ts, source).map(({ specifier, typeOnly }) => [specifier.text, typeOnly]), [
    ['./type.js', true], ['./named-type.js', true], ['./export-type.js', true], ['./wildcard.js', false],
    ['./inline.js', true], ['./required.js', false], ['./dynamic.js', false], ['./legacy.js', false],
  ]);
});
