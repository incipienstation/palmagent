import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { AgentKind, TaskState } from "@palmagent/shared";
import { compatibleAgentCli } from "@palmagent/shared";
import { Db } from "../src/db.js";
import { Hub } from "../src/hub.js";
import { InProcessBackend } from "../src/inproc-backend.js";
import { checkpointSession, emptyTranscriptHash, locateSession, processIdentity, resumeCommand, synchronizeSession } from "../src/native-session.js";
import { extractOutputImages } from "../src/output-images.js";
import { TaskService } from "../src/service.js";
import { localSessionRequest, sessionSocket, startSessionControl } from "../src/session-control.js";
import { ProcessSupervisor } from "../src/supervisor.js";
import { WorktreeManager } from "../src/worktree.js";

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
  assert.equal(compatibleAgentCli("codex", "0.157.1"), true);
  for (const version of ["0.153.0", "0.154.0", "0.154.99", "0.155.0", "0.155.1", "0.156.0", "0.157.0", "0.157.2", "0.158.0", "0.157.1-beta.1", "unknown", "1.0"]) assert.equal(compatibleAgentCli("codex", version), false);
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
  const makeService = () => new TaskService(db, new Hub(), new ProcessSupervisor(1), new InProcessBackend(), new WorktreeManager());
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
  const service = new TaskService(db, new Hub(), new ProcessSupervisor(1), new InProcessBackend(), new WorktreeManager());
  await service.init();
  const writer = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { argv0: "codex", stdio: "ignore" });
  await once(writer, "spawn");
  f.defer(() => stopWriter(writer));
  const request = { agent: "codex" as const, sessionId: id, cwd: f.cwd, home: f.home, waitPid: writer.pid! };
  assert.throws(() => service.dispatchSession({ ...request, home: f.cwd }), /same provider home/);
  assert.throws(() => service.dispatchSession({ ...request, waitPid: process.pid }), /native agent CLI/);
  const task = service.dispatchSession(request);
  assert.equal(task.worktreePath, f.cwd);
  assert.equal(task.branch, undefined, "importing a cwd does not grant worktree cleanup ownership");
  assert.equal(service.dispatchSession(request).taskId, task.taskId, "repeating a pending request is idempotent");
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
  service.dispatchSession({ ...request, waitPid: writer2.pid! });
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
  const service = new TaskService(db, new Hub(), new ProcessSupervisor(1), new InProcessBackend(), new WorktreeManager());
  await service.init();
  const socket = await startSessionControl(stateDir, service);
  f.defer(() => closeControl(socket));
  const args = ["--import", "tsx", fileURLToPath(new URL("../src/cli/index.ts", import.meta.url)), "session", "dispatch", "--agent", "codex", "--cwd", f.cwd, "--data-dir", stateDir];
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
  const { PrEvidence } = await import("../src/pr-evidence.js");
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
