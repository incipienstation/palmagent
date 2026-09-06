import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import Database from "better-sqlite3";

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

async function freePort() {
  return new Promise((resolve, reject) => {
    const socket = createServer();
    socket.on("error", reject);
    socket.listen(0, "localhost", () => {
      const port = socket.address().port;
      socket.close(() => resolve(port));
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
  if (daemon) env.RUNNER_SOCKET = join(dir, "runner.sock");
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
  c.restart = async () => { await kill(c.web); await c.webStart(); };
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
  if (daemon) {
    c.runner = c.start("runner-daemon");
    await until("runner socket", () => existsSync(env.RUNNER_SOCKET));
  }
  await c.webStart();
  db = new Database(env.DISPATCHER_DB, { readonly: true });
  c.repo = (await c.api("repos", { path: join(dir, "repo"), defaultBaseRef: "main" })).repo;
  return c;
}

async function replay(c, taskId, cursor, global = false) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1000);
  const ids = [];
  let buffer = "";
  try {
    const response = await fetch(c.base + "/api/stream" + (global ? "" : "?task=" + taskId), {
      headers: { "Last-Event-ID": String(cursor) }, signal: controller.signal,
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
      }
    }
  } catch (error) {
    if (error.name !== "AbortError") throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return ids;
}

for (const agent of ["claude", "codex"]) {
  test(`${agent}: web crash preserves CLI and replays events once`, options, async (t) => {
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
    assert.deepEqual(await replay(c, task.taskId, 2), rows.filter((row) => row.seq > 2).map((row) => row.seq));
    assert.deepEqual(await replay(c, task.taskId, 2, true), rows.filter((row) => row.id > 2).map((row) => row.id));
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

test("Claude: pending question survives restart and answered question stays cleared", options, async (t) => {
  const c = await harness(t);
  const task = await c.create("claude", "question", "answered-hold");
  const pending = await c.waitTask(task.taskId, (task) => task.status === "awaiting_input");
  const rows = c.rows(task.taskId);
  await c.restart();
  assert.deepEqual((await c.task(task.taskId)).pendingInput, pending.pendingInput);
  assert.deepEqual(c.rows(task.taskId), rows);
  await c.api("tasks/" + task.taskId + "/answer", {
    requestId: "q1", answers: [{ question: "Continue?", selected: ["Yes"] }],
  });
  await until("answer received", () => c.rows(task.taskId).some((row) =>
    row.kind === "assistant_text" && JSON.parse(row.payload_json).text === "question:answered"));
  const answered = JSON.parse(readFileSync(c.marker("question", ".answer"), "utf8"));
  assert.equal(answered.response.response.updatedInput.answers["Continue?"], "Yes");
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
