import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { cpus, loadavg, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { Db } from "../../../src/composition/database.ts";
import { processIdentity } from "../../../src/platform/process/identity.ts";
import { listen, proxyServer } from "./proxy.mjs";

// Manual Linux experiment. Real TaskService/HTTP/SQLite/execution hosts; fake CLIs.
const here = dirname(fileURLToPath(import.meta.url));
const serverDir = resolve(here, "../../..");
const root = resolve(serverDir, "../..");
const fixture = join(serverDir, "tests/support/lifecycle-cli.cjs");
const layouts = ["coupled", "retained-web-gated", "retained-stable-api"];
const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
}
const rounds = Number(option("--rounds", "3"));
const outageMs = Number(option("--outage-ms", "8000"));
const output = option("--out");
assert.equal(process.platform, "linux", "RSS and process identity require Linux");
assert(Number.isInteger(rounds) && rounds > 0 && rounds <= 10);
assert(Number.isInteger(outageMs) && outageMs >= 3000 && outageMs <= 30000);
assert(output && !existsSync(output), "--out must name a new result file");
for (let i = 0; i < args.length; i += 2) {
  assert(["--rounds", "--outage-ms", "--out"].includes(args[i]) && args[i + 1], "Unknown/missing option");
}
let interrupted = false;
const interrupt = () => { interrupted = true; };
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
const checkInterrupted = () => { if (interrupted) throw new Error("Experiment interrupted"); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const rounded = n => Math.round(n * 10) / 10;
async function until(label, fn, timeout = 30000) {
  const end = performance.now() + timeout;
  while (performance.now() < end) {
    checkInterrupted();
    const value = await fn();
    if (value) return value;
    await delay(25);
  }
  throw new Error("Timed out: " + label);
}
async function kill(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => child.once("exit", resolve));
}
function resources(groups) {
  const totals = Object.fromEntries(Object.keys(groups).map(key => [key, { rssMiB: 0, processes: 0 }]));
  for (const pid of readdirSync("/proc").filter(name => /^\d+$/.test(name))) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const group = Number(fields[2]);
      const rssKiB = Number(/^VmRSS:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1] ?? 0);
      for (const [key, ids] of Object.entries(groups)) if (ids.includes(group)) {
        totals[key].rssMiB += rssKiB / 1024;
        totals[key].processes++;
      }
    } catch (error) { if (!["ENOENT", "ESRCH"].includes(error.code)) throw error; }
  }
  for (const value of Object.values(totals)) value.rssMiB = rounded(value.rssMiB);
  return totals;
}

async function sample(layout, round) {
  const dir = mkdtempSync(join(tmpdir(), "palmagent-boundary-"));
  const children = [];
  const logs = [];
  let db, executions, ingress, owner, web;
  const mark = (key, suffix) => join(dir, "control", key + suffix);
  const marker = key => existsSync(mark(key, ".ready")) && JSON.parse(readFileSync(mark(key, ".ready"), "utf8"));
  const release = key => writeFileSync(mark(key, ".release"), "");
  try {
    for (const part of ["bin", "home", "control", "repo", "state"]) mkdirSync(join(dir, part));
    for (const agent of ["codex", "claude"]) writeFileSync(join(dir, "bin", agent),
      `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} ${agent} "$@"\n`, { mode: 0o700 });
    const reservation = proxyServer(() => 0);
    const ownerPort = await listen(reservation);
    await new Promise(resolve => reservation.close(resolve));
    const env = {
      PATH: `${join(dir, "bin")}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: join(dir, "home"),
      LANG: "C.UTF-8", NODE_ENV: "development", HOST: "localhost", PORT: String(ownerPort),
      AUTH_ENABLED: "1", AUTH_RP_ID: "fixture.example", AUTH_ORIGIN: "https://fixture.example",
      DISPATCHER_DATA_DIR: join(dir, "state"), DISPATCHER_DB: join(dir, "state/palmagent.db"),
      REPO_ROOTS: join(dir, "repo"), CODEX_HOME: join(dir, "home/codex"), CLAUDE_CONFIG_DIR: join(dir, "home/claude"),
      PROBE_CONTROL: join(dir, "control"), DISPATCH_CONCURRENCY: "2", PALMAGENT_EXECUTION_CONCURRENCY: "2",
      EXECUTION_RELEASE: serverDir, EXECUTION_NODE: process.execPath,
    };
    // Same sibling-host fixture as lifecycle contracts. This never invokes host sudo/systemd.
    writeFileSync(join(dir, "bin/sudo"), `#!${process.execPath}
const { spawn } = require("node:child_process");
const { openSync } = require("node:fs");
const log = openSync(${JSON.stringify(join(dir, "execution.log"))}, "a");
spawn(process.execPath, ["--import", "tsx", ${JSON.stringify(join(serverDir, "src/bootstrap/execution-host.ts"))}, ${JSON.stringify(join(dir, "state/executions"))}, process.argv.at(-1)], { cwd: ${JSON.stringify(serverDir)}, env: process.env, detached: true, stdio: ["ignore", log, log] }).unref();
`, { mode: 0o700 });
    const git = args => execFileSync("git", args, { cwd: join(dir, "repo"), env, stdio: "pipe" });
    git(["init", "-b", "main"]);
    git(["-c", "user.name=Validation", "-c", "user.email=validation", "commit", "--allow-empty", "-m", "Synthetic fixture"]);
    const token = randomUUID(), expiredToken = randomUUID();
    const seed = new Db(env.DISPATCHER_DB);
    seed.createSession(token, Date.now(), Date.now() + 3600000);
    seed.createSession(expiredToken, Date.now() - 60000, Date.now() - 1000);
    seed.close();
    const start = (argv, ipc = false) => {
      const child = spawn(process.execPath, argv, { cwd: serverDir, env, detached: true,
        stdio: ["ignore", "pipe", "pipe", ...(ipc ? ["ipc"] : [])] });
      child.stdout.on("data", data => logs.push(data.toString()));
      child.stderr.on("data", data => logs.push(data.toString()));
      children.push(child);
      return child;
    };
    let webPort;
    const ownerStart = async () => {
      owner = start(["--import", "tsx", "src/bootstrap/server.ts"]);
      await until("owner health", async () => {
        assert(owner.exitCode === null && owner.signalCode === null, "owner exited");
        try { return (await fetch(`http://localhost:${ownerPort}/api/health`, { signal: AbortSignal.timeout(1000) })).ok; }
        catch { return false; }
      });
    };
    const webStart = async () => {
      web = start([join(here, "proxy.mjs"), String(ownerPort)], true);
      webPort = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("proxy startup timed out")), 10000);
        web.once("message", msg => { clearTimeout(timeout); resolve(msg.port); });
        web.once("error", error => { clearTimeout(timeout); reject(error); });
        web.once("exit", () => { clearTimeout(timeout); reject(new Error("proxy exited")); });
      });
    };
    const startup = performance.now();
    await ownerStart();
    if (layout !== "coupled") await webStart();
    const initialReadyMs = rounded(performance.now() - startup);
    ingress = proxyServer(url => layout === "coupled" || (layout === "retained-stable-api" && url.startsWith("/api/")) ? ownerPort : webPort);
    const port = await listen(ingress);
    const request = async (route, body, cookie = token, origin = "https://fixture.example") => {
      const response = await fetch(`http://localhost:${port}/api/${route}`, {
        method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", origin,
          cookie: `palmagent_session=${cookie}` }, body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(3000),
      });
      return { status: response.status, data: await response.json() };
    };
    const api = async (route, body) => {
      const response = await request(route, body);
      assert(response.status >= 200 && response.status < 300, `${route}: ${JSON.stringify(response)}`);
      return response.data;
    };
    const task = async id => (await api("tasks/" + id)).task;
    const waitIdle = id => until("task idle", async () => (await task(id)).status === "idle");
    const auth = async () => {
      const statuses = { missing: (await request("tasks", undefined, "")).status,
        expired: (await request("tasks", undefined, expiredToken)).status,
        wrongOrigin: (await request("tasks", {}, token, "https://other.example")).status };
      assert.deepEqual(statuses, { missing: 401, expired: 401, wrongOrigin: 403 });
      return statuses;
    };
    await auth();
    db = new Database(env.DISPATCHER_DB, { readonly: true });
    const repo = (await api("repos", { path: join(dir, "repo"), defaultBaseRef: "main" })).repo;
    const create = async (agent, key, mode = "hold") => (await api("tasks", { repoId: repo.id, agent,
      prompt: JSON.stringify({ key, mode }), isolate: true })).task;
    const a = await create("codex", "a");
    const aProcess = await until("a ready", () => marker("a"));
    await until("a running", async () => (await task(a.taskId)).status === "running");
    const b = await create("claude", "b");
    const bProcess = await until("b ready", () => marker("b"));
    await until("b running", async () => (await task(b.taskId)).status === "running");
    const aIdentity = processIdentity(aProcess.pid), bIdentity = processIdentity(bProcess.pid);
    assert(aIdentity && bIdentity);
    const message = key => ({ clientMessageId: randomUUID(), mode: "queue", expectedRunId: null,
      text: JSON.stringify({ key, mode: "auto" }) });
    const d = message("d"), e = message("e");
    await api(`tasks/${a.taskId}/messages`, d);
    const c = await create("codex", "c", "auto");
    await until("c reserved", async () => (await task(c.taskId)).status === "queued");
    executions = new Database(join(dir, "state/executions/executions.sqlite"), { readonly: true });
    const groups = executions.prepare("SELECT pid FROM executions WHERE pid IS NOT NULL").all().map(row => row.pid);
    const memory = resources({ owner: [owner.pid], view: web ? [web.pid] : [], executions: groups });
    const hostLoad = loadavg().map(rounded);
    await kill(layout === "coupled" ? owner : web);
    assert.equal(processIdentity(aProcess.pid), aIdentity);
    assert.equal(processIdentity(bProcess.pid), bIdentity);
    const absentViewStatus = (await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(3000) })).status;
    assert.equal(absentViewStatus, 503);
    const downAt = performance.now();
    release("a");
    const during = await request(`tasks/${a.taskId}/messages`, e);
    assert.equal(during.status, layout === "retained-stable-api" ? 202 : 503);
    const offlineAuth = layout === "retained-stable-api" ? await auth() : null;
    let cStartedMs = null, dStartedMs = null;
    while (performance.now() - downAt < outageMs) {
      checkInterrupted();
      if (cStartedMs === null && marker("c")) cStartedMs = rounded(performance.now() - downAt);
      if (dStartedMs === null && marker("d")) dStartedMs = rounded(performance.now() - downAt);
      await delay(25);
    }
    assert(cStartedMs !== null, "reserved execution must start without view");
    assert.equal(dStartedMs !== null, layout !== "coupled", "follow-up queue ownership");
    assert(existsSync(mark("c", ".terminal")), "reserved execution must finish without view");
    assert.equal(existsSync(mark("d", ".terminal")), layout !== "coupled");
    assert.equal(existsSync(mark("e", ".terminal")), layout === "retained-stable-api");
    const duringOutage = { absentViewStatus, reservedExecutionCompleted: true,
      followupCompleted: existsSync(mark("d", ".terminal")), newMessageCompleted: existsSync(mark("e", ".terminal")),
      reservedExecutionStarted: cStartedMs !== null, followupStarted: dStartedMs !== null,
      submissionStatus: during.status, auth: offlineAuth };
    const restartAt = performance.now();
    if (layout === "coupled") await ownerStart(); else await webStart();
    await api("health");
    const restartReadyMs = rounded(performance.now() - restartAt);
    if (dStartedMs === null) { await until("d ready after restart", () => marker("d")); dStartedMs = rounded(performance.now() - downAt); }
    // Retry the same HTTP submission identity after both failed and successful responses.
    await api(`tasks/${a.taskId}/messages`, e);
    await until("e ready", () => marker("e"));
    await waitIdle(a.taskId);
    await waitIdle(c.taskId);
    assert.equal(marker("d").session, aProcess.session);
    assert.equal(marker("e").session, aProcess.session);
    assert.equal(processIdentity(bProcess.pid), bIdentity);
    release("b");
    await waitIdle(b.taskId);
    const events = db.prepare("SELECT kind,payload_json FROM events WHERE task_id=? ORDER BY seq").all(a.taskId);
    const text = events.filter(row => row.kind === "assistant_text").map(row => JSON.parse(row.payload_json).text);
    assert.deepEqual(text, ["a:before", "a:after", "d:before", "e:before"], "FIFO and exactly one output per turn");
    assert.equal(events.filter(row => row.kind === "result").length, 3, "exactly one terminal result per turn");
    await auth();
    return { round, layout, initialReadyMs, restartReadyMs, cStartedMs, dStartedMs,
      outageMs, duringOutage, memory, hostLoad, assertions: { sameProviderSurvived: true,
        sessionPreserved: true, fifo: true, duplicateSubmissionSingleTurn: true, recovered: true } };
  } catch (error) {
    // Private logs stay outside the checkout; do not export them as measurements.
    writeFileSync(join(dir, "owner.log"), logs.join(""));
    console.error("Failed fixture logs:", dir);
    throw error;
  } finally {
    if (ingress) { ingress.closeAllConnections(); await new Promise(resolve => ingress.close(resolve)); }
    await Promise.all(children.map(kill));
    const path = join(dir, "state/executions/executions.sqlite");
    const cleanupDb = executions ?? (existsSync(path) ? new Database(path, { readonly: true }) : undefined);
    if (cleanupDb) {
      for (const { pid, identity } of cleanupDb.prepare("SELECT pid,identity FROM executions WHERE pid IS NOT NULL").all()) {
        if (!identity || processIdentity(pid) !== identity) continue;
        try { process.kill(-pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      }
      cleanupDb.close();
    }
    db?.close();
    if (!existsSync(join(dir, "owner.log"))) rmSync(dir, { recursive: true, force: true });
  }
}

const inputs = ["apps/server/tests/support/task-runtime/run.mjs", "apps/server/tests/support/task-runtime/proxy.mjs", "apps/server/tests/support/lifecycle-cli.cjs"];
const results = { schema: 1, measuredAt: new Date().toISOString(),
  sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  serverSourceTree: execFileSync("git", ["rev-parse", "HEAD:apps/server/src"], { cwd: root, encoding: "utf8" }).trim(),
  inputs: Object.fromEntries(inputs.map(path => [path, createHash("sha256").update(readFileSync(join(root, path))).digest("hex")])),
  environment: { node: process.version, platform: process.platform, arch: process.arch, cpus: cpus().length },
  method: { rounds, outageMs, pollingMs: 25, rss: "sum of process RSS; shared pages may be counted repeatedly; excludes common driver/ingress" }, samples: [] };
for (let round = 0; round < rounds; round++) {
  for (let index = 0; index < layouts.length; index++) {
    const layout = layouts[(index + round) % layouts.length];
    const result = await sample(layout, round + 1);
    results.samples.push(result);
    console.log(JSON.stringify(result));
  }
}
writeFileSync(output, JSON.stringify(results, null, 2) + "\n", { flag: "wx", mode: 0o600 });
console.log(`Completed ${results.samples.length} samples`);
