import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { protocolContracts } from '../lib/codex-schema-contract.mjs';

const entry = fileURLToPath(new URL('../codex-compat-routine.mjs', import.meta.url));
const schemaFor = mask => {
  if (mask === true) return { type: 'string' };
  if (mask.$items) return { type: 'array', items: schemaFor(mask.$items) };
  if (mask.$variants) return { oneOf: Object.entries(mask.$variants).map(([type, value]) => {
    const schema = value === true ? { type: 'object', properties: {} } : schemaFor(value);
    schema.properties.type = { type: 'string', enum: [type] };
    return schema;
  }) };
  return { type: 'object', properties: Object.fromEntries(Object.entries(mask).map(([key, value]) => [key, schemaFor(value)])) };
};
function schemas() {
  const result = {};
  for (const [file, , methods] of protocolContracts) {
    result[file] = { oneOf: Object.entries(methods).map(([method, mask]) => ({
      type: 'object', properties: { id: { type: 'string' }, method: { type: 'string', enum: [method] },
        ...(mask === null ? {} : { params: schemaFor(mask) }) },
    })) };
  }
  for (const file of ['v2/ThreadStartResponse', 'v2/ThreadResumeResponse']) result[file] = schemaFor({ thread: { id: true } });
  result['v2/TurnStartResponse'] = schemaFor({ turn: { id: true } });
  result['v2/ThreadCompactStartResponse'] = schemaFor({});
  for (const file of ['CommandExecutionRequestApprovalResponse', 'FileChangeRequestApprovalResponse', 'ToolRequestUserInputResponse']) result[file] = schemaFor({ answers: true });
  return result;
}
const cliStub = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), version = '__VERSION__';
fs.appendFileSync(process.env.TEST_CALLS, JSON.stringify(['codex', version, args]) + '\\n');
if (args[0] === '--version') console.log('codex-cli ' + version);
else if (args.includes('--help')) console.log('--json --sandbox --image --config --skip-git-repo-check');
else if (args[0] === 'login') console.error('Logged in using ChatGPT');
else if (args.includes('generate-json-schema')) {
  const out = args[args.indexOf('--out') + 1], schemas = JSON.parse(fs.readFileSync(process.env.TEST_SCHEMAS));
  if (process.env.TEST_FAIL && version === '0.160.1') schemas.ClientRequest.oneOf[0].properties.params.properties.clientInfo.properties.version.type = 'integer';
  if (process.env.TEST_RENAME && version === '0.160.1') {
    for (const name of ['v2/ThreadStartResponse', 'v2/ThreadResumeResponse']) {
      schemas[name].properties.thread.properties.key=schemas[name].properties.thread.properties.id;
      delete schemas[name].properties.thread.properties.id;
    }
    const notification=schemas.ServerNotification.oneOf.find(n=>n.properties.method.enum[0]==='thread/started');
    notification.properties.params.properties.thread.properties.key=notification.properties.params.properties.thread.properties.id;
    delete notification.properties.params.properties.thread.properties.id;
  }
  for (const [name, schema] of Object.entries(schemas)) {
    const file = path.join(out, name + '.json'); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(schema));
  }
} else if (args[0] === 'app-server') {
  process.stdin.once('data', chunk => { const message = JSON.parse(chunk.toString());
    if (message.method !== 'initialize') process.exit(99);
    console.log(JSON.stringify({id: message.id, result: {userAgent: 'fixture'}}));
  });
} else if (args[0] === 'exec') {
  if (process.env.TEST_BACKGROUND) require('node:child_process').spawn(process.execPath,
    ['-e', 'setTimeout(() => require("node:fs").writeFileSync(process.env.TEST_BACKGROUND, "orphan"), 1000)'], {stdio:'inherit'});
  process.stdin.resume(); process.stdin.on('end', () => {
    if (process.env.TEST_REPAIR_OK) {
      fs.appendFileSync('apps/server/src/modules/agents/adapters/outbound/codex.ts','// Repaired fixture adapter.\\n');
      const file='scripts/lib/codex-protocol-contract.mjs';
      fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('const thread = { id: true };','const thread = { key: true };'));
      process.exit(0);
    }
    process.exit(42);
  });
}
else process.exit(98);
`;
const npmStub = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === 'view') console.log(JSON.stringify({versions: ['0.160.0', '0.160.1'], 'dist-tags': {latest: process.env.TEST_NO_NEW ? '0.160.0' : '0.160.1'}}));
else if (args[0] === 'install') {
  const prefix = args[args.indexOf('--prefix') + 1], version = args.at(-1).split('@').at(-1), bin = path.join(prefix, 'node_modules/.bin');
  fs.mkdirSync(bin, {recursive: true});
  fs.writeFileSync(path.join(bin, 'codex'), fs.readFileSync(process.env.TEST_CLI, 'utf8').replace('__VERSION__', version), {mode: 0o755});
} else process.exit(97);
`;
const ghStub = `#!/usr/bin/env node
const fs = require('node:fs'), cp = require('node:child_process');
const args = process.argv.slice(2), file = process.env.TEST_PR;
const read = () => {
  if (!fs.existsSync(file)) return null;
  const pr=JSON.parse(fs.readFileSync(file));
  pr.head.sha=git('rev-parse','refs/remotes/origin/'+pr.head.ref);
  return pr;
};
const write = pr => fs.writeFileSync(file, JSON.stringify(pr));
const git = (...argv) => cp.execFileSync('git', argv, {cwd: process.env.TEST_REPO, encoding:'utf8'}).trim();
fs.appendFileSync(process.env.TEST_CALLS, JSON.stringify(['gh', args]) + '\\n');
if (args[0] === 'repo') console.log(JSON.stringify({nameWithOwner:'example/palmagent'}));
else if (args[0] === 'api') {
  const endpoint = args[1], method = args[args.indexOf('--method') + 1];
  if (method === 'POST') { let data=''; process.stdin.on('data', c => data += c); process.stdin.on('end', () => {
    const body = JSON.parse(data), pr = {number:1, state:'open', draft:false, html_url:'https://example.com/pull/1', body:body.body,
      base:{ref:'develop'}, head:{ref:body.head, sha:git('rev-parse',body.head), repo:{full_name:'example/palmagent'}}};
    write(pr); console.log(JSON.stringify(pr));
  }); }
  else if (endpoint.includes('pulls?')) console.log(JSON.stringify(read() ? [read()] : []));
  else if (endpoint.includes('/pulls/')) console.log(JSON.stringify(read()));
  else if (endpoint.endsWith('git/ref/heads/develop')) console.log(JSON.stringify({object:{sha:git('rev-parse','origin/develop')}}));
  else process.exit(96);
} else if (args[1] === 'checks') {
  if (args.includes('--json')) console.log(JSON.stringify([{name:'validate', state:process.env.TEST_CI_FAIL ? 'FAILURE' : 'SUCCESS', bucket:process.env.TEST_CI_FAIL ? 'fail' : 'pass'}]));
  if (process.env.TEST_CI_FAIL) process.exit(1);
} else if (args[1] === 'merge') {
  const pr=read(); pr.merged=true; pr.merged_at='2026-01-01T00:00:00Z'; pr.merge_commit_sha=pr.head.sha; write(pr);
} else process.exit(95);
`;
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'codex-routine-test-'));
  t.after(() => rmSync(root, {recursive:true, force:true}));
  const repo = join(root, 'repo'), remote = join(root, 'origin.git'), bin = join(root, 'bin');
  mkdirSync(repo); mkdirSync(bin);
  const git = (...args) => execFileSync('git', args, {cwd: repo, encoding:'utf8', stdio:['ignore','pipe','pipe']}).trim();
  git('init','--bare',remote); git('init','-b','develop');
  git('config','user.name','Fixture'); git('config','user.email','fixture@example.com');
  for (const directory of ['packages/shared/src','docs','scripts/lib','apps/server/src/modules/agents/adapters/outbound']) mkdirSync(join(repo,directory),{recursive:true});
  writeFileSync(join(repo,'.gitignore'),'node_modules/\n');
  writeFileSync(join(repo,'.nvmrc'),process.version.slice(1));
  writeFileSync(join(repo,'packages/shared/src/agent-compatibility.json'), JSON.stringify({codex:{minimum:'0.154.0',exclusiveMaximum:'0.160.1',range:'>=0.154.0 <0.160.1'}}));
  writeFileSync(join(repo,'docs/CODEX-COMPATIBILITY.md'),'The declared Codex range is old.\nThe shared metadata is copied.\n');
  writeFileSync(join(repo,'scripts/sync-skills.mjs'),'');
  writeFileSync(join(repo,'scripts/verify-local.mjs'),'if (process.env.TEST_VERIFY_FAIL) process.exit(1);\n');
  for (const name of ['codex-schema-contract.mjs','codex-protocol-contract.mjs']) {
    writeFileSync(join(repo,'scripts/lib',name),readFileSync(new URL('../lib/'+name,import.meta.url)));
  }
  writeFileSync(join(repo,'apps/server/src/modules/agents/adapters/outbound/codex.ts'),'// Fixture adapter\n');
  git('add','.'); git('commit','-m','fixture'); git('remote','add','origin',remote); git('push','-u','origin','develop');
  writeFileSync(join(root,'cli.cjs'),cliStub);
  writeFileSync(join(root,'schemas.json'),JSON.stringify(schemas()));
  writeFileSync(join(root,'calls.jsonl'),'');
  const pnpmStub='#!/usr/bin/env node\nrequire("node:fs").appendFileSync(process.env.TEST_CALLS,JSON.stringify(["pnpm",process.argv.slice(2)])+"\\n");\n';
  for (const [name, content] of Object.entries({npm:npmStub, gh:ghStub, pnpm:pnpmStub, codex:cliStub.replace('__VERSION__','0.160.1')})) {
    writeFileSync(join(bin,name),content,{mode:0o755});
  }
  const env = {...process.env, PATH:bin+':'+dirname(process.execPath)+':'+process.env.PATH,
    XDG_STATE_HOME:join(root,'state'), CODEX_HOME:join(root,'codex'), TEST_CLI:join(root,'cli.cjs'), TEST_SCHEMAS:join(root,'schemas.json'),
    TEST_CALLS:join(root,'calls.jsonl'), TEST_REPO:repo, TEST_PR:join(root,'pr.json')};
  const run = (args, extra={}) => new Promise((ok, fail) => {
    const child=spawn(process.execPath,[entry,...args],{cwd:repo,env:{...env,...extra},stdio:['ignore','pipe','pipe']});
    let output=''; child.stdout.on('data',c=>output+=c); child.stderr.on('data',c=>output+=c);
    child.on('error',fail); child.on('close',code=>ok({code,output}));
  });
  const calls = () => readFileSync(env.TEST_CALLS,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const states = () => { const base=join(root,'state/palmagent/codex-compatibility'); return readdirSync(base).flatMap(key=>readdirSync(join(base,key)).filter(n=>n.endsWith('.json')).map(n=>JSON.parse(readFileSync(join(base,key,n),'utf8')))); };
  return {root,repo,env,run,calls,states,git};
}
const paid = calls => calls.filter(call=>call[0]==='codex' && call[2][0]==='exec' && !call[2].includes('--help'));

test('controller skips all CLI and agent work when no stable release is pending', async t=>{
  const f=fixture(t), result=await f.run(['--apply','--allow-codex-repair'],{TEST_NO_NEW:'1'});
  assert.equal(result.code,0,result.output); assert.match(result.output,/No new stable/);
  assert.equal(f.calls().filter(call=>call[0]==='codex').length,0);
});
test('check-only exercises the two native CLIs but never mutates support or opens a PR', async t=>{
  const f=fixture(t), head=f.git('rev-parse','HEAD'), result=await f.run(['--check-only']);
  assert.equal(result.code,0,result.output); assert.match(result.output,/schema-contract/);
  assert.equal(paid(f.calls()).length,0); assert.equal(f.git('rev-parse','HEAD'),head);
  assert.equal(f.git('status','--porcelain'),''); assert.equal(f.states().length,0);
  assert.equal(f.calls().filter(call=>call[0]==='gh' && call[1].includes('POST')).length,0);
});
test('successful scheduled promotion creates one verified PR without model calls and resumes idempotently', async t=>{
  const f=fixture(t), result=await f.run(['--apply','--allow-codex-repair']);
  assert.equal(result.code,0,result.output); assert.equal(paid(f.calls()).length,0);
  assert.equal(f.states()[0].stage,'merged');
  assert.equal(JSON.parse(readFileSync(join(f.states()[0].worktree,'packages/shared/src/agent-compatibility.json'),'utf8')).codex.exclusiveMaximum,'0.160.2');
  assert.equal((await f.run(['--apply','--allow-codex-repair'])).code,0);
  assert.equal(f.calls().filter(call=>call[0]==='gh' && call[1].includes('POST')).length,1);
});
test('a real schema mismatch starts one mocked repair; a failed process is never retried on the next schedule', async t=>{
  const f=fixture(t), orphan=join(f.root,'orphan'), result=await f.run(['--apply','--allow-codex-repair'],{TEST_FAIL:'1',TEST_BACKGROUND:orphan});
  assert.equal(result.code,1,result.output); assert.equal(paid(f.calls()).length,1);
  assert.equal(f.states()[0].repairAttempts,1);
  assert.equal((await f.run(['--apply','--allow-codex-repair'],{TEST_FAIL:'1'})).code,1);
  assert.equal(paid(f.calls()).length,1);
  assert.equal(f.calls().filter(call=>call[0]==='gh' && call[1].includes('POST')).length,0);
  await new Promise(ok=>setTimeout(ok,1200));
  assert.ok(!readdirSync(f.root).includes('orphan'), 'Repair descendants must not outlive the bounded command');
});
test('CI failure retains the same PR and a later successful run resumes without model calls', async t=>{
  const f=fixture(t), first=await f.run(['--apply','--allow-codex-repair'],{TEST_CI_FAIL:'1'});
  assert.equal(first.code,1,first.output); assert.equal(f.states()[0].stage,'pr');
  assert.equal(f.calls().filter(call=>call[0]==='gh' && call[1][1]==='merge').length,0);
  const second=await f.run(['--apply','--allow-codex-repair']);
  assert.equal(second.code,0,second.output); assert.equal(f.states()[0].stage,'merged');
  assert.equal(f.calls().filter(call=>call[0]==='gh' && call[1].includes('POST')).length,1);
  assert.equal(paid(f.calls()).length,0);
});
test('a failed schema recheck after rebase cannot be skipped by the next schedule', async t=>{
  const f=fixture(t), first=await f.run(['--apply','--allow-codex-repair'],{TEST_CI_FAIL:'1'});
  assert.equal(first.code,1,first.output);
  writeFileSync(join(f.repo,'docs/unrelated.md'),'A concurrent source change.\n');
  f.git('add','docs/unrelated.md'); f.git('commit','-m','concurrent change'); f.git('push','origin','develop');
  for (let attempt=0; attempt<2; attempt++) {
    const result=await f.run(['--apply','--allow-codex-repair'],{TEST_FAIL:'1'});
    assert.equal(result.code,1,result.output);
    assert.equal(f.states()[0].needsCompatibilityCheck,true);
    assert.equal(f.calls().filter(call=>call[0]==='gh' && call[1][1]==='merge').length,0);
    assert.equal(paid(f.calls()).length,0);
  }
  const recovered=await f.run(['--apply','--allow-codex-repair']);
  assert.equal(recovered.code,0,recovered.output);
  assert.equal(f.states()[0].stage,'merged');
  assert.equal(f.states()[0].needsCompatibilityCheck,false);
});
test('a failed local verification can rebase and create its first remote branch on retry', async t=>{
  const f=fixture(t), first=await f.run(['--apply','--allow-codex-repair'],{TEST_VERIFY_FAIL:'1'});
  assert.equal(first.code,1,first.output); assert.equal(f.states()[0].stage,'committed');
  const ref='refs/heads/'+f.states()[0].branch;
  assert.equal(f.git('ls-remote','origin',ref),'');
  writeFileSync(join(f.repo,'docs/unrelated.md'),'A concurrent source change.\n');
  f.git('add','docs/unrelated.md'); f.git('commit','-m','concurrent change'); f.git('push','origin','develop');
  const recovered=await f.run(['--apply','--allow-codex-repair']);
  assert.equal(recovered.code,0,recovered.output); assert.equal(f.states()[0].stage,'merged');
  assert.equal(f.git('ls-remote','origin',ref).split(/\s+/)[0],f.states()[0].head);
  assert.equal(f.calls().filter(call=>call[0]==='gh' && call[1].includes('POST')).length,1);
  assert.equal(paid(f.calls()).length,0);
});
test('retry preserves an unexpected remote branch and does not create a PR', async t=>{
  const f=fixture(t), first=await f.run(['--apply','--allow-codex-repair'],{TEST_VERIFY_FAIL:'1'});
  assert.equal(first.code,1,first.output);
  const ref='refs/heads/'+f.states()[0].branch, unrelated=f.git('rev-parse','HEAD');
  f.git('push','origin','HEAD:'+ref);
  const retry=await f.run(['--apply','--allow-codex-repair']);
  assert.equal(retry.code,1,retry.output); assert.match(retry.output,/remote branch changed/);
  assert.equal(f.git('ls-remote','origin',ref).split(/\s+/)[0],unrelated);
  assert.equal(f.calls().filter(call=>call[0]==='gh' && call[1].includes('POST')).length,0);
  assert.equal(paid(f.calls()).length,0);
});
test('a successful repair rereads the updated consumed schema and runs exactly one live matrix', async t=>{
  const f=fixture(t), result=await f.run(['--apply','--allow-codex-repair'],{TEST_RENAME:'1',TEST_REPAIR_OK:'1'});
  assert.equal(result.code,0,result.output);
  assert.equal(paid(f.calls()).length,1);
  assert.equal(f.calls().filter(call=>call[0]==='pnpm' && call[1].includes('server:contracts:live')).length,1);
  assert.equal(f.states()[0].stage,'merged'); assert.equal(f.states()[0].mode,'repaired-live');
  const receipts=JSON.parse(readFileSync(join(f.states()[0].worktree,'docs/codex-compatibility-runs.json'),'utf8'));
  assert.match(receipts[0].candidateSchemaSha256,/^[a-f0-9]{64}$/);
});
