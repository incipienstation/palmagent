import test from 'node:test';
import assert from 'node:assert/strict';
import { isProductPath, productChanges, nextPreviewVersion, assertPreparation } from '../lib/preview-plan.mjs';
import { planPreview, preparationMarker, preparationValidation, assertPreparationRun, mergePreparation, waitForPublication, successfulPreview, addMaintenanceNotes } from '../preview-release.mjs';
import { prepareVersion } from '../release-version.mjs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { releaseFixture } from './release-fixture.mjs';
const repository = 'example/palmagent';

test('Preview classifies shipped product inputs separately from tests and maintenance instructions', () => {
  for (const path of ['apps/server/src/index.ts', 'apps/web/public/sw.js', 'packages/shared/src/index.ts', 'skills/.shared/bootstrap.md',
    'plugins/claude/skills/install/SKILL.md', 'plugins/codex/plugins/palmagent/.codex-plugin/plugin.json', 'scripts/build-pkg.ts', 'pnpm-lock.yaml']) assert(isProductPath(path), path);
  for (const path of ['README.md', 'apps/web/README.md', 'docs/STAGING.md', '.harness/skills/release/SKILL.md', 'AGENTS.md', '.github/workflows/ci.yml',
    'scripts/tests/release.test.mjs', 'apps/web/tests/smoke.spec.ts', 'apps/server/src/a.test.ts', 'apps/web/playwright.config.ts', 'CHANGELOG.md']) assert(!isProductPath(path), path);
});

test('metadata preparation cannot loop, while dependency and deleted product inputs remain eligible', (t) => {
  const f = releaseFixture(t);
  f.put('package.json', JSON.stringify({ name: 'palmagent', version: '0.1.0-alpha.2', scripts: { test: 'new check' } }));
  f.put('CHANGELOG.md', '# Changes\n\n## Unreleased\n\nNotes.\n');
  const metadata = f.commit();
  assert.deepEqual(productChanges(f.root, f.source, metadata), []);
  f.put('package.json', JSON.stringify({ name: 'palmagent', version: '0.1.0-alpha.2', dependencies: { example: '2' } }));
  const dependency = f.commit();
  assert.deepEqual(productChanges(f.root, metadata, dependency), ['package.json']);
  f.git('rm', 'apps/server/src/index.ts'); const removed = f.commit();
  assert.deepEqual(productChanges(f.root, dependency, removed), ['apps/server/src/index.ts']);
  assert.throws(() => productChanges(f.root, removed, dependency));
});

test('version allocation skips immutable tags and npm versions, and refuses a stale lane', () => {
  assert.equal(nextPreviewVersion('0.1.0-alpha.3', ['v0.1.0-alpha.3', '0.1.0-alpha.4']), '0.1.0-alpha.5');
  assert.equal(nextPreviewVersion('0.1.0-beta.1', ['0.1.0-alpha.9']), '0.1.0-beta.1');
  assert.throws(() => nextPreviewVersion('0.1.0-alpha.1', ['0.1.0-beta.1']), /behind/);
  assert.throws(() => nextPreviewVersion('0.1.0-rc.1', ['0.1.0']), /behind/);
});

test('last successful publication captures failed changes even when the latest commit only changes docs', (t) => {
  const f = releaseFixture(t);
  f.put('apps/server/src/index.ts', 'export const value = 2;\n'); const changed = f.commit();
  f.put('README.md', 'Docs'); const docs = f.commit();
  const registry = { versions: { '0.1.0-alpha.1': {} } };
  assert.equal(planPreview(f.root, docs, { commit: f.source }, registry, []).action, 'prepare');
  assert.equal(planPreview(f.root, docs, { commit: changed }, registry, []).action, 'skip');
});

test('Stable preparation pauses Preview; first product change after published Stable starts the next patch', (t) => {
  const f = releaseFixture(t, '0.1.0');
  f.put('apps/server/src/index.ts', 'export const value = 2;\n'); const source = f.commit();
  assert.equal(planPreview(f.root, source, { commit: f.source }, { versions: {} }, []).action, 'skip');
  assert.equal(planPreview(f.root, source, { commit: f.source }, { versions: { '0.1.0': {} } }, []).version, '0.1.1-alpha.1');
});

test('preparation contains only synchronized versions and changelog, with fallback notes for maintenance', (t) => {
  const f = releaseFixture(t);
  addMaintenanceNotes(f.root, repository, { commit: f.source }, f.source);
  assert(readFileSync(join(f.root, 'CHANGELOG.md'), 'utf8').includes('/compare/'));
  prepareVersion(f.root, '0.1.0-alpha.2', { apply: true }); const head = f.commit();
  assert.doesNotThrow(() => assertPreparation(f.root, f.source, head, '0.1.0-alpha.2'));
  f.put('apps/server/src/index.ts', 'unexpected'); const extra = f.commit();
  assert.throws(() => assertPreparation(f.root, head, extra, '0.1.0-alpha.2'), /outside/);
  assert.deepEqual(preparationMarker({ body: `<!-- palmagent-preview:{"source":"${f.source}","version":"0.1.0-alpha.2"} -->` }), { source: f.source, version: '0.1.0-alpha.2' });
});

test('preparation merge obeys exact CI identity, successful validate, updated base, and server protections', async () => {
  const source = 'a'.repeat(40), head = 'b'.repeat(40), merged = 'c'.repeat(40);
  const branch = 'feature/preview-0.1.0-alpha.2';
  let didMerge = false;
  const run = { repository: { full_name: repository }, path: '.github/workflows/ci.yml', event: 'pull_request',
    head_branch: branch, head_sha: head, status: 'completed', conclusion: 'success', html_url: 'https://example.invalid/run' };
  const api = (_repo, path, options) => {
    if (path === 'pulls/1') return { number: 1, head: { sha: head, ref: branch }, base: { ref: 'develop' }, state: 'open', mergeable: true, merged: didMerge, merge_commit_sha: merged };
    if (path === 'git/ref/heads/develop') return { object: { sha: source } };
    if (path === 'actions/runs/42') return run;
    assert.equal(path, 'pulls/1/merge'); assert.deepEqual(options.body, { sha: head, merge_method: 'squash' }); didMerge = true;
  };
  const pages = () => [{ name: 'validate', head_sha: head, status: 'completed', conclusion: 'success' }];
  const adapters = { api, pages, validation: async () => 42 };
  assert.equal(await mergePreparation('', repository, { number: 1 }, head, source, adapters), merged);
  await assert.rejects(mergePreparation('', repository, { number: 1 }, 'd'.repeat(40), source, adapters), /identity changed/);
  didMerge = false;
  assert.equal(await mergePreparation('', repository, { number: 1 }, head, 'd'.repeat(40), adapters), null);
  await assert.rejects(mergePreparation('', repository, { number: 1 }, head, source, {
    ...adapters, api: (repo, path, options) => path === 'actions/runs/42' ? { ...run, conclusion: 'failure' } : api(repo, path, options),
  }), /CI failed/);
  await assert.rejects(mergePreparation('', repository, { number: 1 }, head, source, {
    ...adapters, pages: () => [{ ...pages()[0], conclusion: 'skipped' }],
  }), /no successful validate/);
  await assert.rejects(mergePreparation('', repository, { number: 1 }, head, source, {
    ...adapters, api: (repo, path, options) => { if (path.endsWith('/merge')) throw new Error('review required'); return api(repo, path, options); },
  }), /review required/);
  run.conclusion = 'action_required';
  let approved = false;
  assert.equal(await mergePreparation('', repository, { number: 1 }, head, source, {
    ...adapters, sleep: async () => { assert(!didMerge); approved = true; run.conclusion = 'success'; },
  }), merged);
  assert(approved, 'must wait for approval rather than treating the held run as a success');
  for (const change of [{ head_sha: source }, { head_branch: 'develop' }, { event: 'workflow_dispatch' },
    { path: '.github/workflows/other.yml' }, { repository: { full_name: 'other/repo' } }]) {
    assert.throws(() => assertPreparationRun({ ...run, ...change }, repository, branch, head), /identity differs/);
  }
});

test('preparation selects the latest native PR workflow for its exact head and PR', async () => {
  const head = 'b'.repeat(40), pr = { number: 1 };
  const run = { id: 42, head_sha: head, pull_requests: [{ number: 1 }], status: 'completed', conclusion: 'action_required' };
  let calls = 0;
  const pages = (_repo, path) => {
    assert.equal(path, 'actions/workflows/ci.yml/runs?event=pull_request');
    if (!calls++) return []; // GitHub may create the run after returning the PR.
    return [{ ...run, id: 44, pull_requests: [{ number: 2 }] }, { ...run, id: 43, head_sha: 'c'.repeat(40) }, run, { ...run, id: 41 }];
  };
  assert.equal(await preparationValidation(repository, pr, head, { pages, sleep: async () => {} }), 42);
  assert.equal(calls, 2);
});

test('failed publication retry reuses original candidate producer across repeated recovery runs', async () => {
  const commit = 'a'.repeat(40), title = `Publish ${commit}`;
  const run = (id, conclusion) => ({ id, display_title: title, status: 'completed', conclusion, html_url: 'https://example.invalid/run' });
  let dispatched = false, body;
  const pages = (_repo, path) => path.includes('/runs?') ? [ ...(dispatched ? [run(3, 'success')] : []), run(2, 'failure'), run(1, 'failure') ]
    : path.includes('/1/artifacts') ? [{ name: `palmagent-candidate-${commit}`, expired: false }] : [];
  const api = (_repo, path, options) => {
    if (path.endsWith('/dispatches')) { body = options.body; dispatched = true; return; }
    assert.equal(path, 'actions/runs/1');
    return { id: 1, repository: { full_name: repository }, path: '.github/workflows/npm-publish.yml', event: 'workflow_dispatch', head_branch: 'develop', head_sha: commit };
  };
  assert.equal((await waitForPublication(repository, commit, { api, pages, sleep: async () => {} })).id, 3);
  assert.equal(body.inputs.candidate_run, '1');
});

test('successful Preview baseline requires public release, exact annotated tag, and matching registry bytes', async (t) => {
  const f = releaseFixture(t); const tag = 'v0.1.0-alpha.1';
  f.git('tag', '-a', tag, '-m', 'Fixture tag');
  const bytes = Buffer.from('immutable package');
  const hash = (algorithm, encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding);
  const receipt = { version: tag.slice(1), tag, channel: 'next', branch: 'develop', commit: f.source, tagObject: f.git('rev-parse', tag), sha256: hash('sha256') };
  const releases = [{ draft: false, prerelease: true, tag_name: tag }];
  const registry = { versions: { [receipt.version]: { dist: { integrity: `sha512-${hash('sha512', 'base64')}` } } } };
  const adapters = { manifest: async () => receipt, tarball: async () => bytes };
  assert.deepEqual(await successfulPreview(f.root, releases, registry, adapters), receipt);
  assert.equal(await successfulPreview(f.root, [{ ...releases[0], draft: true }], registry, adapters), null);
  await assert.rejects(successfulPreview(f.root, releases, registry, { ...adapters, tarball: async () => Buffer.from('changed') }), /bytes differ/);
});

test('a preparation cannot smuggle root command changes through the non-product script exception', (t) => {
  const f = releaseFixture(t);
  addMaintenanceNotes(f.root, repository, { commit: f.source }, f.source);
  prepareVersion(f.root, '0.1.0-alpha.2', { apply: true });
  const pkg = JSON.parse(readFileSync(join(f.root, 'package.json'), 'utf8'));
  f.put('package.json', JSON.stringify({ ...pkg, scripts: { verify: 'skip' } }));
  const head = f.commit();
  assert.deepEqual(productChanges(f.root, f.source, head), []);
  assert.throws(() => assertPreparation(f.root, f.source, head, '0.1.0-alpha.2'), /other than version/);
});

test('root build entrypoint changes remain product inputs even though test aliases do not', (t) => {
  const f = releaseFixture(t);
  const pkg = JSON.parse(readFileSync(join(f.root, 'package.json'), 'utf8'));
  f.put('package.json', JSON.stringify({ ...pkg, scripts: { 'pkg:assemble': 'tsx scripts/new-builder.ts' } }));
  const head = f.commit();
  assert.deepEqual(productChanges(f.root, f.source, head), ['package.json']);
});
