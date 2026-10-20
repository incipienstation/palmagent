// Optional real-Codex transport smoke. Uses an isolated provider home and a local
// Responses fixture; no account credentials, network model requests, or quota.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { LocalNativeSessionAdapter } from '../src/modules/tasks/adapters/outbound/native-session-adapter.ts';
import { checkpointSession, synchronizeSession } from '../src/modules/tasks/adapters/outbound/native-session.ts';
import { processIdentity } from '../src/platform/process/identity.ts';
import { CodexSharedSessions } from '../src/modules/agents/adapters/outbound/codex-shared-session.ts';

const home = mkdtempSync(join(tmpdir(), 'palmagent-native-smoke-'));
const socket = join(home, 'native.sock');
let requests = 0;
const modelRequests = [];
let holdNext = false, releaseResponse;
const model = createServer((request, response) => {
  let body = "";
  request.on("data", chunk => { body += chunk; });
  request.on('end', async () => {
    requests++;
    modelRequests.push(JSON.parse(body));
    const id = `response_${requests}`, messageId = `message_${requests}`, text = `Fixture reply ${requests}`;
    const item = { id: messageId, type: 'message', role: 'assistant', status: 'completed', phase: 'final_answer',
      content: [{ type: 'output_text', text, annotations: [] }] };
    const position = { item_id: messageId, output_index: 0, content_index: 0 };
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const event = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    event('response.created', { response: { id, object: 'response', status: 'in_progress', output: [] } });
    event('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
    event('response.content_part.added', { ...position, part: { type: 'output_text', text: '', annotations: [] } });
    event('response.output_text.delta', { ...position, delta: text });
    if (holdNext) { holdNext = false; await new Promise(resolve => { releaseResponse = resolve; }); }
    event('response.output_text.done', { ...position, text });
    event('response.content_part.done', { ...position, part: item.content[0] });
    event('response.output_item.done', { output_index: 0, item });
    event('response.completed', { response: { id, object: 'response', status: 'completed', output: [item], usage: {
      input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 },
    } } });
    response.end();
  });
});
model.listen(0, 'localhost');
await once(model, 'listening');
const port = model.address().port;
writeFileSync(join(home, 'config.toml'), `model = "fixture"
model_provider = "fixture"
model_reasoning_effort = "medium"
[model_providers.fixture]
name = "Local fixture"
base_url = "http://localhost:${port}/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
`);
const startNative = () => spawn('codex', ['app-server', '--listen', `unix://${socket}`], {
  cwd: home, env: { PATH: process.env.PATH, CODEX_HOME: home, TERM: 'dumb' }, stdio: ['ignore', 'ignore', 'pipe'],
});
let native = startNative();
let stderr = '', local, shared;
native.stderr.on('data', bytes => { stderr += bytes; });
native.on('error', error => { stderr += error.message; });
const received = [];
async function wait(check, label) {
  for (let index = 0; index < 500; index++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}: ${stderr.slice(-1500)}`);
}
try {
  await wait(() => existsSync(socket), 'the native socket');
  const discovered = new LocalNativeSessionAdapter(join(home, 'fixture.db')).sharedSocket({
    agent: 'codex', sessionControl: { waitPid: native.pid, waitIdentity: processIdentity(native.pid) },
  });
  assert.equal(discovered, realpathSync(socket), 'dispatch must identify the original process socket');
  local = new WebSocket(`ws+unix://${socket}:/`);
  await once(local, 'open');
  let nextId = 0;
  const pending = new Map();
  local.on('message', bytes => {
    const row = JSON.parse(String(bytes));
    received.push(row);
    if (pending.has(row.id)) { pending.get(row.id)(row); pending.delete(row.id); }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => reject(new Error(`RPC timed out: ${method}`)), 8000);
    pending.set(id, row => { clearTimeout(timer); row.error ? reject(new Error(row.error.message)) : resolve(row.result); });
    local.send(JSON.stringify({ id, method, params }));
  });
  await rpc('initialize', { clientInfo: { name: 'palmagent_fixture_terminal', version: '1' }, capabilities: { experimentalApi: true } });
  local.send(JSON.stringify({ method: 'initialized' }));
  const { thread } = await rpc('thread/start', { cwd: home, model: 'fixture', modelProvider: 'fixture', approvalPolicy: 'never', sandbox: 'read-only', historyMode: 'paginated' });
  const completed = () => received.filter(row => row.method === 'turn/completed');
  const localTurn = text => rpc('turn/start', { threadId: thread.id, input: [{ type: 'text', text, text_elements: [] }] });
  await localTurn('First local turn');
  await wait(() => completed().length === 1, 'the first local turn');
  assert.equal(completed()[0].params.turn.status, 'completed');
  const preview = { taskId: 'existing-preview', agent: 'codex', sessionId: thread.id, worktreePath: home, sessionControl: { home } };
  preview.sessionControl = checkpointSession(preview);
  shared = await new CodexSharedSessions(socket).connect({ taskId: 'fixture-task', agent: 'codex', sessionId: thread.id, cwd: home, home }, () => {});
  assert.ok(shared);
  assert.equal((await shared.snapshot()).historyMode, 'paginated');
  assert.ok((await shared.history()).some(row => row.event.kind === 'assistant_text' && row.event.payload.text === 'Fixture reply 1'));
  assert.equal(await shared.send('Second turn from browser', undefined, 'browser-message', undefined, { model: 'gpt-5.5', effort: 'high' }), 'delivered');
  await wait(() => completed().length === 2, 'the browser turn');
  assert.ok(completed().every(row => row.params.threadId === thread.id && row.params.turn.status === 'completed'));
  assert.equal(requests, 2);
  assert.equal(modelRequests[1].model, 'gpt-5.5');
  assert.equal(modelRequests[1].reasoning?.effort, 'high');
  const settings = await shared.snapshot();
  assert.equal(settings.model, 'gpt-5.5');
  assert.equal(settings.effort, 'high');
  assert.ok((await shared.history()).some(row => row.event.kind === 'assistant_text' && row.event.payload.text === 'Fixture reply 2'));
  // Keep a real native turn active while the second client steers it.
  holdNext = true;
  const active = await localTurn('Keep working while the browser sends guidance');
  await wait(() => !!releaseResponse, 'the active model stream');
  assert.equal(await shared.send('Guidance sent now from the browser', undefined, 'browser-steer'), 'delivered');
  await wait(() => received.some(row => row.method === 'item/agentMessage/delta' && row.params.turnId === active.turn.id), 'live text');
  assert.ok((await shared.history()).some(row => row.event.kind === 'assistant_text' && row.event.payload.text.includes('Fixture reply 3')));
  assert.equal(completed().length, 2, 'Send now must not wait for the current turn to finish');
  releaseResponse(); releaseResponse = undefined;
  await wait(() => completed().length === 3, 'the steered turn');
  assert.equal(completed()[2].params.turn.id, active.turn.id);
  assert.equal(received.filter(row => row.method === 'turn/started').length, 3, 'steering must not create a second turn');
  shared.close(); shared = undefined;
  assert.equal(native.exitCode, null);
  await localTurn('Third local turn after browser disconnect');
  await wait(() => completed().length === 4, 'the next local turn');
  assert.ok(requests >= 4);
  assert.equal(modelRequests.at(-1).model, 'gpt-5.5', 'native client inherits the selected model');
  assert.equal(modelRequests.at(-1).reasoning?.effort, 'high', 'native client inherits the selected effort');
  shared = await new CodexSharedSessions(socket).connect({ taskId: 'fixture-task', agent: 'codex', sessionId: thread.id, cwd: home, home }, () => {});
  assert.equal(await shared.send('Restore native defaults', undefined, 'browser-defaults', undefined, { model: '', effort: '' }), 'delivered');
  await wait(() => completed().length === 5, 'the default settings turn');
  const defaults = await shared.snapshot();
  assert.equal(defaults.model, 'fixture');
  assert.equal(defaults.effort, 'medium');
  assert.equal(modelRequests.at(-1).model, 'fixture');
  shared.close(); shared = undefined;
  const imported = synchronizeSession(preview, { preview: true });
  assert.ok(imported.events.some(event => event.kind === 'status' && event.payload.text === 'Second turn from browser'), 'paginated native history must still extend the existing preview transcript');
  assert.ok(imported.control.cursor > preview.sessionControl.cursor);
  preview.sessionControl = imported.control;
  // A restarted original server has no loaded thread; reconnect the saved
  // dispatched session through its verified socket without a new thread id.
  local.terminate(); local = undefined;
  const originalStopped = once(native, 'close'); native.kill(); await originalStopped;
  rmSync(socket, { force: true });
  native = startNative();
  native.stderr.on('data', bytes => { stderr += bytes; });
  native.on('error', error => { stderr += error.message; });
  await wait(() => existsSync(socket), 'the restarted native socket');
  shared = await new CodexSharedSessions().connect({ taskId: 'fixture-task', agent: 'codex', sessionId: thread.id, cwd: home, home, socket }, () => {});
  assert.equal((await shared.snapshot()).status, 'idle');
  assert.ok((await shared.history()).some(row => row.event.kind === 'assistant_text' && row.event.payload.text.includes('Fixture reply')));
  assert.equal(native.exitCode, null);
  synchronizeSession(preview, { preview: true }); // restarting the server preserves the checked prefix
  console.log('PASS: terminal and browser share one native thread; model/effort overrides and native defaults work; live Send now and terminal continuation remain intact.');
} finally {
  releaseResponse?.(); shared?.close(); local?.terminate();
  const stopped = native.exitCode === null && native.signalCode === null ? once(native, 'close') : Promise.resolve();
  native.kill(); model.closeAllConnections(); model.close();
  await stopped;
  rmSync(home, { recursive: true, force: true });
}
