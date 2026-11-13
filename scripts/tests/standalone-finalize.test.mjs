import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { releaseFixture } from './release-fixture.mjs';
import { prepareCandidate } from '../release-candidate.mjs';
import { finalizeRelease } from '../release-finalize.mjs';
import { signReleaseDocument } from '../lib/standalone-release.mjs';
import { sha256File } from '../../apps/server/src/platform/filesystem/release-artifact.ts';
import { DISTRIBUTION } from '../lib/product.mjs';

test('Preview finalization exposes verified standalone assets before the channel and never calls npm', async t => {
  const version = '0.2.0-alpha.1', f = releaseFixture(t, version);
  const pair = generateKeyPairSync('ed25519'), keys = {test:pair.publicKey.export({type:'spki',format:'pem'})};
  f.put('packages/shared/src/distribution.json', JSON.stringify(DISTRIBUTION));
  f.put('packages/shared/src/release-trust.json', JSON.stringify({schemaVersion:1, keys}));
  const commit = f.commit(); f.git('update-ref', 'refs/remotes/origin/develop', commit);
  const directory = join(f.root,'bundle'), fixture = join(f.root,'fixture'); mkdirSync(directory);
  for (const name of ['runtime/bin/node', 'app/package.json', 'bundle.json']) {
    const path = join(fixture, 'palmagent', name); mkdirSync(join(path, '..'), {recursive:true}); writeFileSync(path, '{}');
  }
  for (const target of ['linux-x64-glibc','linux-arm64-glibc']) {
    const filename = `palmagent-${version}-${target}.tar.gz`, path = join(directory,filename);
    execFileSync('tar',['-czf',path,'-C',fixture,'palmagent']);
    writeFileSync(join(directory,`${target}.json`),JSON.stringify({schemaVersion:1,distribution:'standalone',version,sourceCommit:commit,target,nodeVersion:'24.21.0',nodeAbi:'137',minGlibc:'2.35',
      artifact:{target,filename,url:`${DISTRIBUTION.repositoryUrl}/releases/download/v${version}/${filename}`,sha256:sha256File(path),size:statSync(path).size,unpackedSize:6,minGlibc:'2.35',requiredLibraries:[]}}));
  }
  const candidate = prepareCandidate(f.root,directory,commit,42,'example/palmagent');
  const env = {GITHUB_ACTIONS:'true',ACTIONS_ID_TOKEN_REQUEST_URL:'oidc',ACTIONS_ID_TOKEN_REQUEST_TOKEN:'test-only',STANDALONE_PUBLISH_ENABLED:'true',
    RELEASE_COMMIT:commit,CANDIDATE_RUN_ID:'42',GH_REPO:'example/palmagent',EXPECTED_ARTIFACT_SHA256:candidate.sha256,RELEASE_ENVIRONMENT:'standalone-preview'};
  let release, tag, failPreflight = true, failChannel = true;
  const calls = [], assets = new Map();
  const adapters = {
    sign: value => signReleaseDocument(value,'test',pair.privateKey.export({type:'pkcs8',format:'pem'}),keys),
    standalonePreflight: async () => { if(failPreflight) throw new Error('hosting unavailable'); calls.push('preflight'); },
    channel: async () => null,
    metadata: () => assert.fail('Preview must not query npm'), publish: () => assert.fail('Preview must not publish npm'), skipFetch:true,
    checkTag: (value,object) => ({...value,tagObject:object}),
    releases: () => release ? [release] : [], refreshRelease: () => release,
    assets: { download: asset => assets.get(asset.name), upload: (name,bytes) => {assets.set(name,bytes);release.assets.push({name,id:name});calls.push('asset');} },
    verifyPublicStandalone: async () => { assert.equal(release.draft,false);calls.push('public-verified'); },
    stageChannel: async () => { if(failChannel) throw new Error('conditional update failed'); calls.push('channel'); return {commit:'c'.repeat(40)}; },
    api: (path,options) => {
      if(path.startsWith('environments/')) return {name:'standalone-preview'};
      if(path.startsWith('git/matching-refs')) return tag ? [{ref:`refs/tags/v${version}`,object:{type:'tag',sha:tag}}] : [];
      if(path.startsWith('git/tags/')) return {tag:`v${version}`,object:{type:'commit',sha:commit}};
      if(path==='git/tags') {calls.push('tag');tag='b'.repeat(40);return {sha:tag};}
      if(path==='git/refs') return {};
      if(path==='releases') {calls.push('draft');return release={id:1,tag_name:`v${version}`,prerelease:true,draft:true,assets:[],html_url:'https://example.invalid/release'};}
      assert.equal(path,'releases/1');assert.equal(options.body.draft,false);calls.push('public');release.draft=false;
    },
  };
  await assert.rejects(finalizeRelease(f.root,directory,env,adapters),/hosting unavailable/);assert.deepEqual(calls,[]);
  failPreflight=false;
  await assert.rejects(finalizeRelease(f.root,directory,env,adapters),/conditional update failed/);
  assert.equal(release.draft,false);assert.equal(calls.at(-1),'public-verified');
  const snapshot=new Map(assets);failChannel=false;
  const staged = await finalizeRelease(f.root,directory,env,adapters);
  assert.equal(staged.publication,'standalone-staged');
  assert.equal(staged.pagesCommit,'c'.repeat(40));
  assert.equal(calls.at(-1),'channel');assert.equal(calls.filter(c=>c==='tag').length,1);assert.deepEqual(assets,snapshot);
  assert(![...assets.keys()].some(name=>name.endsWith('.tgz')));
});
