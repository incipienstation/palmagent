import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { emptyReplacement, inspectContinuity, runHook } from '../codex-context-continuity.mjs';

const message = (role, text, phase = 'final_answer') => ({ type: 'response_item', payload: {
  type: 'message', role, phase, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }],
} });
const started = id => ({ type: 'event_msg', payload: { type: 'task_started', turn_id: id } });
const setup = { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for /workspace\n<INSTRUCTIONS>Read current guidance.</INSTRUCTIONS>\n<environment_context>workspace</environment_context>' }] };
const compacted = () => ({ type: 'compacted', payload: { message: '', replacement_history: [
  { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Developer guidance' }] }, setup,
] } });

async function fixture(t, extra = []) {
  const home = await mkdtemp(join(tmpdir(), 'context-continuity-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const transcript = join(home, 'session.jsonl');
  const rows = [
    { type: 'session_meta', payload: { id: 'session-12345678', cwd: home } },
    started('previous-turn'), message('user', 'Prepare the website and wait for DNS before enabling HTTPS.'),
    message('assistant', 'The site is ready. DNS is the remaining prerequisite.'),
    started('active-turn'), message('user', 'Connected.'),
    message('assistant', 'I will check DNS and continue with HTTPS.', 'commentary'),
    ...extra, compacted(),
    message('assistant', 'I have read the repository instructions.'),
  ];
  const save = () => writeFile(transcript, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  await save();
  const input = { hook_event_name: 'Stop', session_id: 'session-12345678', turn_id: 'active-turn', cwd: home, transcript_path: transcript, stop_hook_active: false };
  return { home, rows, save, input, directory: join(home, 'palmagent-continuity', input.session_id) };
}

test('restores a short follow-up with its preceding task and action evidence, once across restarts', async t => {
  const f = await fixture(t, [
    { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'action', arguments: '{"cmd":"check-site"}' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'action', output: 'Already built successfully' } },
    message('assistant', 'PRIVATE_REASONING', 'analysis'),
    { type: 'response_item', payload: { type: 'function_call', namespace: 'internal', name: 'private_operation', call_id: 'private', arguments: 'PRIVATE_INPUT' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'private', output: 'PRIVATE_OUTPUT' } },
  ]);
  const result = await runHook(f.input, f.home);
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /Connected\./);
  assert.match(result.reason, /wait for DNS/);
  assert.match(result.reason, /before repeating/);
  const files = await readdir(f.directory);
  const ledger = join(f.directory, files.find(name => name.endsWith('.jsonl')));
  const content = await readFile(ledger, 'utf8');
  assert.match(content, /Already built successfully/);
  assert.doesNotMatch(content, /PRIVATE_|Developer guidance|AGENTS/);
  assert.equal((await stat(ledger)).mode & 0o777, 0o600);
  assert.equal((await stat(f.directory)).mode & 0o777, 0o700);
  assert.equal((await runHook(f.input, f.home)).continue, false, 'an unconfirmed receipt is not silently retried');
  assert.deepEqual(await runHook({ ...f.input, stop_hook_active: true }, f.home), {});
});

test('SessionStart compact restores before generation and suppresses the Stop fallback', async t => {
  const f = await fixture(t);
  const result = await runHook({ ...f.input, hook_event_name: 'SessionStart', source: 'compact' }, f.home);
  assert.equal(result.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(result.hookSpecificOutput.additionalContext, /Connected\./);
  assert.equal(result.decision, undefined);
  f.rows.push(message('developer', result.hookSpecificOutput.additionalContext)); await f.save();
  assert.deepEqual(await runHook(f.input, f.home), {});
});

test('a missing SessionStart delivery remains eligible for bounded Stop recovery', async t => {
  const f = await fixture(t);
  await runHook({ ...f.input, hook_event_name: 'SessionStart', source: 'compact' }, f.home);
  assert.equal((await runHook(f.input, f.home)).decision, 'block');
});

test('normal compaction summaries, retained requests and unknown formats are left alone', () => {
  const base = compacted().payload;
  assert.equal(emptyReplacement(base), true);
  for (const payload of [undefined, {}, { ...base, message: 'Continue the HTTPS task' },
    { ...base, replacement_history: [...base.replacement_history, message('user', 'Connected.').payload] },
    { ...base, replacement_history: [...base.replacement_history, message('assistant', 'Summary').payload] },
    { ...base, replacement_history: [{ type: 'compaction', encrypted_content: 'summary' }] },
    { ...base, replacement_history: [null] },
    { ...base, replacement_history: [{ type: 'message', role: 'user' }] },
    { ...base, replacement_history: [{ type: 'message', role: 'user', content: [null] }] },
    { ...base, replacement_history: [{ ...setup, content: [...setup.content, { type: 'input_text', text: 'New real request' }] }] },
    { ...base, replacement_history: [] },
  ]) assert.equal(emptyReplacement(payload), false);
});

for (const [name, row] of [
  ['new user correction', message('user', 'Stop. Do not deploy.')],
  ['new turn', started('later-turn')],
  ['interruption', { type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'active-turn' } }],
  ['later successful compaction', { type: 'compacted', payload: { message: 'Task summary', replacement_history: [] } }],
]) test(`${name} supersedes a lost-context recovery`, async t => {
  const f = await fixture(t); f.rows.push(row); await f.save();
  assert.deepEqual(await runHook(f.input, f.home), {});
});

test('no request is fabricated for setup-only, startup, another turn or an unknown event', async t => {
  const f = await fixture(t);
  assert.deepEqual(await runHook({ ...f.input, turn_id: 'different-turn' }, f.home), {});
  assert.deepEqual(await runHook({ ...f.input, hook_event_name: 'SessionStart', source: 'resume' }, f.home), {});
  assert.deepEqual(await runHook({ ...f.input, hook_event_name: 'Interrupt' }, f.home), {});
  assert.deepEqual(await runHook({ ...f.input, transcript_path: null }, f.home), {});
  f.rows.splice(1, f.rows.length, started('active-turn'), { type: 'response_item', payload: setup }, compacted());
  await f.save();
  assert.equal(await inspectContinuity(f.input), undefined);
});

test('a changed working directory does not discard a verified session request', async t => {
  const f = await fixture(t);
  f.rows[0].payload.cwd = join(f.home, 'retired-worktree'); await f.save();
  assert.equal((await runHook(f.input, f.home)).decision, 'block');
});

test('full requests remain in the ledger when the context preview is bounded', async t => {
  const f = await fixture(t);
  f.rows[5] = message('user', 'Large request ' + 'x'.repeat(50_000) + ' REQUIRED_END'); await f.save();
  const result = await runHook(f.input, f.home);
  assert.ok(result.reason.length < 30_000);
  const ledger = (await readdir(f.directory)).find(name => name.endsWith('.jsonl'));
  assert.match(await readFile(join(f.directory, ledger), 'utf8'), /REQUIRED_END/);
  assert.match(result.reason, /"truncated":true/);
  assert.match(result.reason, /Read every truncated user record in full/);
});

test('attachment-only user requests are not replaced by an earlier text request', async t => {
  const f = await fixture(t);
  f.rows[5] = { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,PRIVATE_ATTACHMENT' }] } };
  await f.save();
  const loss = await inspectContinuity(f.input);
  assert.equal(loss.latestUser.attachments, 1);
  const result = await runHook(f.input, f.home);
  assert.match(result.reason, /"attachments":1/);
  assert.match(result.reason, /recover any required attachment/);
  assert.doesNotMatch(await readFile(join(f.directory, 'conversation.jsonl'), 'utf8'), /PRIVATE_ATTACHMENT/);
});

test('concurrent Stop calls make at most one continuation claim', async t => {
  const f = await fixture(t);
  const results = await Promise.all([runHook(f.input, f.home), runHook(f.input, f.home)]);
  assert.equal(results.filter(result => result.decision === 'block').length, 1);
});

test('mismatched identity and malformed transcripts produce an explicit hook failure', async t => {
  const f = await fixture(t);
  await assert.rejects(inspectContinuity({ ...f.input, session_id: 'wrong-session' }), /identity/);
  await writeFile(f.input.transcript_path, 'malformed\n');
  const result = spawnSync(process.execPath, ['scripts/codex-context-continuity.mjs'], {
    input: JSON.stringify(f.input), encoding: 'utf8', env: { ...process.env, CODEX_HOME: f.home },
  });
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.continue, false);
  assert.match(output.systemMessage, /could not be verified/);
  assert.equal(output.decision, undefined);
});
