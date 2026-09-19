import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { requireSuccessfulChecks } from '../ci-results.mjs';

function results(outputs = {}) {
  return {
    scope: { result: 'success', outputs: { code: 'false', server: 'false', web: 'false', package: 'false', ...outputs } },
    tooling: { result: 'skipped' }, server: { result: 'skipped' }, web: { result: 'skipped' },
  };
}

test('metadata and trusted/fork packaging scopes require exactly their selected lanes', () => {
  for (const trusted of [true, false]) {
    requireSuccessfulChecks(results(), trusted);
    const packed = results({ package: 'true' });
    if (trusted) assert.throws(() => requireSuccessfulChecks(packed, trusted), /web/);
    else requireSuccessfulChecks(packed, trusted);
    packed.web.result = 'success';
    requireSuccessfulChecks(packed, trusted);
  }
});

test('every selected lane rejects missing, skipped, cancelled and failed results', () => {
  for (const [output, lane] of [['code', 'tooling'], ['server', 'server'], ['web', 'web']]) {
    for (const trusted of [true, false]) {
      const selected = results({ [output]: 'true' });
      selected[lane].result = 'success';
      requireSuccessfulChecks(selected, trusted);
      for (const result of ['skipped', 'cancelled', 'failure', undefined]) {
        selected[lane].result = result;
        assert.throws(() => requireSuccessfulChecks(selected, trusted), new RegExp(lane));
      }
      delete selected[lane];
      assert.throws(() => requireSuccessfulChecks(selected, trusted), new RegExp(lane));
    }
  }
});

test('scope failure, malformed selection and failed unselected checks fail closed', () => {
  for (const result of ['failure', 'cancelled', 'skipped', undefined]) {
    const value = results(); value.scope.result = result;
    assert.throws(() => requireSuccessfulChecks(value, true), /scope/);
  }
  for (const output of ['code', 'server', 'web', 'package']) {
    const value = results(); delete value.scope.outputs[output];
    assert.throws(() => requireSuccessfulChecks(value, true), /outputs/);
    value.scope.outputs[output] = true;
    assert.throws(() => requireSuccessfulChecks(value, true), /outputs/);
  }
  for (const lane of ['tooling', 'server', 'web']) {
    const value = results(); value[lane].result = 'failure';
    assert.throws(() => requireSuccessfulChecks(value, true), new RegExp(lane));
  }
});

test('CLI parses Actions outputs and exits nonzero for invalid evidence', () => {
  const run = (value, trusted = 'true') => execFileSync(process.execPath, ['scripts/ci-results.mjs'], {
    env: { ...process.env, RESULTS: value, TRUSTED_PR: trusted }, stdio: 'pipe',
  });
  run(JSON.stringify(results()));
  for (const value of ['invalid', '{}', JSON.stringify(results({ web: 'true' }))]) {
    assert.throws(() => run(value), { status: 1 });
  }
  assert.throws(() => run(JSON.stringify(results()), ''), { status: 1 });
});
