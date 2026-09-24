import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { describe } from "node:test";
import Database from "better-sqlite3";
import { beginUpdateMaintenance, isUpdateMaintenance } from "../src/update-maintenance.ts";
import { verifyUpdateIdle } from "../src/cli/update-idle.ts";

const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = join(serverDir, "tests/fixtures/lifecycle-cli.cjs");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const options = { skip: process.platform === "win32", timeout: 30000 };
const shellQuote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";

async function until(label, fn, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await delay(25);
  }
  throw new Error("Timed out: " + label);
}

async function kill(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  await until("owned process exit", () => child.exitCode !== null || child.signalCode !== null);
}

// Do not reassign a port between concurrent cases during startup/restart gaps.
const assignedPorts = new Set();
async function freePort() {
  return new Promise((resolve, reject) => {
    const socket = createServer();
    socket.on("error", reject);
    socket.listen(0, "localhost", () => {
      const port = socket.address().port;
      socket.close(() => {
        if (assignedPorts.has(port)) return freePort().then(resolve, reject);
        assignedPorts.add(port);
        resolve(port);
      });
    });
  });
}

// Real HTTP server, daemon, SQLite and adapters, with only the external CLI
// replaced. Build the environment from scratch: never inherit a live socket,
// database, provider credentials, or user CLI configuration.
async function harness(t, daemon = true) {
  const dir = mkdtempSync(join(tmpdir(), "palmagent-lifecycle-"));
  const children = [];
  const logs = [];
  let db;
  t.after(async () => {
    await Promise.all(children.map(kill));
    const executionsPath = join(dir, "state/executions/executions.sqlite");
    if (existsSync(executionsPath)) {
      const executions = new Database(executionsPath, { readonly: true });
      for (const { pid } of executions.prepare("SELECT pid FROM executions WHERE pid IS NOT NULL").all()) {
        try { process.kill(-pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      }
      executions.close();
    }
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  });
  for (const part of ["bin", "home", "control", "repo", "state"]) mkdirSync(join(dir, part));
  for (const agent of ["claude", "codex"]) {
    writeFileSync(join(dir, "bin", agent),
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(fixture)} ${agent} "$@"\n`,
      { mode: 0o700 });
  }
  const env = {
    PATH: `${join(dir, "bin")}:${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: join(dir, "home"),
    LANG: "C.UTF-8",
    NODE_ENV: "development",
    AUTH_DISABLED: "1",
    HOST: "localhost",
    PORT: String(await freePort()),
    DISPATCHER_DATA_DIR: join(dir, "state"),
    DISPATCHER_DB: join(dir, "state/palmagent.db"),
    REPO_ROOTS: join(dir, "repo"),
    CLAUDE_CONFIG_DIR: join(dir, "home/claude"),
    CODEX_HOME: join(dir, "home/codex"),
    PROBE_CONTROL: join(dir, "control"),
    DISPATCH_CONCURRENCY: "2",
  };
  if (daemon === "independent") {
    env.EXECUTION_RELEASE = serverDir;
    env.EXECUTION_NODE = process.execPath;
    env.PALMAGENT_EXECUTION_CONCURRENCY = "2";
    // Test-only launcher: start a sibling process group, never inherit the web's
    // group. Production uses the separately owned systemd execution unit.
    writeFileSync(join(dir, "bin", "sudo"), `#!${process.execPath}
const { spawn } = require("node:child_process");
const { openSync } = require("node:fs");
const log = openSync(${JSON.stringify(join(dir, "execution.log"))}, "a");
spawn(process.execPath, ["--import", "tsx", ${JSON.stringify(join(serverDir, "src/execution-host.ts"))}, ${JSON.stringify(join(dir, "state/executions"))}, process.argv.at(-1)], { cwd: ${JSON.stringify(serverDir)}, env: process.env, detached: true, stdio: ["ignore", log, log] }).unref();
`, { mode: 0o700 });
  }
  if (daemon === true) env.RUNNER_SOCKET = join(dir, "runner.sock");
  const git = (args) => execFileSync("git", args, { cwd: join(dir, "repo"), env, stdio: "pipe" });
  git(["init", "-b", "main"]);
  git(["-c", "user.name=Validation", "-c", "user.email=validation",
    "commit", "--allow-empty", "-m", "Synthetic fixture"]);

  const c = { dir, env, base: `http://localhost:${env.PORT}` };
  c.start = (entry) => {
    const child = spawn(process.execPath, ["--import", "tsx", `src/${entry}.ts`], {
      cwd: serverDir, env, detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    child.stdout.on("data", (data) => logs.push(data.toString()));
    child.stderr.on("data", (data) => logs.push(data.toString()));
    return child;
  };
  c.api = async (route, body) => {
    const response = await fetch(c.base + "/api/" + route, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    });
    const data = await response.json();
    assert(response.ok, `${route}: ${response.status} ${JSON.stringify(data)}`);
    return data;
  };
  c.webStart = async () => {
    c.web = c.start("server");
    await until("web health", async () => {
      assert.equal(c.web.exitCode, null, logs.join(""));
      try { return (await c.api("health")).ok; } catch { return false; }
    });
  };
  c.restart = async (graceful = false) => {
    if (graceful) {
      c.web.kill("SIGTERM");
      await until("graceful web exit", () => c.web.exitCode !== null);
      assert.equal(c.web.exitCode, 0, logs.join(""));
    } else await kill(c.web);
    await c.webStart();
  };
  c.task = async (id) => (await c.api("tasks/" + id)).task;
  c.waitTask = (id, predicate) => until("task state " + id, async () => {
    const task = await c.task(id);
    return predicate(task) && task;
  });
  c.marker = (key, suffix) => join(dir, "control", key + suffix);
  c.mark = (key, suffix) => writeFileSync(c.marker(key, suffix), "");
  c.ready = (key) => until("CLI ready " + key, () =>
    existsSync(c.marker(key, ".ready")) && JSON.parse(readFileSync(c.marker(key, ".ready"), "utf8")));
  c.rows = (id) => db.prepare("SELECT * FROM events WHERE task_id=? ORDER BY seq").all(id);
  c.create = async (agent, key, mode = "hold", extra = {}) => {
    const { task } = await c.api("tasks", {
      repoId: c.repo.id, agent, prompt: JSON.stringify({ key, mode, ...extra }), isolate: true,
    });
    await c.ready(key);
    return c.waitTask(task.taskId, (task) => !!task.sessionId);
  };
  if (daemon === true) {
    c.runner = c.start("runner-daemon");
    await until("runner socket", () => existsSync(env.RUNNER_SOCKET));
  }
  await c.webStart();
  db = new Database(env.DISPATCHER_DB, { readonly: true });
  c.repo = (await c.api("repos", { path: join(dir, "repo"), defaultBaseRef: "main" })).repo;
  return c;
}

async function observeStream(c, taskId, global = false) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1000);
  const ids = [];
  let buffer = "";
  let snapshot;
  try {
    const response = await fetch(c.base + "/api/stream" + (global ? "" : "?task=" + taskId), {
      headers: { "Last-Event-ID": "2" }, signal: controller.signal,
    });
    assert(response.ok);
    for await (const chunk of response.body) {
      buffer += Buffer.from(chunk).toString();
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const match = /^id: (\d+)$/m.exec(frame);
        if (match) ids.push(Number(match[1]));
        const data = /^data: (.+)$/m.exec(frame);
        if (data) {
          const parsed = JSON.parse(data[1]);
          if (parsed.type === "tasks") snapshot = parsed;
        }
      }
    }
  } catch (error) {
    if (error.name !== "AbortError") throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return { ids, snapshot };
}

// Each case owns its environment, database, sockets and child process groups.
describe("isolated lifecycle contracts", { concurrency: 2 }, () => {
for (const agent of ["claude", "codex"]) {
  test(`${agent}: web crash preserves CLI and REST owns persisted event recovery`, options, async (t) => {
    const c = await harness(t);
    const task = await c.create(agent, "one");
    const child = await c.ready("one");
    await kill(c.web);
    process.kill(child.pid, 0); // same external CLI survives the web process
    c.mark("one", ".release");
    await until("offline result", () => existsSync(c.marker("one", ".terminal")));
    await c.webStart();
    const final = await c.waitTask(task.taskId, (task) => task.status === "idle");
    assert.equal(final.sessionId, task.sessionId);
    assert.equal(final.interrupted, false);
    const rows = c.rows(task.taskId);
    for (const text of ["one:before", "one:after"]) {
      assert.equal(rows.filter((row) => row.kind === "assistant_text" &&
        JSON.parse(row.payload_json).text === text).length, 1);
    }
    assert.equal(rows.filter((row) => row.kind === "result").length, 1);
    await c.restart();
    assert.deepEqual(c.rows(task.taskId), rows);
    const through = rows.at(-1).seq;
    const catchupResponse = await fetch(c.base + `/api/tasks/${task.taskId}/history/changes?after=2&through=${through}`);
    assert.equal(catchupResponse.status, 200);
    assert.equal(catchupResponse.headers.get("cache-control"), "no-store");
    const catchup = await catchupResponse.json();
    assert.deepEqual(catchup.events.map((row) => row.seq), rows.filter((row) => row.seq > 2).map((row) => row.seq));
    const scoped = await observeStream(c, task.taskId);
    assert.equal(scoped.snapshot.historyThrough, through);
    assert.deepEqual(scoped.ids, [], "persisted rows are not replayed over scoped SSE");
    const inbox = await observeStream(c, task.taskId, true);
    assert.equal(inbox.snapshot.historyThrough, undefined);
    assert.deepEqual(inbox.ids, [], "persisted rows are not replayed over inbox SSE");
  });

  test(`${agent}: graceful view restart preserves the same running process and session`, options, async (t) => {
    const c = await harness(t);
    const task = await c.create(agent, "view-restart");
    const child = await c.ready("view-restart");
    await c.restart(true);
    process.kill(child.pid, 0);
    const live = await c.waitTask(task.taskId, (task) => task.status === "running");
    assert.equal(live.sessionId, task.sessionId);
    assert.equal(live.interrupted, false);
    assert.deepEqual(await c.ready("view-restart"), child, "the view must not create a replacement CLI process");
    c.mark("view-restart", ".release");
    const final = await c.waitTask(task.taskId, (task) => task.status === "idle");
    assert.equal(final.sessionId, task.sessionId);
    assert.equal(final.interrupted, false);
    const rows = c.rows(task.taskId);
    for (const text of ["view-restart:before", "view-restart:after"]) {
      assert.equal(rows.filter((row) => row.kind === "assistant_text" && JSON.parse(row.payload_json).text === text).length, 1);
    }
    assert.equal(rows.filter((row) => row.kind === "result").length, 1);
  });

  test(`${agent}: stop and resume preserve session and worktree`, options, async (t) => {
    const c = await harness(t);
    const task = await c.create(agent, "first");
    await c.api("tasks/" + task.taskId + "/stop", {});
    const stopped = await c.waitTask(task.taskId, (task) => task.status === "idle");
    assert.equal(stopped.interrupted, true);
    assert(existsSync(task.worktreePath));
    await c.api("tasks/" + task.taskId + "/followup", { prompt: JSON.stringify({ key: "next", mode: "auto" }) });
    const next = await c.ready("next");
    const final = await c.waitTask(task.taskId, (task) => task.status === "idle");
    assert.equal(next.session, task.sessionId);
    assert.equal(next.cwd, task.worktreePath);
    assert.equal(final.interrupted, false);
  });

  test(`${agent}: in-process crash recovers with environment overrides`, options, async (t) => {
    const c = await harness(t, false);
    const task = await c.create(agent, "first");
    const child = await c.ready("first");
    assert.equal(child.home, c.env.HOME);
    assert.equal(child.configDir, c.env.CLAUDE_CONFIG_DIR);
    await c.restart();
    const recovered = await c.waitTask(task.taskId, (task) => task.status === "idle");
    assert.equal(recovered.interrupted, true);
    assert.equal(recovered.sessionId, task.sessionId);
    await c.api("tasks/" + task.taskId + "/followup", { prompt: JSON.stringify({ key: "next", mode: "auto" }) });
    assert.equal((await c.ready("next")).session, task.sessionId);
    await c.waitTask(task.taskId, (task) => task.status === "idle");
  });

  for (const restart of [false, true]) {
    test(`${agent}: terminal failure is retained (restart=${restart})`, options, async (t) => {
      const c = await harness(t);
      // A zero process exit must not hide the protocol's terminal failure.
      const task = await c.create(agent, "failure", "terminal-hold", { failed: true, exitCode: 0 });
      await until("persisted failure", () => c.rows(task.taskId).some((row) =>
        row.kind === (agent === "claude" ? "result" : "error")));
      const rows = c.rows(task.taskId);
      if (restart) await c.restart();
      c.mark("failure", ".exit");
      const final = await c.waitTask(task.taskId, (task) => ["idle", "failed"].includes(task.status));
      assert.equal(final.status, "failed");
      assert.deepEqual(c.rows(task.taskId).filter((row) => row.seq <= rows.at(-1).seq), rows);
    });
  }

  test(`${agent}: runner loss is a failure and disconnected dispatch settles`, options, async (t) => {
    const c = await harness(t);
    const task = await c.create(agent, "first");
    await kill(c.runner);
    assert.equal((await c.waitTask(task.taskId, (task) => task.status !== "running")).status, "failed");
    const next = (await c.api("tasks", {
      repoId: c.repo.id, agent, prompt: JSON.stringify({ key: "offline", mode: "auto" }),
    })).task;
    assert.equal((await c.waitTask(next.taskId, (task) => task.status !== "running")).status, "failed");
  });

  test(`${agent}: unexpected signal without terminal result fails`, options, async (t) => {
    const c = await harness(t);
    const task = await c.create(agent, "signal");
    process.kill((await c.ready("signal")).pid, "SIGKILL");
    assert.equal((await c.waitTask(task.taskId, (task) => task.status !== "running")).status, "failed");
  });

  test(`${agent}: nonzero process exit overrides a successful result`, options, async (t) => {
    const c = await harness(t);
    const task = await c.create(agent, "nonzero", "terminal-hold", { exitCode: 1 });
    await until("success result", () => c.rows(task.taskId).some((row) => row.kind === "result"));
    c.mark("nonzero", ".exit");
    assert.equal((await c.waitTask(task.taskId, (task) => task.status !== "running")).status, "failed");
  });
}

test("Codex: success supersedes a transient error after replay", options, async (t) => {
  const c = await harness(t);
  const task = await c.create("codex", "transient", "terminal-hold", { transientError: true });
  await until("persisted success", () => c.rows(task.taskId).some((row) => row.kind === "result"));
  await c.restart();
  c.mark("transient", ".exit");
  assert.equal((await c.waitTask(task.taskId, (task) => task.status !== "running")).status, "idle");
});

for (const restart of [false, true]) {
  test(`Claude: persisted result closes stdin (restart=${restart})`, options, async (t) => {
    const c = await harness(t);
    const task = await c.create("claude", "terminal", "terminal-hold");
    await until("persisted result", () => c.rows(task.taskId).some((row) => row.kind === "result"));
    if (restart) await c.restart();
    await c.waitTask(task.taskId, (task) => task.status === "idle");
    assert(existsSync(c.marker("terminal", ".eof")));
    assert.equal(c.rows(task.taskId).filter((row) => row.kind === "result").length, 1);
  });
}

for (const daemon of [true, false]) {
  test(`update maintenance blocks new admissions and preserves active work (${daemon ? "daemon" : "in-process"})`, options, async (t) => {
    const c = await harness(t, daemon);
    const task = await c.create("codex", "maintenance");
    const cfg = { host: "localhost", port: Number(c.env.PORT), dbPath: c.env.DISPATCHER_DB, runnerSocket: c.env.RUNNER_SOCKET };
    const finish = beginUpdateMaintenance(cfg.dbPath);
    try {
      assert.equal((await c.api("health")).updateMaintenance, true);
      assert.equal(await verifyUpdateIdle(cfg), false, "in-flight metadata defers even with an in-process backend");
      const response = await fetch(c.base + "/api/tasks", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ repoId: c.repo.id, agent: "codex", prompt: "new task" }),
      });
      assert.equal(response.status, 503);
      assert.match((await response.json()).error, /updating/);
      assert.equal((await c.task(task.taskId)).status, "running");
      c.mark("maintenance", ".release");
      await c.waitTask(task.taskId, (task) => task.status === "idle");
      for (const action of ["followup", "steer"]) {
        const blocked = await fetch(c.base + `/api/tasks/${task.taskId}/${action}`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompt: "next", text: "next" }),
        });
        assert.equal(blocked.status, 503, action + " cannot bypass admission");
      }
      if (daemon) assert.equal(await verifyUpdateIdle(cfg), true);
    } finally { finish(); }
    assert.equal(isUpdateMaintenance(cfg.dbPath), false);
    assert.equal((await c.api("health")).updateMaintenance, false);
    await c.api("tasks/" + task.taskId + "/followup", { prompt: JSON.stringify({ key: "after-maintenance", mode: "auto" }) });
    await c.ready("after-maintenance");
    await c.waitTask(task.taskId, (task) => task.status === "idle");
  });
}

for (const agent of ["claude", "codex"]) test(`${agent}: pending question survives graceful restart and answered question stays cleared`, options, async (t) => {
  const c = await harness(t);
  const task = await c.create(agent, "question", "answered-hold");
  const pending = await c.waitTask(task.taskId, (task) => task.status === "awaiting_input");
  const rows = c.rows(task.taskId);
  await c.restart(true);
  assert.deepEqual((await c.task(task.taskId)).pendingInput, pending.pendingInput);
  assert.deepEqual(c.rows(task.taskId), rows);
  await c.api("tasks/" + task.taskId + "/answer", {
    requestId: pending.pendingInput.requestId, answers: [{ question: "Continue?", selected: ["Yes"] }],
  });
  await until("answer received", () => c.rows(task.taskId).some((row) =>
    row.kind === "assistant_text" && JSON.parse(row.payload_json).text === "question:answered"));
  const answered = JSON.parse(readFileSync(c.marker("question", ".answer"), "utf8"));
  if (agent === "claude") assert.equal(answered.response.response.updatedInput.answers["Continue?"], "Yes");
  else assert.deepEqual(answered.result.answers.continue.answers, ["Yes"]);
  const afterAnswer = c.rows(task.taskId);
  await c.restart();
  // A fresh line is an ordering barrier after the daemon's buffered replay.
  c.mark("question", ".ping");
  await until("post-replay event", () => c.rows(task.taskId).some((row) =>
    row.kind === "assistant_text" && JSON.parse(row.payload_json).text === "question:ping"));
  const recovered = await c.task(task.taskId);
  assert.equal(recovered.status, "running");
  assert.equal(recovered.pendingInput, undefined);
  assert.deepEqual(c.rows(task.taskId).filter((row) => row.seq <= afterAnswer.at(-1).seq), afterAnswer);
  c.mark("question", ".release");
  await c.waitTask(task.taskId, (task) => task.status === "idle");
});

for (const backend of [true, "independent"]) for (const agent of ["claude", "codex"]) test(`${agent}: explicit Send, durable editable Queue and Stop share one contract (${backend})`, options, async t => {
  const c = await harness(t, backend);
  const task = await c.create(agent, "initial");
  const messagePath = `tasks/${task.taskId}/messages`;
  const queued = await c.api(messagePath, { clientMessageId: crypto.randomUUID(), mode: "queue", expectedRunId: task.messageQueue.runId,
    text: JSON.stringify({ key: "queued-original", mode: "auto" }) });
  const m = queued.messages[0], token = crypto.randomUUID();
  await c.api(`${messagePath}/${m.id}`, { action: "edit", version: m.version, token });
  // Stop preserves both the queue and the edit hold.
  await c.api(`tasks/${task.taskId}/stop`, {});
  await c.waitTask(task.taskId, t => t.status === "idle");
  await c.restart();
  const saved = await c.api(`${messagePath}/${m.id}`, { action: "save", version: m.version, token,
    text: JSON.stringify({ key: "queued-edited", mode: "auto" }) });
  assert.equal(saved.paused, true);
  assert.equal(saved.messages[0].id, m.id);
  assert(!existsSync(c.marker("queued-original", ".ready")));
  await c.api(`tasks/${task.taskId}/queue/resume`, {});
  await c.ready("queued-edited");
  const final = await c.waitTask(task.taskId, t => t.status === "idle" && !t.messageQueue.messages.length);
  assert.equal(final.sessionId, task.sessionId);

  await c.api(`tasks/${task.taskId}/followup`, { prompt: JSON.stringify({ key: "active-send", mode: "hold" }) });
  await c.ready("active-send");
  const running = await c.task(task.taskId);
  const id = crypto.randomUUID();
  await c.api(messagePath, { clientMessageId: id, mode: "send", expectedRunId: running.messageQueue.runId,
    text: JSON.stringify({ key: "sent-now", mode: "auto" }) });
  await c.waitTask(task.taskId, t => !t.messageQueue.messages.some(m => m.id === id));
  assert(c.rows(task.taskId).some(row => JSON.parse(row.payload_json).messageId === id));
  if (agent === "codex") c.mark("active-send", ".release");
  await c.waitTask(task.taskId, t => t.status === "idle");
});

test("legacy steer and explicit queue serialize their next runs", options, async t => {
  const c = await harness(t);
  const task = await c.create("codex", "mixed-initial");
  await c.api(`tasks/${task.taskId}/messages`, { clientMessageId: crypto.randomUUID(), mode: "queue",
    expectedRunId: task.messageQueue.runId, text: JSON.stringify({ key: "mixed-queued", mode: "auto" }) });
  await c.api(`tasks/${task.taskId}/steer`, { text: JSON.stringify({ key: "mixed-legacy", mode: "hold" }) });
  c.mark("mixed-initial", ".release");
  await c.ready("mixed-legacy");
  assert(!existsSync(c.marker("mixed-queued", ".ready")), "the explicit queue must wait for the legacy run");
  c.mark("mixed-legacy", ".release");
  await c.ready("mixed-queued");
  await c.waitTask(task.taskId, t => t.status === "idle" && !t.messageQueue.messages.length);
});

for (const agent of ["claude", "codex"]) test(`${agent}: independent host survives web replacement, pending input and offline completion`, options, async t => {
  const c = await harness(t, "independent");
  assert.equal((await c.api("health")).executionProtocol, 1);
  const task = await c.create(agent, "independent", "answered-hold");
  const original = await c.ready("independent");
  await c.waitTask(task.taskId, t => t.status === "awaiting_input");
  await c.restart(true);
  process.kill(original.pid, 0);
  assert.deepEqual(await c.ready("independent"), original);
  assert.equal((await c.task(task.taskId)).sessionId, task.sessionId);
  const requestId = (await c.task(task.taskId)).pendingInput.requestId;
  await c.api(`tasks/${task.taskId}/answer`, { requestId, answers: [{ question: "Continue?", selected: ["Yes"] }] });
  await until("original process receives answer", () => existsSync(c.marker("independent", ".answer")));
  await kill(c.web);
  c.mark("independent", ".release");
  await until("provider finishes while view is absent", () => existsSync(c.marker("independent", ".terminal")));
  await c.webStart();
  const final = await c.waitTask(task.taskId, t => t.status === "idle");
  assert.equal(final.sessionId, task.sessionId);
  assert.equal(final.interrupted, false);
  assert.equal(final.pendingInput, undefined);
  for (const text of ["independent:before", "independent:after"]) {
    assert.equal(c.rows(task.taskId).filter(row => row.kind === "assistant_text" && JSON.parse(row.payload_json).text === text).length, 1);
  }
  assert.equal(c.rows(task.taskId).filter(row => row.kind === "result").length, 1);
});

test("independent admission survives web absence and queued Stop prevents a provider launch", options, async t => {
  const c = await harness(t, "independent");
  const first = await c.create("codex", "slot-one");
  const second = await c.create("claude", "slot-two");
  const createQueued = async key => {
    const { task } = await c.api("tasks", { repoId: c.repo.id, agent: "codex", isolate: true, prompt: JSON.stringify({ key, mode: "hold" }) });
    return c.waitTask(task.taskId, task => task.status === "queued");
  };
  const cancelled = await createQueued("never-start");
  await c.api(`tasks/${cancelled.taskId}/stop`, {});
  await c.waitTask(cancelled.taskId, task => task.status === "idle" && task.interrupted);
  const queued = await createQueued("next-slot");
  await kill(c.web);
  c.mark("slot-one", ".release");
  await c.ready("next-slot");
  assert(!existsSync(c.marker("never-start", ".ready")));
  await c.webStart();
  await c.waitTask(first.taskId, task => task.status === "idle");
  await c.waitTask(queued.taskId, task => task.status === "running");
  for (const key of ["slot-two", "next-slot"]) c.mark(key, ".release");
  for (const task of [second, queued]) await c.waitTask(task.taskId, task => task.status === "idle");
});

});


for (const agent of ["claude", "codex"]) test(`${agent}: new attachments remain viewable across delivery, restart and archive`, options, async t => {
  const c = await harness(t, "independent");
  const image = { mediaType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==" };
  const { task } = await c.api("tasks", { repoId: c.repo.id, agent, prompt: JSON.stringify({ key: "image-initial", mode: "hold" }), images: [image] });
  await c.ready("image-initial");
  const dispatch = c.rows(task.taskId).map(row => JSON.parse(row.payload_json)).find(p => p.subtype === "dispatch");
  assert.equal(dispatch.attachments.length, 1);
  const path = c.base + `/api/tasks/${task.taskId}/attachments/${dispatch.attachments[0].id}`;
  const verifyImage = async () => {
    const response = await fetch(path);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(image.data, "base64"));
  };
  await verifyImage();
  const current = await c.task(task.taskId);
  const id = crypto.randomUUID();
  const queued = await c.api(`tasks/${task.taskId}/messages`, { clientMessageId: id, mode: "queue", expectedRunId: current.messageQueue.runId,
    text: JSON.stringify({ key: "image-queued", mode: "auto" }), images: [image] });
  assert.equal(queued.messages[0].images, undefined);
  assert.deepEqual(queued.messages[0].attachments, dispatch.attachments);
  await c.restart(true); await verifyImage();
  c.mark("image-initial", ".release");
  await c.ready("image-queued");
  await c.waitTask(task.taskId, t => t.status === "idle" && !t.messageQueue.messages.length);
  const followup = c.rows(task.taskId).map(row => JSON.parse(row.payload_json)).find(p => p.messageId === id && p.subtype === "followup");
  assert.deepEqual(followup.attachments, dispatch.attachments);
  await c.api(`tasks/${task.taskId}/followup`, { prompt: JSON.stringify({ key: "image-followup", mode: "hold" }), images: [image] });
  await c.ready("image-followup");
  await c.api(`tasks/${task.taskId}/steer`, { text: JSON.stringify({ key: "image-steer", mode: "auto" }), images: [image] });
  assert(c.rows(task.taskId).map(row => JSON.parse(row.payload_json)).some(p => p.subtype === "steer" && p.attachments?.length === 1));
  await c.api(`tasks/${task.taskId}/stop`, {});
  await c.waitTask(task.taskId, t => t.status === "idle");
  const archived = await fetch(c.base + `/api/tasks/${task.taskId}`, { method: "DELETE" });
  assert.equal(archived.status, 200);
  await c.restart(true); await verifyImage();
});
