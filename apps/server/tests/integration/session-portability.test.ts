import { createTaskService } from "../../src/composition/task-service.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, closeSync, openSync, writeSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { AgentKind, TaskState } from "@palmagent/shared";
import { AGENT_CLI_COMPATIBILITY, compatibleAgentCli } from "@palmagent/shared";
import { Db } from "../../src/composition/database.js";
import { LocalAttachmentStorage } from "../../src/modules/tasks/adapters/outbound/file-attachment-storage.js";
import { Hub } from "../../src/platform/events/hub.js";
import { InProcessBackend } from "../../src/modules/agents/adapters/outbound/inproc-backend.js";
import { checkpointSession, emptyTranscriptHash, locateSession, processIdentity, resumeCommand, synchronizeSession } from "../../src/modules/tasks/adapters/outbound/native-session.js";
import { extractOutputImages, MAX_IMAGE_BYTES } from "../../src/modules/tasks/application/attachments/output-images.js";
import { TaskService } from "../../src/modules/tasks/application/use-cases/task-service.js";
import { NodeIdentifierGenerator } from "../../src/platform/process/id-generator.js";
import { LocalNativeSessionAdapter } from "../../src/modules/tasks/adapters/outbound/native-session-adapter.js";
import { LocalRepositoryPaths } from "../../src/modules/spaces/adapters/outbound/repository-paths.js";
import { localSessionRequest, sessionSocket } from "../../src/modules/tasks/adapters/inbound/session-control.js";
import { startSessionControl } from "../../src/composition/session-control.js";
import { ProcessSupervisor } from "../../src/modules/agents/adapters/outbound/supervisor.js";
import { WorktreeManager } from "../../src/modules/spaces/adapters/outbound/worktree.js";

async function stopWriter(writer: ChildProcess) {
  if (writer.exitCode !== null || writer.signalCode !== null) return;
  writer.kill();
  await once(writer, "close");
}
async function closeControl(server: Server) {
  server.closeAllConnections();
  if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
}

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=";
const id = "00000000-0000-4000-8000-000000000001";
const line = (value: unknown) => JSON.stringify(value) + "\n";
function setup(t: test.TestContext, agent: AgentKind = "codex") {
  const dir = mkdtempSync(join(tmpdir(), "palmagent-session-"));
  const cwd = join(dir, "repo 'with spaces");
  const home = join(dir, agent);
  mkdirSync(cwd); mkdirSync(home);
  const cleanups: Array<() => unknown> = [];
  t.after(async () => {
    try { for (const cleanup of cleanups.reverse()) await cleanup(); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });
  const transcript = agent === "codex" ? join(home, "sessions/2026/01/01", `rollout-fixture-${id}.jsonl`)
    : join(home, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${id}.jsonl`);
  mkdirSync(dirname(transcript), { recursive: true });
  const meta = agent === "codex" ? { type: "session_meta", payload: { id, cwd } } : { type: "system", sessionId: id, cwd };
  writeFileSync(transcript, line(meta));
  const task: TaskState = { taskId: "task-1", repoId: "repo-1", agent, prompt: "Fixture", status: "idle", interrupted: false, sessionId: id, worktreePath: cwd, permission: "read-only", createdAt: 1, updatedAt: 1, lastActivityAt: 1,
    sessionControl: { owner: "returning", home, transcript, cursor: 0, prefixHash: emptyTranscriptHash } };
  return { dir, cwd, home, transcript, task, defer: (cleanup: () => unknown) => cleanups.push(cleanup) };
}
function message(agent: AgentKind, role: string, text: string) {
  return agent === "codex" ? { type: "response_item", payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] } }
    : { type: role, message: { role, content: [{ type: "text", text }] } };
}

test("CLI compatibility ranges reject unknown, prerelease and out-of-lane versions", () => {
  for (const version of ["0.154.0", "0.154.99", "0.155.0", "0.155.1", "0.156.0", "0.156.1", "0.157.0", "0.157.1", "0.157.2", "0.158.0", "0.159.0", "0.160.0"]) assert.equal(compatibleAgentCli("codex", version), true);
  const lane = AGENT_CLI_COMPATIBILITY.codex;
  const [major, minor, patch] = lane.exclusiveMaximum.split(".").map(Number);
  assert.equal(compatibleAgentCli("codex", lane.minimum), true);
  assert.equal(compatibleAgentCli("codex", [major, minor, patch - 1].join(".")), true);
  for (const version of ["0.153.0", lane.exclusiveMaximum, [major + 1, 0, 0].join("."), "0.154.0-beta.1", "0.160.0-beta.1", "unknown", "1.0"]) assert.equal(compatibleAgentCli("codex", version), false);
  assert.equal(compatibleAgentCli("claude", "2.1.268"), true);
  assert.equal(compatibleAgentCli("claude", "2.1.267"), false);
  assert.equal(compatibleAgentCli("claude", "2.2.0"), false);
});

for (const agent of ["claude", "codex"] as const) test(`${agent} transcript sync checks identity, cursor, partial records and duplicate replay`, (t) => {
  const f = setup(t, agent);
  appendFileSync(f.transcript, line(message(agent, "user", "Local prompt")) + line(message(agent, "assistant", "Local answer")));
  if (agent === "codex") appendFileSync(f.transcript, line({ type: "event_msg", payload: { type: "agent_message", message: "Local answer" } }));
  assert.equal(locateSession(agent, id, f.cwd, f.home), f.transcript);
  assert.throws(() => locateSession(agent, "../../other", f.cwd, f.home), /Invalid/);
  const first = synchronizeSession(f.task);
  assert.equal(first.events.length, 2);
  assert.deepEqual(first.events[1].payload, { text: "Local answer" });
  f.task.sessionControl = first.control;
  assert.equal(synchronizeSession(f.task).events.length, 0);
  const snapshot = readFileSync(f.transcript);
  appendFileSync(f.transcript, '{"unfinished":');
  assert.throws(() => synchronizeSession(f.task), /unfinished/);
  writeFileSync(f.transcript, snapshot);
  assert.equal(synchronizeSession(f.task).events.length, 0);
  const changed = Buffer.from(snapshot); changed[10] = changed[10] === 65 ? 66 : 65;
  writeFileSync(f.transcript, changed);
  assert.throws(() => synchronizeSession(f.task), /before the synchronization cursor/);
  writeFileSync(f.transcript, snapshot);
  f.task.worktreePath = f.home;
  assert.throws(() => synchronizeSession(f.task));
});

for (const agent of ["claude", "codex"] as const) test(`${agent} native import preserves progress and final reply classification`, (t) => {
  const f = setup(t, agent);
  for (const [id, text, phase] of [["work", "Checking files", "progress"], ["answer", "Finished", "final"], ["legacy", "Unclassified", undefined]] as const) {
    const content = [{ type: agent === "codex" ? "output_text" : "text", text }];
    appendFileSync(f.transcript, line(agent === "codex"
      ? { type: "response_item", payload: { type: "message", role: "assistant", id, content,
        phase: phase === "progress" ? "commentary" : phase === "final" ? "final_answer" : undefined } }
      : { type: "assistant", message: { role: "assistant", id, content,
        stop_reason: phase === "progress" ? "tool_use" : phase === "final" ? "end_turn" : undefined } }));
  }
  const synced = synchronizeSession(f.task);
  assert.deepEqual(synced.events.map(event => event.payload), [
    { text: "Checking files", messageId: "work", phase: "progress" },
    { text: "Finished", messageId: "answer", phase: "final" },
    { text: "Unclassified", messageId: "legacy" },
  ]);
  f.task.sessionControl = synced.control;
  assert.equal(synchronizeSession(f.task).events.length, 0);
});

test("structured image extraction bounds raster payloads and strips unsupported image bodies", () => {
  const out = extractOutputImages({ content: [{ type: "image", mimeType: "image/png", data: png }, { type: "tool_result", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: png } }] }] });
  assert.equal(out.images.length, 2);
  assert.deepEqual(out.images.map(({ width, height }) => [width, height]), [[1, 1], [1, 1]]);
  assert.equal(JSON.stringify(out.payload).includes(png), false);
  for (const [mimeType, data] of [["image/svg+xml", Buffer.from("<svg/>").toString("base64")], ["image/png", "YWJj"], ["image/png", "a".repeat(8_000_000)]]) {
    const result = extractOutputImages({ type: "image", mimeType, data });
    assert.equal(result.images.length, 0);
    assert.equal(JSON.stringify(result.payload).includes(data), false);
  }
  assert.equal(extractOutputImages(Array.from({ length: 10 }, () => ({ type: "image", mimeType: "image/png", data: png }))).images.length, 4);
});

test("Codex input_image data URLs become bounded image output without retaining image bodies", () => {
  const block = { type: "input_image", image_url: `data:image/png;base64,${png}`, detail: "high" };
  const text = { type: "input_text", text: "Script completed" };
  const out = extractOutputImages({ content: [text, block] });
  assert.deepEqual(out.images, [{ mediaType: "image/png", data: png, width: 1, height: 1 }]);
  assert.deepEqual(out.payload, { content: [text, { type: "image", text: "Image output" }] });
  const capped = extractOutputImages(Array(6).fill(block));
  assert.equal(capped.images.length, 4);
  assert.equal(JSON.stringify(capped.payload).includes(png), false);
  for (const image_url of [undefined, {}, "https://example.invalid/image.png", "file:///tmp/image.png",
    "data:image/svg+xml;base64,PHN2Zy8+", `data:image/jpeg;base64,${png}`, "data:image/png;base64,YWJj",
    `data:image/png,${png}`, `data:image/png;base64,${png}!`,
    `data:image/png;base64,${Buffer.concat([Buffer.from(png, "base64"), Buffer.alloc(MAX_IMAGE_BYTES)]).toString("base64")}`]) {
    const rejected = extractOutputImages({ ...block, image_url });
    assert.deepEqual(rejected.images, []);
    assert.deepEqual(rejected.payload, { type: "image", text: "Unsupported image output" });
  }
});

test("Codex custom tool image output is imported once and remains visible after reopening history", (t) => {
  const f = setup(t);
  appendFileSync(f.transcript, line({ type: "response_item", payload: { type: "custom_tool_call_output", call_id: "image-call",
    output: [{ type: "input_text", text: "Script completed" }, { type: "input_image", image_url: `data:image/png;base64,${png}` }] } }));
  const synced = synchronizeSession(f.task);
  assert.deepEqual(synced.events.map(event => event.kind), ["tool_result", "output_image"]);
  assert.equal(JSON.stringify(synced.events[0]).includes(png), false);
  const path = join(f.dir, "state.db");
  const db = new Db(path);
  try {
    db.insertRepo({ id: "repo-1", name: "fixture", path: f.cwd, vcs: "none", defaultBaseRef: "", createdAt: 1 });
    db.insertTask(f.task);
    f.task.sessionControl = synced.control;
    db.importSessionEvents(f.task, synced.events);
  } finally { db.close(); }
  const reopened = new Db(path);
  try {
    assert.deepEqual(reopened.eventsAfterSeq(f.task.taskId, 0).map(row => row.event.kind), ["tool_result", "output_image"]);
    assert.deepEqual(reopened.eventsAfterSeq(f.task.taskId, 0)[1].event.payload, { mediaType: "image/png", data: png, width: 1, height: 1, tool_use_id: "image-call" });
    assert.equal(synchronizeSession(reopened.getTask(f.task.taskId)!).events.length, 0);
  } finally { reopened.close(); }
});

test("large native histories synchronize beyond 64 MiB and retain append, preview and rewrite checks", t => {
  const f = setup(t);
  const expected = createHash("sha256").update(readFileSync(f.transcript));
  const record = line({ type: "event_msg", payload: { type: "fixture", text: "x".repeat(1024 * 1024) } });
  for (let i = 0; i < 65; i++) {
    appendFileSync(f.transcript, record);
    expected.update(record);
  }
  const checkpoint = checkpointSession(f.task);
  assert.ok(checkpoint.cursor > 64 * 1024 * 1024);
  assert.equal(checkpoint.prefixHash, expected.digest("hex"));
  // Initial import also scans a large history without a whole-file buffer.
  const initial = synchronizeSession(f.task);
  assert.equal(initial.events.length, 0);
  assert.equal(initial.control.prefixHash, checkpoint.prefixHash);
  f.task.sessionControl = initial.control;
  const text = "한글🙂".repeat(20_000);
  const appended = Buffer.from(line(message("codex", "assistant", text)));
  appendFileSync(f.transcript, appended.subarray(0, appended.length - 2));
  assert.equal(synchronizeSession(f.task, { preview: true }).control.cursor, checkpoint.cursor);
  assert.throws(() => synchronizeSession(f.task), /unfinished/);
  appendFileSync(f.transcript, appended.subarray(appended.length - 2));
  const synced = synchronizeSession(f.task, { preview: true });
  assert.deepEqual(synced.events.map(event => event.payload), [{ text }]);
  f.task.sessionControl = synced.control;
  assert.equal(synchronizeSession(f.task).events.length, 0);
  // A same-sized prefix edit must still fail even after the limit is removed.
  const fd = openSync(f.transcript, "r+");
  try { writeSync(fd, Buffer.from("y"), 0, 1, checkpoint.cursor - 10); }
  finally { closeSync(fd); }
  assert.throws(() => synchronizeSession(f.task), /before the synchronization cursor/);
});

test("handoff persists ownership; socket dispatch previews a live writer and transfers exactly once across restart", { skip: process.platform !== "linux" }, async (t) => {
  const f = setup(t);
  const originalHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = f.home;
  f.defer(() => { if (originalHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = originalHome; });
  const db = new Db(join(f.dir, "state/palmagent.db"));
  f.defer(() => db.close());
  db.insertRepo({ id: "repo-1", name: "fixture", path: f.cwd, vcs: "none", defaultBaseRef: "", createdAt: 1 });
  delete f.task.sessionControl;
  db.insertTask(f.task);
  const makeService = () => createTaskService(db, new Hub(), new ProcessSupervisor(1), new InProcessBackend(), new WorktreeManager(), new LocalAttachmentStorage(db), new LocalRepositoryPaths(), new LocalNativeSessionAdapter(db.path), new NodeIdentifierGenerator());
  let service = makeService(); await service.init();
  const handoff = service.handoff(f.task.taskId);
  assert.match(handoff.command, /'codex' 'resume'/);
  assert.match(handoff.command, /'\\''/);
  for (const operation of [() => service.followup(f.task.taskId, "blocked"), () => service.steer(f.task.taskId, "blocked"), () => service.cancel(f.task.taskId), () => service.archive(f.task.taskId)]) assert.throws(operation, /local shell/);
  service = makeService(); await service.init();
  assert.equal(service.getTask(f.task.taskId).sessionControl?.owner, "local");
  assert.equal(service.handoff(f.task.taskId).command, handoff.command);
  const writer = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { argv0: "codex", stdio: "ignore" });
  await once(writer, "spawn");
  f.defer(() => stopWriter(writer));
  assert.ok(processIdentity(writer.pid!));
  const socket = await startSessionControl(join(f.dir, "state"), service);
  f.defer(() => closeControl(socket));
  assert.equal(statSync(sessionSocket(join(f.dir, "state"))).mode & 0o777, 0o600);
  const request = { agent: "codex" as const, sessionId: id, cwd: f.cwd, home: f.home, waitPid: writer.pid! };
  const result = await localSessionRequest(join(f.dir, "state"), request);
  assert.equal(result.task.taskId, f.task.taskId);
  assert.equal(service.listTasks().length, 1);
  appendFileSync(f.transcript, line(message("codex", "user", "Shell prompt")) + line(message("codex", "assistant", "Shell answer")));
  service.reconcileLocalSessions();
  assert.equal(db.eventsAfterSeq(f.task.taskId, 0).length, 2, "saved messages are visible while the writer is alive");
  assert.equal(service.getTask(f.task.taskId).sessionControl?.owner, "returning");
  service.reconcileLocalSessions();
  assert.equal(db.eventsAfterSeq(f.task.taskId, 0).length, 2, "unchanged previews do not duplicate events");
  await closeControl(socket); // a restart also stops the old reconciler
  service = makeService(); await service.init();
  assert.throws(() => service.followup(f.task.taskId, "blocked"), /local shell/);
  writer.kill(); await once(writer, "exit");
  service.reconcileLocalSessions();
  assert.equal(service.getTask(f.task.taskId).sessionControl?.owner, "palmagent");
  assert.equal(db.eventsAfterSeq(f.task.taskId, 0).length, 2);
  service.reconcileLocalSessions();
  service = makeService(); await service.init(); service.reconcileLocalSessions();
  assert.equal(db.eventsAfterSeq(f.task.taskId, 0).length, 2);
  // A second shell visit checkpoints the provider history without copying the
  // first visit into the browser log again.
  service.handoff(f.task.taskId);
  const again = service.getTask(f.task.taskId);
  assert.equal(synchronizeSession(again).events.length, 0);
  assert.match(resumeCommand(again), /CODEX_HOME=/);
});


test("a first local import preserves cwd, waits for exit, and fails closed on transcript rewrites", { skip: process.platform !== "linux" }, async (t) => {
  const f = setup(t);
  const originalHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = f.home;
  f.defer(() => { if (originalHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = originalHome; });
  const db = new Db(join(f.dir, "state/palmagent.db"));
  f.defer(() => db.close());
  const service = createTaskService(db, new Hub(), new ProcessSupervisor(1), new InProcessBackend(), new WorktreeManager(), new LocalAttachmentStorage(db), new LocalRepositoryPaths(), new LocalNativeSessionAdapter(db.path), new NodeIdentifierGenerator());
  await service.init();
  const writer = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { argv0: "codex", stdio: "ignore" });
  await once(writer, "spawn");
  f.defer(() => stopWriter(writer));
  const request = { agent: "codex" as const, sessionId: id, cwd: f.cwd, home: f.home, waitPid: writer.pid! };
  await assert.rejects(() => service.dispatchSession({ ...request, home: f.cwd }), /same provider home/);
  await assert.rejects(() => service.dispatchSession({ ...request, waitPid: process.pid }), /native agent CLI/);
  const task = await service.dispatchSession(request);
  assert.equal(task.worktreePath, f.cwd);
  assert.equal(task.branch, undefined, "importing a cwd does not grant worktree cleanup ownership");
  assert.equal((await service.dispatchSession(request)).taskId, task.taskId, "repeating a pending request is idempotent");
  appendFileSync(f.transcript, line(message("codex", "user", "Local work")));
  appendFileSync(f.transcript, line({ type: "response_item", payload: { type: "function_call", name: "fixture", arguments: "{}", call_id: "call-1" } }));
  appendFileSync(f.transcript, line({ type: "response_item", payload: { type: "function_call_output", call_id: "call-1", output: [{ type: "image", mimeType: "image/png", data: png }] } }));
  writer.kill(); await once(writer, "exit");
  service.reconcileLocalSessions();
  assert.equal(task.sessionControl?.owner, "palmagent");
  assert.deepEqual(db.eventsAfterSeq(task.taskId, 0).map((row) => row.event.kind), ["status", "tool_call", "tool_result", "output_image"]);
  service.handoff(task.taskId);
  const writer2 = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { argv0: "codex", stdio: "ignore" });
  await once(writer2, "spawn");
  f.defer(() => stopWriter(writer2));
  await service.dispatchSession({ ...request, waitPid: writer2.pid! });
  const preserved = readFileSync(f.transcript);
  writeFileSync(f.transcript, line({ type: "session_meta", payload: { id, cwd: f.cwd } }));
  writer2.kill(); await once(writer2, "exit");
  service.reconcileLocalSessions();
  assert.equal(task.sessionControl?.owner, "returning");
  assert.match(task.sessionControl?.error ?? "", /before the synchronization cursor/);
  assert.throws(() => service.followup(task.taskId, "blocked"), /local shell/);
  assert.equal(db.eventsAfterSeq(task.taskId, 0).length, 4);
  writeFileSync(f.transcript, preserved);
  service.reconcileLocalSessions();
  assert.equal(task.sessionControl?.owner, "palmagent");
  assert.equal(db.eventsAfterSeq(task.taskId, 0).length, 4);
});


test("the dispatch CLI detects its native parent and queues a transfer through the private socket", { skip: process.platform !== "linux", timeout: 10_000 }, async (t) => {
  const f = setup(t);
  const originalHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = f.home;
  f.defer(() => { if (originalHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = originalHome; });
  const stateDir = join(f.dir, "state");
  const db = new Db(join(stateDir, "palmagent.db"));
  f.defer(() => db.close());
  const service = createTaskService(db, new Hub(), new ProcessSupervisor(1), new InProcessBackend(), new WorktreeManager(), new LocalAttachmentStorage(db), new LocalRepositoryPaths(), new LocalNativeSessionAdapter(db.path), new NodeIdentifierGenerator());
  await service.init();
  const socket = await startSessionControl(stateDir, service);
  f.defer(() => closeControl(socket));
  const args = ["--import", "tsx", fileURLToPath(new URL("../../src/bootstrap/cli.ts", import.meta.url)), "session", "dispatch", "--agent", "codex", "--cwd", f.cwd, "--data-dir", stateDir];
  // argv0 identifies a synthetic native writer. Its child uses the public CLI,
  // with session identity inherited exactly as in a Codex tool shell.
  const program = `const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ${JSON.stringify(args)}, { stdio: 'inherit' }); child.on('exit', code => { if (code) process.exit(code); }); setInterval(() => {}, 1000);`;
  const writer = spawn(process.execPath, ["-e", program], { argv0: "codex", env: { ...process.env, CODEX_THREAD_ID: id, CODEX_HOME: f.home }, stdio: ["ignore", "pipe", "pipe"] });
  f.defer(() => stopWriter(writer));
  let output = "";
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`dispatch CLI did not report a pending transfer: ${output}`)), 5000);
    writer.stdout!.on("data", (chunk) => { output += chunk; if (output.includes("Session queued as")) { clearTimeout(timer); resolve(); } });
    writer.stderr!.on("data", (chunk) => { output += chunk; });
    writer.once("error", (error) => { clearTimeout(timer); reject(error); });
    writer.once("exit", (code) => { if (code) { clearTimeout(timer); reject(new Error(output)); } });
  });
  const task = service.listTasks()[0];
  assert.equal(task.sessionId, id);
  assert.equal(task.sessionControl?.waitPid, writer.pid);
  assert.equal(task.sessionControl?.owner, "returning");
  writer.kill(); await once(writer, "exit");
  service.reconcileLocalSessions();
  assert.equal(task.sessionControl?.owner, "palmagent");
});

for (const agent of ["claude", "codex"] as const) test(`${agent} live preview imports complete records without taking ownership`, (t) => {
  const f = setup(t, agent);
  f.task.sessionControl!.waitPid = 123;
  f.task.sessionControl!.waitIdentity = "fixture-writer";
  const first = line(message(agent, "assistant", "Saved locally"));
  const next = Buffer.from(line(message(agent, "assistant", "아직 작성 중")));
  // Split inside a multibyte character: byte cursors must wait for the entire record.
  const cut = next.indexOf(Buffer.from("아")) + 1;
  appendFileSync(f.transcript, first);
  appendFileSync(f.transcript, next.subarray(0, cut));
  const preview = synchronizeSession(f.task, { preview: true });
  assert.equal(preview.control.owner, "returning");
  assert.equal(preview.control.waitPid, 123);
  assert.equal(preview.control.waitIdentity, "fixture-writer");
  assert.deepEqual(preview.events.map((e) => e.payload), [{ text: "Saved locally" }]);
  f.task.sessionControl = preview.control;
  assert.equal(synchronizeSession(f.task, { preview: true }).events.length, 0);
  assert.throws(() => synchronizeSession(f.task), /unfinished/);
  appendFileSync(f.transcript, next.subarray(cut));
  const finished = synchronizeSession(f.task);
  assert.equal(finished.control.owner, "palmagent");
  assert.equal(finished.control.waitPid, undefined);
  assert.deepEqual(finished.events.map((e) => e.payload), [{ text: "아직 작성 중" }]);
  f.task.sessionControl = finished.control;
  assert.equal(synchronizeSession(f.task).events.length, 0);
});

test("live preview waits for its first complete record and refuses rewrites or malformed completed records", (t) => {
  const f = setup(t);
  const meta = readFileSync(f.transcript);
  writeFileSync(f.transcript, meta.subarray(0, 10));
  assert.equal(synchronizeSession(f.task, { preview: true }).control.cursor, 0);
  writeFileSync(f.transcript, meta);
  const first = synchronizeSession(f.task, { preview: true });
  f.task.sessionControl = first.control;
  appendFileSync(f.transcript, 'not-json\n');
  assert.throws(() => checkpointSession(f.task));
  assert.throws(() => synchronizeSession(f.task, { preview: true }));
  writeFileSync(f.transcript, meta);
  assert.equal(synchronizeSession(f.task, { preview: true }).events.length, 0);
  writeFileSync(f.transcript, '\n');
  assert.throws(() => synchronizeSession(f.task, { preview: true }), /before the synchronization cursor/);
});

test("Claude transcript import retains PR creation failures as well as successful results", async (t) => {
  const { PrEvidence } = await import("../../src/modules/tasks/adapters/outbound/pr-evidence.js");
  const f = setup(t, "claude");
  const url = "https://github.com/acme/sample-app/pull/42";
  const rows = [
    { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "failed", name: "Bash", input: { command: "gh pr create" } }] } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "failed", is_error: true, content: url }] } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "created", name: "Bash", input: { command: "gh pr create" } }] } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "created", is_error: false, content: url }] } },
  ];
  appendFileSync(f.transcript, rows.map(line).join(""));
  const events = synchronizeSession(f.task).events;
  const tracker = new PrEvidence();
  assert.deepEqual(events.slice(0, 2).flatMap((e) => tracker.accept(e)), []);
  assert.deepEqual(events.slice(2).flatMap((e) => tracker.accept(e)), [url]);
});


test("native Codex preview imports context usage and compaction boundaries without duplicating them", t => {
  const f = setup(t);
  appendFileSync(f.transcript, line({ type: "event_msg", payload: { type: "token_count", info: {
    last_token_usage: { total_tokens: 84000 }, total_token_usage: { total_tokens: 900000 }, model_context_window: 200000,
  } } }) + line({ type: "compacted", replacement_history: [] }));
  const synced = synchronizeSession(f.task, { preview: true });
  assert.deepEqual(synced.events.map(e => e.payload), [
    { subtype: "usage", usage: { last: { totalTokens: 84000 }, modelContextWindow: 200000 } },
    { subtype: "context_compaction_started" },
  ]);
  f.task.sessionControl = synced.control;
  assert.equal(synchronizeSession(f.task, { preview: true }).events.length, 0);
});

test("native Codex history retains partial answers and unknown phases without ending the turn", t => {
  const f = setup(t, "codex");
  for (const phase of ["partial_answer", "future_phase"]) appendFileSync(f.transcript, line({ type: "response_item", payload: {
    type: "message", role: "assistant", id: phase, phase, content: [{ type: "output_text", text: "Visible finding" }],
  } }));
  const synced = synchronizeSession(f.task);
  assert.deepEqual(synced.events.map(e => ({ kind: e.kind, payload: e.payload })), [
    { kind: "assistant_text", payload: { text: "Visible finding", messageId: "partial_answer", phase: "partial" } },
    { kind: "assistant_text", payload: { text: "Visible finding", messageId: "future_phase" } },
  ]);
  f.task.sessionControl = synced.control;
  assert.equal(synchronizeSession(f.task).events.length, 0);
});
