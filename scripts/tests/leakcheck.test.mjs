import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

test('package leak scanning works without repository secrets and redacts matches', t => {
  const directory = mkdtempSync(join(tmpdir(), 'palmagent-leakcheck-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const scan = () => spawnSync(process.execPath, [resolve('scripts/pkg-leakcheck.mjs'), directory],
    { encoding: 'utf8', env: {} });
  const file = join(directory, 'fixture.txt');
  writeFileSync(file, 'Safe public content\n');
  assert.equal(scan().status, 0);
  const token = 'gh' + 'p_' + 'x'.repeat(24);
  writeFileSync(file, `Safe public content\n${token}\n`);
  const rejected = scan();
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /fixture\.txt:2/);
  assert(!`${rejected.stdout}${rejected.stderr}`.includes(token));
});
