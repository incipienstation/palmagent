import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const binary = process.env.PALMAGENT_CODEX_BINARY;
const script = fileURLToPath(new URL('../codex-context-continuity.mjs', import.meta.url));
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

// Explicit opt-in: exercises the installed native runtime with an isolated home
// and a loopback model fixture. No credentials, API calls or live sessions.
for (const mode of ['before', 'automatic', 'fallback', 'repeated-loss', 'failure']) {
  const restoreBeforeModel = !['fallback', 'repeated-loss'].includes(mode);
  test(`native Codex context recovery: ${mode}`, {
    skip: !binary && 'Set PALMAGENT_CODEX_BINARY to test an installed Codex runtime.', timeout: 45_000,
  }, async t => {
    const home = await mkdtemp(join(tmpdir(), 'palmagent-continuity-native-'));
    let proc, reader, exited, server;
    t.after(async () => {
      reader?.close();
      if (proc && proc.exitCode === null && proc.signalCode === null) {
        const force = setTimeout(() => proc.kill('SIGKILL'), 1000);
        proc.kill('SIGTERM');
        try { await exited; } finally { clearTimeout(force); }
      }
      if (server) {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
      await rm(home, { recursive: true, force: true });
    });
    const requests = [], notifications = [];
    server = createServer(async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk;
      if (req.url !== '/v1/responses') { res.writeHead(404); res.end(); return; }
      requests.push(JSON.parse(body));
      const number = requests.length;
      const reset = number === 1 || mode === 'repeated-loss' && number === 3;
      const item = reset
        ? { type: 'function_call', id: `fc-reset-${number}`, call_id: `call-reset-${number}`,
          name: mode === 'automatic' ? 'exec_command' : 'new_context',
          arguments: mode === 'automatic' ? JSON.stringify({ cmd: 'pwd' }) : '{}' }
        : { type: 'message', id: `answer-${number}`, role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Fixture response.' }] };
      const events = [
        { type: 'response.created', response: { id: `response-${number}`, status: 'in_progress' } },
        { type: 'response.output_item.added', output_index: 0, item: { ...item, ...(reset ? { arguments: '' } : {}) } },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { id: `response-${number}`, status: 'completed', output: [item],
          usage: { input_tokens: mode === 'automatic' && number === 1 ? 25_000 : 100,
            output_tokens: 20, total_tokens: mode === 'automatic' && number === 1 ? 25_020 : 120,
            input_tokens_details: { cached_tokens: 0 } } } },
      ];
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
    server.listen(0, 'localhost'); await once(server, 'listening');
    await writeFile(join(home, 'config.toml'), `model = "gpt-6.1-sol"
model_provider = "fixture"
approval_policy = "never"
model_context_window = 20000
model_auto_compact_token_limit = 10000
[features]
token_budget = true
hooks = true
[model_providers.fixture]
name = "Local fixture"
base_url = "http://localhost:${server.address().port}/v1"
wire_api = "responses"
requires_openai_auth = false
`);
    const hook = { type: 'command', command: `${quote(process.execPath)} ${quote(script)}`, timeout: 10 };
    if (mode === 'failure') {
      const failureScript = join(home, 'stopped-hook.mjs');
      await writeFile(failureScript, 'process.stdout.write(JSON.stringify({continue:false,stopReason:"Recovery unavailable",systemMessage:"Recovery unavailable"}));');
      hook.command = `${quote(process.execPath)} ${quote(failureScript)}`;
    }
    await writeFile(join(home, 'hooks.json'), JSON.stringify({ hooks: {
      ...(restoreBeforeModel ? { SessionStart: [{ matcher: '^compact$', hooks: [{ ...hook, additionalContextLimit: 0 }] }] } : {}),
      Stop: [{ hooks: [hook] }],
    } }));
    proc = spawn(binary, ['app-server', '--listen', 'stdio://'], {
      cwd: home, env: { ...process.env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    reader = createInterface({ input: proc.stdout });
    exited = once(proc, 'exit');
    let stderr = '', id = 0;
    proc.stderr.on('data', chunk => stderr += chunk);
    const pending = new Map();
    let complete, fail;
    const completion = new Promise((resolve, reject) => { complete = resolve; fail = reject; });
    // Attach a handler while initialization is still in flight.
    completion.catch(() => {});
    proc.on('error', error => { fail(error); for (const entry of pending.values()) entry.reject(error); });
    proc.on('exit', () => {
      const error = new Error(`Codex exited before completion: ${stderr.slice(-2000)}`);
      fail(error); for (const entry of pending.values()) entry.reject(error);
    });
    reader.on('line', line => {
      const row = JSON.parse(line);
      const entry = pending.get(row.id);
      if (entry) {
        pending.delete(row.id);
        row.error ? entry.reject(new Error(JSON.stringify(row.error))) : entry.resolve(row.result);
      } else {
        notifications.push(row);
        if (row.method === 'turn/completed') complete(row.params.turn);
      }
    });
    const rpc = (method, params) => new Promise((resolve, reject) => {
      const requestId = ++id; pending.set(requestId, { resolve, reject });
      proc.stdin.write(`${JSON.stringify({ id: requestId, method, params })}\n`);
    });
    // Use the same non-experimental handshake as ordinary Palmagent execution.
    await rpc('initialize', { clientInfo: { name: 'palmagent-continuity-test', version: '1' }, capabilities: {} });
    proc.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
    const listed = await rpc('hooks/list', { cwds: [home] });
    const hooks = listed.data.flatMap(entry => entry.hooks);
    assert.equal(hooks.length, restoreBeforeModel ? 2 : 1);
    assert.deepEqual(listed.data.flatMap(entry => entry.errors), []);
    // Trust only the test-owned hooks in this disposable configuration.
    await rpc('config/batchWrite', { reloadUserConfig: true, edits: hooks.map(hook => ({
      keyPath: `hooks.state.${JSON.stringify(hook.key)}.trusted_hash`, value: hook.currentHash, mergeStrategy: 'replace',
    })) });
    const started = await rpc('thread/start', { cwd: home, model: 'gpt-6.1-sol', modelProvider: 'fixture',
      approvalPolicy: 'never', sandbox: 'read-only', baseInstructions: 'Follow the user request.' });
    await rpc('turn/start', { threadId: started.thread.id, input: [{ type: 'text', text: 'ORIGINAL_REQUEST_42: finish the requested check.' }] });
    assert.equal((await completion).status, 'completed');
    if (mode === 'failure' || mode === 'repeated-loss') {
      assert.equal(requests.length, mode === 'failure' ? 1 : 4, 'a stopped recovery must prevent another model request');
      assert.ok(notifications.some(row => row.method === 'hook/completed' && row.params.run.status === 'stopped'),
        'the hook stop must be observed independently of normal provider completion');
      return;
    }
    assert.equal(requests.length, restoreBeforeModel ? 2 : 3, 'recovery must not create a loop');
    const recovered = JSON.stringify(requests.at(-1));
    assert.match(recovered, /ORIGINAL_REQUEST_42/);
    assert.match(recovered, /Palmagent context continuity/);
    if (!restoreBeforeModel) assert.doesNotMatch(JSON.stringify(requests[1]), /ORIGINAL_REQUEST_42/);
    assert.ok(notifications.some(row => row.method === 'hook/completed' && row.params.run.status === 'completed'));
  });
}
