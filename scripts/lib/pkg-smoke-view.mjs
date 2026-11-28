import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { freePort, smokeEnv } from "./pkg-smoke-runtime.mjs";

// The installed tarball must work under the actual daemon, not only `start`.
// Source lifecycle tests cover auth/SSE policy; this covers retained package paths,
// view restart, queue progress and the daemon's recovery of the API owner.
export async function smokeRetainedView(pkgDir, scratch, parent, inspect) {
  const root = join(scratch, "retained");
  const data = join(root, "data"), release = join(data, "releases/fixture");
  for (const path of [root, data, release, join(data, "daemon"), join(data, "runtimes"),
    ...["home", "cache", "tmp", "bin", "repo", "control"].map(part => join(root, part))]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  cpSync(pkgDir, release, { recursive: true });
  symlinkSync(join(scratch, "node_modules"), join(release, "node_modules"));
  const node = join(data, "runtimes/node");
  copyFileSync(process.execPath, node);
  const port = await freePort();
  const env = { ...smokeEnv(parent, root, port), PATH: join(root, "bin") + ":" + dirname(node) + ":/usr/bin:/bin",
    PALMAGENT_HOME: join(root, "home/.palmagent"), STATIC_DIR: join(release, "web"),
    EXECUTION_RELEASE: release, EXECUTION_NODE: node, REPO_ROOTS: join(root, "repo"),
    PALMAGENT_CODEX_TRANSPORT: "native", PROBE_CONTROL: join(root, "control"), DISPATCH_CONCURRENCY: "2", PALMAGENT_EXECUTION_CONCURRENCY: "2" };
  delete env.AUTH_DISABLED;
  Object.assign(env, { AUTH_ENABLED: "1", AUTH_RP_ID: "fixture.example", AUTH_ORIGIN: "https://fixture.example" });
  const session = crypto.randomUUID();
  const authenticated = { cookie: `palmagent_session=${session}`, origin: env.AUTH_ORIGIN };
  const fixture = resolve(dirname(fileURLToPath(import.meta.url)), "../../apps/server/tests/support/lifecycle-cli.cjs");
  for (const agent of ["codex", "claude"]) writeFileSync(join(root, "bin", agent),
    `#!${node}\nprocess.argv.splice(1, 1, ${JSON.stringify(fixture)}, ${JSON.stringify(agent)}); require(${JSON.stringify(fixture)});\n`, { mode: 0o700 });
  execFileSync("git", ["init", "-b", "main"], { cwd: join(root, "repo"), env, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Validation", "-c", "user.email=validation", "commit", "--allow-empty", "-m", "Synthetic fixture"],
    { cwd: join(root, "repo"), env, stdio: "ignore" });
  const daemon = join(release, "daemon", `${process.platform}-${process.arch}`, "palmagentd");
  writeFileSync(join(data, "daemon/config.json"), JSON.stringify({ protocol: 1, daemon, release, node, environment: env,
    isolation: "process-group", limits: { memoryHigh: 1073741824, memoryMax: 2147483648, tasks: 256, webTasks: 128, cpuPercent: 100, nofile: 65536 } }), { mode: 0o600 });
  const child = spawn(daemon, ["serve", "--data-dir", data], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { logs = (logs + chunk).slice(-16000); });
  const exited = new Promise(resolve => child.once("exit", resolve));
  const command = request => JSON.parse(execFileSync(daemon, ["request", "--data-dir", data],
    { cwd: root, env, input: JSON.stringify(request), encoding: "utf8", timeout: 40000, stdio: ["pipe", "pipe", "pipe"] }));
  const view = action => JSON.parse(execFileSync(node, [join(release, "cli.js"), "view", action, "--data-dir", data],
    { cwd: root, env, encoding: "utf8", timeout: 25000, stdio: ["ignore", "pipe", "pipe"] }));
  const until = async (label, predicate) => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      assert.equal(child.exitCode, null, logs);
      const value = await predicate(); if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out: ${label}\n${logs}`);
  };
  const base = `http://localhost:${port}`;
  const api = async (path, body) => {
    const response = await fetch(base + "/api/" + path, { method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", ...authenticated }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(3000) });
    const result = await response.json(); assert(response.ok, JSON.stringify(result)); return result;
  };
  // A pooled connection can belong to the retired owner or gateway. Reconnect
  // for transition reads, while leaving every mutation a single attempt.
  const afterSwitch = (label, path) => until(label, async () => {
    let response;
    try {
      response = await fetch(base + "/api/" + path, { headers: authenticated, signal: AbortSignal.timeout(3000) });
      if (response.status === 503 || response.status === 202) { await response.body?.cancel(); return false; }
      const result = await response.json();
      assert(response.ok, JSON.stringify(result));
      return result;
    } catch (error) {
      if (["UND_ERR_SOCKET", "ECONNRESET", "ECONNREFUSED", "EPIPE"].includes(error.cause?.code)) return false;
      throw error;
    }
  });
  const fixtureSql = sql => execFileSync(node, ["-e",
    'const db = require("better-sqlite3")(process.env.DISPATCHER_DB); db.exec(process.argv[1]); db.close()', sql],
    { cwd: release, env });
  const mark = (key, suffix) => writeFileSync(join(root, "control", key + suffix), "");
  let taskId, paused, gateway;
  try {
    await until("packaged API readiness", async () => {
      try { return (await api("health")).ok; } catch { return false; }
    });
    execFileSync(node, ["-e", `
      const db = require("better-sqlite3")(process.env.DISPATCHER_DB);
      db.prepare("INSERT INTO auth_sessions(token,created_at,expires_at) VALUES(?,?,?)").run(process.argv[1],Date.now(),Date.now()+600000);
      db.close();
    `, session], { cwd: release, env });
    const before = view("status");
    assert.equal(before.state, "ready");
    assert.equal(command({ action: "status" }).web.child.pid, before.ownerPid);
    const shell = await (await fetch(base)).text();
    assert(shell.includes('<div id="root"'));
    const repo = (await api("repos", { path: join(root, "repo"), defaultBaseRef: "main" })).repo;
    const prompt = JSON.stringify({ key: "packed-a", mode: "hold" });
    const { routine } = await api("routines", { repoId: repo.id, agent: "codex", prompt, preset: "manual" });
    // Force a lost acknowledgement after real Task creation; the replacement owner must
    // attach the run history to the existing Task without starting a second execution.
    fixtureSql("CREATE TRIGGER hold_dispatch BEFORE UPDATE OF dispatch_json ON routine_runs WHEN OLD.dispatch_json IS NOT NULL BEGIN SELECT RAISE(ABORT,'hold receipt'); END;");
    await api(`routines/${routine.id}/run`, {});
    const matchingTasks = async () => (await api("tasks")).tasks.filter(task => task.prompt === prompt);
    const [task] = await matchingTasks();
    taskId = task.taskId;
    assert.ok(task.worktreePath && task.worktreePath !== repo.path);
    assert.equal((await api(`routines/${routine.id}/runs`)).runs[0].taskId, undefined);
    await until("packaged provider starts", () => existsSync(join(root, "control/packed-a.ready")));
    await api(`tasks/${taskId}/messages`, { clientMessageId: crypto.randomUUID(), mode: "queue", expectedRunId: null,
      text: JSON.stringify({ key: "packed-b", mode: "auto" }) });
    paused = before.pid; process.kill(paused, "SIGSTOP");
    await assert.rejects(fetch(base, { signal: AbortSignal.timeout(100) }));
    mark("packed-a", ".release");
    await until("packaged queue advances during view stall", () => existsSync(join(root, "control/packed-b.ready")));
    await api(`tasks/${taskId}/messages`, { clientMessageId: crypto.randomUUID(), mode: "queue", expectedRunId: null,
      text: JSON.stringify({ key: "packed-c", mode: "auto" }) });
    await until("packaged admission during view stall", () => existsSync(join(root, "control/packed-c.ready")));
    const next = view("restart"); paused = undefined;
    assert.equal(next.ownerPid, before.ownerPid); assert.notEqual(next.pid, before.pid);
    assert.equal(await (await fetch(base)).text(), shell);
    await until("packaged Task becomes idle", async () => (await api(`tasks/${taskId}`)).task.status === "idle");
    if (inspect) await inspect({ base, view, taskId, api });
    process.kill(next.ownerPid, "SIGSTOP");
    fixtureSql("DROP TRIGGER hold_dispatch");
    process.kill(next.ownerPid, "SIGKILL");
    const recovered = await until("daemon recovers API owner", async () => {
      try { const state = view("status"); return state.state === "ready" && state.ownerPid !== next.ownerPid && state; }
      catch { return false; }
    });
    assert.equal(command({ action: "status" }).web.child.pid, recovered.ownerPid);
    assert.equal((await afterSwitch("recovered owner serves Task", `tasks/${taskId}`)).task.status, "idle");
    assert.equal(await (await fetch(base)).text(), shell);
    const { runs } = await api(`routines/${routine.id}/runs`);
    assert.deepEqual(runs.map(run => [run.status, run.taskId]), [["manual", taskId]]);
    assert.deepEqual((await matchingTasks()).map(task => task.taskId), [taskId]);
    const configPath = join(data, "daemon/config.json");
    const nextRelease = join(data, "releases/candidate");
    cpSync(pkgDir, nextRelease, { recursive: true });
    symlinkSync(join(scratch, "node_modules"), join(nextRelease, "node_modules"));
    const active = (await api("tasks", { repoId: repo.id, agent: "codex",
      prompt: JSON.stringify({ key: "packed-handoff-active", mode: "hold" }) })).task;
    taskId = active.taskId;
    const readyPath = key => join(root, "control", key + ".ready");
    await until("retained execution before activation", () => existsSync(readyPath("packed-handoff-active")));
    const oldSession = (await api("tasks/" + taskId)).task.sessionId;
    gateway = spawn(node, [join(release, "update-gateway.js")], { cwd: release, env, stdio: ["ignore", "ignore", "inherit", "ipc"] });
    await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("Packaged gateway readiness timeout")), 10000);
      gateway.once("message", value => { clearTimeout(deadline); if (value?.ready === 1) resolve(); else reject(new Error("Invalid gateway readiness")); });
      gateway.once("exit", () => { clearTimeout(deadline); reject(new Error("Packaged gateway stopped")); });
    });
    const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
    const identity = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() + ":" + stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    const marker = join(data, "update-maintenance.json");
    writeFileSync(marker, JSON.stringify({ schemaVersion: 1, pid: process.pid, identity, token: crypto.randomUUID(), handoff: 1 }), { mode: 0o600 });
    const id = crypto.randomUUID();
    const admitted = await fetch(base + `/api/tasks/${taskId}/messages`, { method: "POST",
      headers: { ...authenticated, "content-type": "application/json", prefer: "respond-async" },
      body: JSON.stringify({ clientMessageId: id, mode: "queue", expectedRunId: null, text: JSON.stringify({key: "packed-handoff-next", mode: "auto"}) }) });
    assert.equal(admitted.status, 202);
    assert.deepEqual(await admitted.json(), { state: "accepted", requestId: id });
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const priorDaemon = command({ action: "status" }).instance;
    config.release = nextRelease;
    config.daemon = join(nextRelease, "daemon", `${process.platform}-${process.arch}`, "palmagentd");
    Object.assign(config.environment, { EXECUTION_RELEASE: nextRelease, STATIC_DIR: join(nextRelease, "web") });
    writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
    command({ action: "replace" });
    await until("replacement daemon", () => { try { return command({ action: "status" }).instance !== priorDaemon; } catch { return false; } });
    command({ action: "restart-web" });
    assert.notEqual(view("status").ownerPid, recovered.ownerPid);
    assert.equal((await afterSwitch("replacement serves original session", "tasks/" + taskId)).task.sessionId, oldSession);
    rmSync(marker);
    const gatewayClosed = new Promise(resolve => gateway.once("exit", resolve));
    gateway.disconnect();
    await gatewayClosed;
    await afterSwitch("installed owner applies durable receipt", `tasks/${taskId}/messages/${id}/receipt`);
    mark("packed-handoff-active", ".release");
    await until("queued message on replacement", () => existsSync(readyPath("packed-handoff-next")));
    await until("replacement execution completes", async () => (await api("tasks/" + taskId)).task.status === "idle");
    console.log("[smoke] installed daemon and Task owner replaced across retained releases with active execution and durable admission");
    console.log("[smoke] packaged retained API: stalled-view queue/admission, view restart, daemon owner recovery passed");
  } finally {
    if (gateway && gateway.exitCode === null && gateway.signalCode === null) gateway.kill("SIGKILL");
    if (paused) { try { process.kill(paused, "SIGCONT"); } catch {} }
    if (taskId) { try { await api(`tasks/${taskId}/stop`, {}); } catch {} }
    // Stop any owned active provider hosts before the supervisor can shut down.
    const hosts = join(data, "daemon/hosts");
    for (const name of existsSync(hosts) ? readdirSync(hosts).filter(name => name.endsWith(".json")) : []) {
      const record = JSON.parse(readFileSync(join(hosts, name), "utf8"));
      if (!["execution", "terminal", "routine", "update"].includes(record.kind)) continue;
      try { command({ action: "terminate", kind: record.kind, id: record.id }); } catch {}
    }
    try { command({ action: "stop" }); }
    finally {
      const force = setTimeout(() => child.kill("SIGKILL"), 5000);
      await exited; clearTimeout(force);
      // A failed stop must not leave detached guardians after scratch removal.
      // Match start identity before signaling only this fixture's recorded hosts.
      const signalOwned = (identity, group) => {
        if (!identity) return;
        try {
          const stat = readFileSync(`/proc/${identity.pid}/stat`, "utf8");
          const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
          const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
          if (`${boot}:${fields[19]}` === identity.start && !["Z", "X"].includes(fields[0])) {
            process.kill(group ? -identity.pid : identity.pid, "SIGKILL");
          }
        } catch (error) { if (!["ENOENT", "ESRCH"].includes(error.code)) throw error; }
      };
      for (const directory of [hosts, join(data, "daemon/services")]) {
        for (const name of existsSync(directory) ? readdirSync(directory).filter(name => name.endsWith(".json")) : []) {
          const record = JSON.parse(readFileSync(join(directory, name), "utf8"));
          signalOwned(record.guard, false);
          signalOwned(record.child, true);
        }
      }
      const socketRoot = join("/tmp", `palmagentd-${process.getuid()}-${createHash("sha256").update(data).digest("hex").slice(0, 20)}`);
      rmSync(socketRoot, { recursive: true, force: true });
    }
  }
}
