import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, existsSync, readlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { renderInstaller } from '../render-installer.mjs';
import { signReleaseDocument } from '../lib/standalone-release.mjs';
import { sha256File } from '../../apps/server/src/platform/filesystem/release-artifact.ts';
import { DISTRIBUTION } from '../lib/product.mjs';

test('bootstrap verifies before execution, preserves settings and services, and isolates temporary CLI selection', t => {
  const root = mkdtempSync(join(tmpdir(),'palmagent-installer-test-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const pair=generateKeyPairSync('ed25519'), keys={test:pair.publicKey.export({type:'spki',format:'pem'})};
  const signed=value=>signReleaseDocument(value,'test',pair.privateKey.export({type:'pkcs8',format:'pem'}),keys);
  const version='0.2.0-alpha.1', target=`linux-${process.arch}-glibc`, sourceCommit='a'.repeat(40);
  const put=(path,content,mode)=>{mkdirSync(dirname(path),{recursive:true});writeFileSync(path,content,{mode});};
  const bundle=join(root,'source/palmagent');
  const identity={schemaVersion:1,distribution:'standalone',version,target,sourceCommit,nodeVersion:'24.21.0',nodeAbi:'137',minGlibc:'2.35'};
  put(join(bundle,'bundle.json'),JSON.stringify(identity));
  put(join(bundle,'app/package.json'),JSON.stringify({version}));
  put(join(bundle,'app/build-info.json'),JSON.stringify({version,sourceCommit,dirty:false}));
  // This fixture tests bootstrap ordering and filesystem effects. Real Node,
  // SQLite, PTY and glibc loading are exercised by standalone-smoke in native CI.
  put(join(bundle,'runtime/bin/node'),`#!/bin/sh\nprintf executed >> "$INSTALLER_EXECUTION_MARKER"\nif [ "$1" = '--input-type=commonjs' ]; then cat >/dev/null; exit 0; fi\nprintf '%s\\n' '${version}'\n`,0o755);
  put(join(bundle,'bin/palmagent'),'#!/bin/sh\nexit 0\n',0o755);
  const filename=`palmagent-${version}-${target}.tar.gz`, archive=join(root,filename);
  execFileSync('tar',['--hard-dereference','-czf',archive,'-C',join(root,'source'),'palmagent']);
  const manifest={schemaVersion:1,version,sourceCommit,nodeVersion:identity.nodeVersion,nodeAbi:identity.nodeAbi,pluginTag:`v${version}`,runId:'42',artifacts:[
    {target,filename,url:`${DISTRIBUTION.repositoryUrl}/releases/download/v${version}/${filename}`,sha256:sha256File(archive),size:statSync(archive).size,unpackedSize:10000,minGlibc:'2.35',requiredLibraries:[]},
  ]};
  const manifestBytes=signed(manifest);
  put(join(root,'manifest.json'),manifestBytes);
  put(join(root,'channel.json'),signed({schemaVersion:1,channel:'preview',revision:1,version,releaseManifestUrl:`${DISTRIBUTION.repositoryUrl}/releases/download/v${version}/standalone.json`,releaseManifestSha256:createHash('sha256').update(manifestBytes).digest('hex')}));
  put(join(root,'install.sh'),renderInstaller({trust:{schemaVersion:1,keys}}));
  put(join(root,'bin/curl'),`#!${process.execPath}\nconst fs=require('node:fs'),p=require('node:path'),a=process.argv.slice(2),url=a[a.indexOf('--url')+1];\nconst name=url.endsWith('preview.json')?'channel.json':url.endsWith('standalone.json')?'manifest.json':p.basename(url);fs.copyFileSync(p.join(process.env.INSTALLER_FIXTURE,name),a[a.indexOf('--output')+1]);\n`,0o755);
  const home=join(root,'home'), preferences=join(home,'.palmagent/config.json');
  put(preferences,JSON.stringify({schemaVersion:1,channel:'preview',future:{keep:true}}));
  const before=readFileSync(preferences,'utf8'), marker=join(root,'executed'), prefix=join(root,'temporary');
  const env={...process.env,HOME:home,PALMAGENT_HOME:join(home,'.palmagent'),PATH:join(root,'bin')+':'+process.env.PATH,INSTALLER_FIXTURE:root,INSTALLER_EXECUTION_MARKER:marker};
  const run=(...args)=>spawnSync('/bin/sh',[join(root,'install.sh'),'--prefix',prefix,'--print-path',...args],{env,encoding:'utf8'});
  let result=run();assert.equal(result.status,0,result.stderr);
  const command=result.stdout.trim();assert(command.startsWith(prefix+'/releases/'));assert(existsSync(command));
  const current=readlinkSync(join(prefix,'current'));
  assert.equal(readFileSync(preferences,'utf8'),before);assert.equal(existsSync(join(home,'.local/bin/palmagent')),false);
  assert.equal(existsSync(join(home,'.palmagent/data/install.env')),false);
  rmSync(marker);result=run('--channel','stable','--to',version);assert.notEqual(result.status,0);assert(!existsSync(marker));
  const envelope=JSON.parse(manifestBytes);envelope.payload=Buffer.from('{}').toString('base64');put(join(root,'manifest.json'),JSON.stringify(envelope));
  result=run('--to',version);assert.notEqual(result.status,0);assert.match(result.stderr,/signature/);assert(!existsSync(marker));assert.equal(readlinkSync(join(prefix,'current')),current);
  put(join(root,'manifest.json'),manifestBytes);put(archive,'changed');
  result=run('--to',version);assert.notEqual(result.status,0);assert(!existsSync(marker));assert.equal(readlinkSync(join(prefix,'current')),current);
});
