import assert from 'node:assert/strict';
import test from 'node:test';
import { auditExitCode } from '../audit-javascript.mjs';

function result(findings = {}) {
  const counts = { low: 0, moderate: 0, high: 0, critical: 0, ...findings };
  const hasFindings = Object.values(counts).some(count => count > 0);
  return { status: Number(hasFindings), stdout: JSON.stringify({
    advisories: hasFindings ? { fixture: { severity: Object.keys(findings)[0] } } : {},
    metadata: { vulnerabilities: counts },
  }) };
}

test('clean scans pass both production and development gates', () => {
  assert.equal(auditExitCode(result(), 'low'), 0);
  assert.equal(auditExitCode(result(), 'moderate'), 0);
});

test('low findings fail production but remain reportable below the development gate', () => {
  const scan = result({ low: 1 });
  const original = scan.stdout;
  assert.equal(auditExitCode(scan, 'low'), 1);
  assert.equal(auditExitCode(scan, 'moderate'), 0);
  assert.equal(scan.stdout, original);
});

test('moderate and higher findings fail the development gate', () => {
  for (const level of ['moderate', 'high', 'critical']) {
    assert.equal(auditExitCode(result({ [level]: 1 }), 'moderate'), 1);
  }
});

test('registry failures, malformed reports and interrupted scans fail closed', () => {
  for (const scan of [
    { status: 1, stdout: JSON.stringify({ error: { message: 'fetch failed' } }) },
    { status: 0, stdout: '{}' }, { status: 0, stdout: 'not JSON' },
    { ...result(), status: 1 }, { ...result(), status: 2 },
    { ...result(), error: new Error('timeout') }, { ...result(), signal: 'SIGTERM' },
    { ...result({ low: 1 }), status: 0 }, result({ low: -1 }),
    { status: 1, stdout: JSON.stringify({ ...JSON.parse(result({ low: 1 }).stdout), advisories: {} }) },
  ]) assert.throws(() => auditExitCode(scan, 'moderate'));
});
