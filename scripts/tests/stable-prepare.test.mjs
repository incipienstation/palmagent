import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareStable } from '../stable-prepare.mjs';
import { releaseFixture } from './release-fixture.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function setup(t, phase = 'prepare') {
  const f = releaseFixture(t, phase === 'prepare' ? '0.1.0-alpha.1' : '0.1.0');
  if (phase === 'prepare') f.put('CHANGELOG.md', '# Changes\n\n## Unreleased\n\nReviewed changes.\n');
  else f.put('README.md', 'Reviewed promotion');
  const source = f.commit(), calls = [], pushes = [];
  const env = { GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/develop', GH_REPO: 'example/palmagent',
    GH_TOKEN: 'test-token', RELEASE_APP_CLIENT_ID: 'test-client', RELEASE_COMMIT: source,
    RELEASE_PHASE: phase, RELEASE_VERSION: '0.1.0', RELEASE_DRY_RUN: 'false' };
  const deps = {
    identity: () => ({ login: 'example-release[bot]', id: 123 }), registry: async () => ({ versions: {} }),
    pages: () => [], push: (branch) => pushes.push(branch),
    api: (repo, path, options = {}) => {
      calls.push({ repo, path, ...options });
      if (path === 'git/ref/heads/develop') return { object: { sha: source } };
      if (path === 'git/ref/heads/main') return { object: { sha: f.source } };
      assert.equal(path, 'pulls'); assert.equal(options.method, 'POST');
      return { number: 12, html_url: 'https://github.com/example/palmagent/pull/12' };
    },
  };
  return { f, source, env, deps, calls, pushes };
}

test('Stable App preparation writes only synchronized metadata and opens a develop PR', async (t) => {
  const x = setup(t);
  const result = await prepareStable(x.f.root, x.env, x.deps);
  assert.equal(result.action, 'opened'); assert.equal(result.mergeMethod, 'squash');
  assert.deepEqual(x.pushes, ['feature/stable-0.1.0']);
  assert.equal(x.calls.at(-1).body.base, 'develop');
  assert.equal(JSON.parse(readFileSync(join(x.f.root, 'package.json'))).version, '0.1.0');
  assert.equal(x.f.git('log', '-1', '--format=%an'), 'example-release[bot]');
  assert.match(x.calls.at(-1).body.body, /npm-latest approval/);
  assert.equal(x.f.git('tag', '--list'), '');
});

test('Stable promotion creates the App PR from develop into main without pushing or publishing', async (t) => {
  const x = setup(t, 'promote');
  const result = await prepareStable(x.f.root, x.env, x.deps);
  assert.equal(result.mergeMethod, 'merge'); assert.deepEqual(x.pushes, []);
  assert.equal(x.calls.at(-1).body.head, 'develop'); assert.equal(x.calls.at(-1).body.base, 'main');
  assert.equal(x.f.git('rev-parse', 'HEAD'), x.source);
});

test('dry-run validates metadata without commits or remote writes', async (t) => {
  const x = setup(t); x.env.RELEASE_DRY_RUN = 'true';
  assert.equal((await prepareStable(x.f.root, x.env, x.deps)).action, 'validated');
  assert.equal(x.f.git('rev-parse', 'HEAD'), x.source); assert.deepEqual(x.pushes, []);
  assert(!x.calls.some((c) => c.method));
});

test('rejects invalid authorization, stale source, published versions and unrelated PRs before push', async (t) => {
  const cases = [
    ['local execution', (x) => { x.env.GITHUB_ACTIONS = 'false'; }],
    ['wrong branch', (x) => { x.env.GITHUB_REF = 'refs/heads/main'; }],
    ['missing App', (x) => { x.env.RELEASE_APP_CLIENT_ID = ''; }],
    ['prerelease', (x) => { x.env.RELEASE_VERSION = '0.1.0-beta.1'; }],
    ['stale source', (x) => { x.deps.api = () => ({ object: { sha: 'a'.repeat(40) } }); }],
    ['published', (x) => { x.deps.registry = async () => ({ versions: { '0.1.0': {} } }); }],
    ['tagged', (x) => { x.f.git('tag', 'v0.1.0'); }],
    ['unowned PR', (x) => { x.deps.pages = () => [{ user: { login: 'someone' } }]; }],
  ];
  for (const [name, change] of cases) await t.test(name, async (t) => {
    const x = setup(t); change(x);
    await assert.rejects(prepareStable(x.f.root, x.env, x.deps));
    assert.deepEqual(x.pushes, []); assert(!x.calls.some((c) => c.method));
  });
});

test('promotion refuses an advanced head and version mismatch', async (t) => {
  const x = setup(t, 'promote'); x.env.RELEASE_VERSION = '0.2.0';
  await assert.rejects(prepareStable(x.f.root, x.env, x.deps), /version differs/);
  assert(!x.calls.some((c) => c.method));
});

test('an identical request reuses its verified App PR without another push', async (t) => {
  const x = setup(t);
  const first = await prepareStable(x.f.root, x.env, x.deps);
  const body = x.calls.at(-1).body.body;
  x.f.git('branch', first.branch, first.head);
  x.f.git('remote', 'add', 'origin', x.f.root);
  x.f.git('checkout', '--detach', x.source);
  x.deps.pages = () => [{ number: 12, html_url: 'https://github.com/example/palmagent/pull/12',
    user: { login: 'example-release[bot]' }, body, state: 'open', draft: false,
    head: { sha: first.head, ref: first.branch, repo: { full_name: x.env.GH_REPO } }, base: { ref: 'develop' } }];
  x.pushes.length = 0; x.calls.length = 0;
  const resumed = await prepareStable(x.f.root, x.env, x.deps);
  assert.equal(resumed.action, 'retained'); assert.equal(resumed.head, first.head);
  assert.deepEqual(x.pushes, []); assert(!x.calls.some((c) => c.method));
});

test('promotion refuses diverged main history before opening a PR', async (t) => {
  const x = setup(t, 'promote');
  x.f.git('checkout', '--detach', x.f.source); x.f.put('unrelated.txt', 'main fix');
  const main = x.f.commit(); x.f.git('checkout', '--detach', x.source);
  const original = x.deps.api;
  x.deps.api = (repo, path, options) => path === 'git/ref/heads/main' ? { object: { sha: main } } : original(repo, path, options);
  await assert.rejects(prepareStable(x.f.root, x.env, x.deps));
  assert(!x.calls.some((c) => c.method));
});
