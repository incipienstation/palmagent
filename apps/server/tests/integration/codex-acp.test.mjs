import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { CodexAcpQuestions } from "../../src/modules/agents/adapters/outbound/codex-acp-questions.ts";
import { readSessionTitles } from "../../src/modules/tasks/adapters/outbound/session-titles.ts";
import { InProcessBackend } from "../../src/modules/agents/adapters/outbound/inproc-backend.ts";

test("Codex ACP keeps native sandbox, skills, steering receipts and thread identity", {
  timeout: 60_000, skip: process.platform === "win32",
}, async t => {
  const root = mkdtempSync(join(tmpdir(), "palmagent-acp-"));
  const repo = join(root, "repo"), bin = join(root, "bin"), home = join(root, "profile");
  for (const dir of [repo, bin, home]) mkdirSync(dir);
  const log = join(root, "turns.jsonl");
  const bridge = createRequire(import.meta.url).resolve("@agentclientprotocol/codex-acp");
  const cli = createRequire(bridge).resolve("@openai/codex/bin/codex.js");
  symlinkSync(bridge, join(bin, "codex-acp"));
  // Observe the actual provider boundary. The real CLI still owns its responses and transcript.
  writeFileSync(join(bin, "codex"), `#!${process.execPath}
const child = require("node:child_process").spawn(process.execPath, [${JSON.stringify(cli)}, ...process.argv.slice(2)], {stdio:["pipe","inherit","inherit"]});
const lines = require("node:readline").createInterface({input: process.stdin});
lines.on("line", line => {
  const {method, params} = JSON.parse(line);
  if (method === "turn/start" || method === "turn/steer") require("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify({method, params})+"\\n");
  child.stdin.write(line+"\\n");
});
lines.on("close", () => child.stdin.end());
child.on("exit", code => process.exit(code ?? 1));
`, { mode: 0o700 });

  const receiving = Promise.withResolvers(), release = Promise.withResolvers();
  const model = createServer(async (request, response) => {
    if (!request.url?.endsWith("/responses")) { response.writeHead(404).end(); return; }
    let body = "";
    for await (const chunk of request) body += chunk;
    const titleRequest = JSON.parse(body).text?.format?.schema?.properties?.title;
    const reply = titleRequest ? JSON.stringify({ title: "Provider session title" }) : "fixture reply";
    receiving.resolve();
    await release.promise;
    const id = randomUUID();
    const item = { id, type: "message", role: "assistant", phase: "final_answer",
      content: [{ type: "output_text", text: reply, annotations: [] }] };
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const frame of [
      { type: "response.created", response: { id } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
      { type: "response.output_text.delta", output_index: 0, item_id: id, content_index: 0, delta: reply },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id, status: "completed", output: [item],
        usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 } } },
    ]) response.write("data: " + JSON.stringify(frame) + "\n\n");
    response.end();
  });
  await new Promise(resolve => model.listen(0, "localhost", resolve));
  const env = process.env;
  process.env = { HOME: root, PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(":"), LANG: "C.UTF-8" };
  const backend = new InProcessBackend();
  t.after(async () => {
    release.resolve();
    await backend.close();
    model.closeAllConnections();
    await new Promise(resolve => model.close(resolve));
    process.env = env;
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(join(home, "config.toml"), `model_provider = "fixture"
[model_providers.fixture]
name = "fixture"
base_url = "http://localhost:${model.address().port}/v1"
wire_api = "responses"
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
`);
  const skill = { name: "fixture", path: join(repo, "SKILL.md") };
  writeFileSync(skill.path, "---\nname: fixture\ndescription: Test input\n---\n");
  const args = { taskId: "probe", interactive: true, cwd: repo, providerHome: home, model: "fixture-model",
    effort: "low", prompt: "Reply briefly", messageId: randomUUID(), permission: "read-only" };
  const events = [];
  const runner = backend.agentRunner("codex");
  const handle = runner.start(args, event => events.push(event));
  await Promise.race([receiving.promise, handle.done.then(() => { throw new Error("Turn ended before the model request: " + JSON.stringify(events)); })]);
  const steerId = randomUUID();
  try { assert.equal(await handle.send("Also use this skill", [], steerId, [skill]), "delivered"); }
  finally { release.resolve(); }
  await handle.done;
  assert.equal(events.filter(e => e.payload?.messageId === steerId && e.payload.subtype === "message_delivered").length, 1);
  assert(events.some(e => e.kind === "assistant_text" && e.payload.text === "fixture reply"));
  assert(events.some(e => e.payload?.phase === "final"));
  assert(events.some(e => e.kind === "result" && !e.payload.is_error && e.payload.usage?.input_tokens === 12));
  const sessionId = events.find(e => e.payload?.subtype === "thread_started").sessionId;
  assert(events.some(e => e.payload?.providerTitle === "Provider session title" && e.sessionId === sessionId));
  assert.equal((await readSessionTitles("codex", home, [{ sessionId, cwd: repo }])).get(sessionId)?.title, "Provider session title");
  const next = [];
  await runner.start({ ...args, messageId: randomUUID(), permission: "workspace-write", resumeId: sessionId }, e => next.push(e)).done;
  assert(next.some(e => e.kind === "result" && !e.payload.is_error && e.sessionId === sessionId));
  const requests = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(requests.filter(r => r.method === "turn/start" && r.params.threadId === sessionId).map(({ params }) =>
    [params.threadId, params.approvalPolicy, params.sandboxPolicy.type, params.sandboxPolicy.networkAccess, params.model, params.effort]),
    [[sessionId, "never", "readOnly", false, args.model, "low"], [sessionId, "never", "workspaceWrite", false, args.model, "low"]]);
  assert.deepEqual(requests.find(r => r.method === "turn/steer").params.input.find(block => block.type === "skill"), { type: "skill", ...skill });
});

test("Codex ACP answers use provider field IDs and cancelled questions cannot accept input", async () => {
  const shown = [], dismissed = [];
  const questions = new CodexAcpQuestions(q => shown.push(q), id => dismissed.push(id));
  const field = { type: "string", title: "Continue?", oneOf: [{ const: "Yes" }], _meta: { codex: { isSecret: false } } };
  const note = { type: "string", title: "Note", _meta: { codex: { isSecret: false, questionId: "first", role: "user_note" } } };
  const form = { requestedSchema: { properties: { first: field, note, second: field } } };
  const controller = new AbortController();
  const response = questions.request("ask", form, controller.signal);
  assert.deepEqual(shown[0].questions.map(q => q.id), ["first", "second"]);
  assert.equal(questions.answer({ requestId: "ask", answers: [{ question: "Continue?", selected: ["Yes"] }] }), false);
  const answer = { requestId: "ask", answers: [{ questionId: "first", selected: ["Yes"], notes: "With tests" }] };
  assert.equal(questions.answer(answer), true);
  const accepted = await response;
  assert.equal(accepted.action, "accept");
  assert.deepEqual({ ...accepted.content }, { first: "Yes", note: "With tests" });
  const cancelled = questions.request("expired", form, controller.signal);
  controller.abort();
  assert.deepEqual(await cancelled, { action: "cancel" });
  assert.deepEqual(dismissed, ["expired"]);
  assert.equal(questions.answer({ ...answer, requestId: "expired" }), false);
});
