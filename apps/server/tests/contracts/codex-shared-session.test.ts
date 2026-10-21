import assert from "node:assert/strict";
import { readFileSync, statSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { sharedCodexServer as fixture } from "../support/codex-shared-server.js";
import { createInputFiles } from "../../src/modules/agents/adapters/outbound/input-files.js";

const tick = () => new Promise(resolve => setTimeout(resolve, 20));

for (const [initial, normalized] of [["commentary", "progress"], ["partial_answer", "partial"], ["final_answer", "final"], [null, undefined], ["future_phase", undefined]] as const) {
  test(`the first text delta retains start phase ${initial ?? "unknown"}`, async t => {
    const f = await fixture(t);
    const connection = await f.connector.connect(f.target, () => {});
    assert.ok(connection); t.after(() => connection.close());
    await connection.history();
    f.notify("item/started", { turnId: "turn-1", item: { id: "stream", type: "agentMessage", text: "", phase: initial } });
    f.notify("item/agentMessage/delta", { turnId: "turn-1", itemId: "stream", delta: "First" });
    await tick();
    const [first] = await connection.history();
    assert.equal(first.event.kind, "assistant_text");
    assert.deepEqual(first.event.payload, { text: "First", messageId: "stream", ...(normalized ? { phase: normalized } : {}) });
    f.notify("item/agentMessage/delta", { turnId: "turn-1", itemId: "stream", delta: " second" });
    f.notify("item/completed", { turnId: "turn-1", item: { id: "stream", type: "agentMessage", text: "First second", phase: "commentary" } });
    await tick();
    const completed = await connection.history();
    assert.deepEqual(completed.filter(row => row.event.kind === "assistant_text").map(row => row.event.payload), [
      { text: "First second", messageId: "stream", ...(normalized ? { phase: normalized } : {}) },
      { text: "First second", messageId: "stream", ...(normalized ? { phase: normalized } : {}) },
    ]);
    assert.equal((completed.at(-1)!.event.payload as { phase: string }).phase, "progress", "completion metadata is still retained");
  });
}

test("a second client rejoins the loaded session and routes input, approvals, questions and interrupts", async t => {
  const f = await fixture(t);
  const connection = await f.connector.connect(f.target, () => {});
  assert.ok(connection); t.after(() => connection.close());
  assert.ok(!f.requests.some(r => r.method === "thread/start"));
  assert.deepEqual(f.requests.find(r => r.method === "thread/resume")?.params, { threadId: "session-1", excludeTurns: true });
  await connection.history();
  assert.equal((await connection.snapshot()).turnId, "turn-1");
  assert.equal(await connection.send("From phone", undefined, "client-message"), "delivered");
  assert.equal(f.requests.find(r => r.method === "turn/steer")?.params.clientUserMessageId, "client-message");
  f.notify("item/commandExecution/requestApproval", { command: "fixture", reason: "Review command" }, 7);
  await tick(); assert.equal((await connection.snapshot()).approval?.requestId, "7");
  assert.equal(await connection.approve("7", "deny"), true);
  assert.equal((await connection.snapshot()).approval, undefined);
  f.notify("item/tool/requestUserInput", { questions: [{ id: "q1", question: "Choice", options: [] }] }, "question");
  await tick(); assert.equal((await connection.snapshot()).question?.requestId, '"question"');
  assert.equal(await connection.answer({ requestId: '"question"', answers: [{ questionId: "q1", question: "Choice", selected: ["yes"] }] }), true);
  assert.equal(await connection.interrupt(), true);
  assert.deepEqual(f.requests.find(r => r.method === "turn/interrupt")?.params, { threadId: "session-1", turnId: "turn-1" });
});

test("unloaded sessions are never resumed into a second writer", async t => {
  const f = await fixture(t, { loaded: false });
  await assert.rejects(f.connector.connect(f.target, () => {}), /not running on the Codex shared server/);
  assert.ok(!f.requests.some(r => r.method === "thread/resume" || r.method === "thread/start"));
});

test("history uses provider identities and lost send acknowledgements remain unknown", async t => {
  const f = await fixture(t, { paginated: true });
  f.thread.turns[0].status = "completed";
  f.thread.turns[0].items.push({ type: "agentMessage", id: "answer-1", text: "Complete answer", phase: "final_answer" });
  const connection = await f.connector.connect(f.target, () => {});
  assert.ok(connection); t.after(() => connection.close());
  const history = await connection.history();
  assert.deepEqual(history.map(row => row.key), ["item/turn-1/user-1", "item/turn-1/answer-1", "item/turn-1/answer-1/phase/final", "turn/turn-1/result"]);
  f.notify("item/completed", { turnId: "turn-1", item: f.thread.turns[0].items[1] });
  await tick(); assert.equal((await connection.history())[0].key, history[1].key);
  f.thread.status = { type: "idle" };
  f.loseSend();
  assert.equal(await connection.send("Ambiguous delivery", undefined, "once"), "unknown");
  assert.equal(f.requests.filter(row => row.method === "turn/start").length, 1);
});


test("local live text and tool starts are visible before completion without reloading all history", async t => {
  const f = await fixture(t);
  const connection = await f.connector.connect(f.target, () => {});
  assert.ok(connection); t.after(() => connection.close());
  await connection.history();
  const reads = f.requests.filter(r => r.method === "thread/read" && r.params.includeTurns).length;
  f.notify("item/started", { turnId: "turn-1", item: { id: "live", type: "agentMessage", text: "" } });
  f.notify("item/agentMessage/delta", { turnId: "turn-1", itemId: "live", delta: "First" });
  f.notify("item/agentMessage/delta", { turnId: "turn-1", itemId: "live", delta: " second" });
  f.notify("item/started", { turnId: "turn-1", item: { id: "tool", type: "commandExecution", command: "fixture" } });
  await tick();
  const events = await connection.history();
  assert.deepEqual(events.filter(row => row.event.kind === "assistant_text").map(row => row.event.payload), [
    { text: "First", messageId: "live" }, { text: "First second", messageId: "live" },
  ]);
  assert.equal(events.at(-1)?.event.kind, "tool_call");
  f.notify("turn/completed", { turn: { id: "turn-1", status: "completed", items: [] } });
  await tick(); await connection.history();
  assert.equal(f.requests.filter(r => r.method === "thread/read" && r.params.includeTurns).length, reads);
});


test("an idle unloaded thread can rejoin its verified original server", async t => {
  const f = await fixture(t, { loaded: false });
  const connection = await f.connector.connect({ ...f.target, socket: join(f.target.home, "verified-native.sock") }, () => {});
  assert.ok(connection); t.after(() => connection.close());
  assert.equal((await connection.snapshot()).status, "idle");
  assert.equal(f.requests.filter(row => row.method === "thread/resume").length, 1);
  assert.ok(!f.requests.some(row => row.method === "thread/start"));
});


test("a connection lost before submission rejects input without claiming uncertain delivery", async t => {
  const f = await fixture(t);
  const connection = await f.connector.connect(f.target, () => {});
  assert.ok(connection);
  connection.close();
  assert.equal(await connection.send("Still in my draft", undefined, "not-written"), "rejected");
  assert.ok(!f.requests.some(row => row.method === "turn/start" || row.method === "turn/steer"));
});


test("reconnecting during prose keeps the eventual text suffix in the same message", async t => {
  const f = await fixture(t);
  f.thread.turns[0].items.push({ type: "agentMessage", id: "partial", text: "Hello", phase: "final_answer" });
  const connection = await f.connector.connect(f.target, () => {});
  assert.ok(connection); t.after(() => connection.close());
  const initial = await connection.history();
  assert.deepEqual(initial.find(row => row.event.kind === "assistant_text")?.event.payload,
    { text: "Hello", messageId: "partial", phase: "final" });
  assert.ok(!initial.some(row => row.key.includes("/phase/")), "the completion marker waits for completed text");
  f.notify("item/completed", { turnId: "turn-1", item: { type: "agentMessage", id: "partial", text: "Hello world", phase: "final_answer" } });
  await tick();
  const completed = await connection.history();
  assert.equal(completed[0].key, "item/turn-1/partial");
  assert.equal(completed[1].key, "item/turn-1/partial/phase/final");
});


test("shared next turns pass model and effort without changing native permissions", async t => {
  const f = await fixture(t);
  f.thread.status = { type: "idle" };
  const connection = await f.connector.connect(f.target, () => {});
  assert.ok(connection); t.after(() => connection.close());
  assert.equal(await connection.send("Next turn", undefined, "settings", undefined, { model: "selected-model", effort: "high" }), "delivered");
  assert.deepEqual(f.requests.find(row => row.method === "turn/start")?.params, {
    threadId: "session-1", clientUserMessageId: "settings", input: [{ type: "text", text: "Next turn", text_elements: [] }], model: "selected-model", effort: "high",
  });
});

for (const configured of [true, false]) test(`shared Default selections resolve native ${configured ? "configuration" : "catalog"} values`, async t => {
  const f = await fixture(t);
  f.thread.status = { type: "idle" };
  if (!configured) { delete f.config.model; delete f.config.model_reasoning_effort; }
  const connection = await f.connector.connect(f.target, () => {});
  assert.ok(connection); t.after(() => connection.close());
  assert.equal(await connection.send("Defaults", undefined, "defaults", undefined, { model: "", effort: "" }), "delivered");
  const params = f.requests.find(row => row.method === "turn/start")!.params;
  assert.equal(params.model, configured ? "configured-model" : "catalog-model");
  assert.equal(params.effort, configured ? "medium" : "high");
  assert.deepEqual(f.requests.find(row => row.method === "config/read")?.params, { cwd: f.target.cwd, includeLayers: false });
});

test("default effort uses the selected model and unavailable defaults reject before delivery", async t => {
  const f = await fixture(t);
  f.thread.status = { type: "idle" }; delete f.config.model_reasoning_effort;
  const connection = await f.connector.connect(f.target, () => {});
  assert.ok(connection); t.after(() => connection.close());
  assert.equal(await connection.send("Default effort", undefined, "effort", undefined, { model: "selected-model", effort: "" }), "delivered");
  assert.equal(f.requests.find(row => row.method === "turn/start")!.params.effort, "low");
  assert.equal(await connection.send("Unknown default", undefined, "unknown-default", undefined, { model: "unknown-model", effort: "" }), "rejected");
  assert.equal(f.requests.filter(row => row.method === "turn/start").length, 1);
});

test("a native turn that wins the race cannot silently discard queued settings", async t => {
  const f = await fixture(t);
  const connection = await f.connector.connect(f.target, () => {});
  assert.ok(connection); t.after(() => connection.close());
  assert.equal(await connection.send("Queued turn", undefined, "race", undefined, { model: "selected-model", effort: "high" }), "rejected");
  assert.ok(!f.requests.some(row => row.method === "turn/start" || row.method === "turn/steer"));
  assert.equal(await connection.send("Guidance", undefined, "steer"), "delivered");
  const params = f.requests.find(row => row.method === "turn/steer")!.params;
  assert.equal(params.model, undefined); assert.equal(params.effort, undefined);
});

const fileAttachment = { mediaType: "application/octet-stream", data: "eA==", file: { name: "fixture.txt" } };
const filePath = (params: any): string => {
  const text = params.input.find((item: any) => item.type === "text").text as string;
  return JSON.parse(text.split("\n\n").find(line => line.startsWith("File attachment "))!.replace(/^.* bytes\): /, ""));
};

for (const status of ["idle", "active"]) test(`shared ${status} input stages files before the provider reads them`, async t => {
  let path = "";
  const f = await fixture(t, { onInput(params) {
    path = filePath(params);
    assert.equal(readFileSync(path, "utf8"), "x");
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(path)).mode & 0o777, 0o700);
    assert.equal(params.input.filter((item: any) => item.type === "image").length, 1);
    assert.equal(params.input.find((item: any) => item.type === "image").url, "data:image/png;base64,aW1hZ2U=");
    assert.equal(params.clientUserMessageId, "shared-file");
  } });
  f.thread.status = { type: status };
  const connection = await f.connector.connect(f.target, () => {});
  assert.ok(connection); t.after(() => connection.close());
  assert.equal(await connection.send("Read both", [fileAttachment, { mediaType: "image/png", data: "aW1hZ2U=" }], "shared-file"), "delivered");
  assert.equal(f.requests.filter(row => row.method === (status === "idle" ? "turn/start" : "turn/steer")).length, 1);
  // Managed-run exit and web disconnection do not own the native session's files.
  createInputFiles(f.target.cwd, f.target.taskId).cleanup();
  connection.close();
  assert.equal(readFileSync(path, "utf8"), "x");
});

test("local file validation and staging errors reject without submitting a provider turn", async t => {
  const f = await fixture(t);
  const connection = await f.connector.connect(f.target, () => {});
  assert.ok(connection); t.after(() => connection.close());
  for (const file of [
    { ...fileAttachment, file: { name: "../escape" } },
    { ...fileAttachment, mediaType: "image/png" },
    { ...fileAttachment, data: "invalid base64!" },
  ]) assert.equal(await connection.send("Invalid", [file], "invalid-file"), "rejected");
  // A filesystem failure is also known not to have crossed the send boundary.
  const staged = createInputFiles(f.target.cwd, `shared\0${f.target.home}\0${f.target.sessionId}`);
  const path = JSON.parse(staged.prepare("", [fileAttachment]).text.split("\n\n").at(-1)!.replace(/^.* bytes\): /, ""));
  const folder = dirname(path), outside = join(f.target.home, "outside");
  mkdirSync(outside); rmSync(folder, { recursive: true }); symlinkSync(outside, folder);
  assert.equal(await connection.send("Unsafe path", [fileAttachment], "unsafe-file"), "rejected");
  assert.equal(f.requests.filter(row => ["turn/start", "turn/steer"].includes(row.method)).length, 0);
});

test("lost shared-file acknowledgements retain bytes across reconnect without replay", async t => {
  let path = "";
  const f = await fixture(t, { onInput(params) { path = filePath(params); } });
  f.thread.status = { type: "idle" }; f.loseSend();
  const connection = await f.connector.connect(f.target, () => {});
  assert.ok(connection); t.after(() => connection.close());
  assert.equal(await connection.send("Read once", [fileAttachment], "uncertain-file"), "unknown");
  connection.close();
  const reopened = await f.connector.connect(f.target, () => {});
  assert.ok(reopened); t.after(() => reopened.close());
  await reopened.snapshot(); await reopened.history();
  assert.equal(readFileSync(path, "utf8"), "x");
  assert.equal(f.requests.filter(row => ["turn/start", "turn/steer"].includes(row.method)).length, 1);
});
