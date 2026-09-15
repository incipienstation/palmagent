/** Explicit Linux/systemd acceptance test. Uses fixture providers and uniquely
 * named temporary units only; never touches installed Palmagent services. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { loadConfig } from "../src/cli/config.js";
import { pinNode } from "../src/cli/execution-release.js";
import { renderExecutionUnits } from "../src/cli/execution-units.js";
import { ExecutionStore } from "../src/execution/store.js";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const artifact = resolve(process.argv[2] ?? join(repository, "build/pkg"));
assert(existsSync(join(artifact, "execution-host.js")), "Build the package before systemd acceptance");
execFileSync("sudo", ["-n", "true"], { stdio: "pipe" });
const root = mkdtempSync(join(tmpdir(), "palmagent-systemd-test-"));
const label = `palmagent-test-${randomUUID().replaceAll("-", "")}`;
const templateName = `${label}-execution@.service`;
const sliceName = `${label}-executions.slice`;
const webName = `${label}-web.service`;
const unitFiles = [templateName, sliceName].map(name => join("/run/systemd/system", name));
let store: ExecutionStore | undefined;
const command = (...args: string[]) => execFileSync("sudo", ["-n", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const until = async (fn: () => unknown | Promise<unknown>, label: string) => {
  for (let i = 0; i < 500; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 25)); }
  throw new Error(`Timed out: ${label}`);
};
try {
  for (const dir of ["home", "control", "bin", "repo", "data/releases/first"]) mkdirSync(join(root, dir), { recursive: true });
  const pack = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", root], { cwd: artifact, encoding: "utf8" }));
  const prefix = join(root, "data/releases/first");
  execFileSync("npm", ["install", "--prefix", prefix, "--omit=dev", "--no-audit", "--no-fund", join(root, pack[0].filename)], { stdio: "pipe" });
  const pkg = join(prefix, "node_modules/palmagent");
  const cfg = loadConfig({ dataDir: join(root, "data"), pkgDir: pkg });
  Object.assign(cfg, { mode: "package", pkgDir: pkg, workingDir: pkg, concurrency: 2, user: userInfo().username, group: userInfo().username });
  cfg.executionNode = pinNode(cfg.dataDir);
  cfg.execPath = `${join(root, "bin")}:${dirname(process.execPath)}:/usr/bin:/bin`;
  const fixture = join(repository, "apps/server/tests/fixtures/lifecycle-cli.cjs");
  for (const agent of ["claude", "codex"]) writeFileSync(join(root, "bin", agent), `#!${process.execPath}\nprocess.argv.splice(2,0,${JSON.stringify(agent)}); require(${JSON.stringify(fixture)});\n`, { mode: 0o700 });
  writeFileSync(join(root, "bin/sudo"), `#!${process.execPath}
const { execFileSync } = require("node:child_process");
const id = process.argv.at(-1);
if (!/^[a-f0-9-]{36}$/.test(id)) process.exit(2);
execFileSync("/usr/bin/sudo", ["-n", "systemctl", "start", "--no-block", ${JSON.stringify(label + "-execution@")} + id + ".service"]);
`, { mode: 0o700 });
  const units = renderExecutionUnits(cfg, join(pkg, "execution-launcher.js"));
  const template = units.template.replace("Slice=palmagent-executions.slice", `Slice=${sliceName}`) +
    `Environment=HOME=${join(root, "home")}\nEnvironment=PROBE_CONTROL=${join(root, "control")}\n`;
  for (const [i, text] of [template, units.slice].entries()) {
    const file = join(root, i + ".unit"); writeFileSync(file, text);
    command("install", "-m", "0644", file, unitFiles[i]!);
  }
  command("systemctl", "daemon-reload");
  const socket = createServer();
  await new Promise<void>(r => socket.listen(0, "localhost", r));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(r => socket.close(() => r()));
  const env: Record<string, string> = { HOME: join(root, "home"), PATH: cfg.execPath, NODE_ENV: "development", AUTH_DISABLED: "1", HOST: "localhost", PORT: String(port),
    DISPATCH_CONCURRENCY: "2", DISPATCHER_DATA_DIR: cfg.dataDir, DISPATCHER_DB: join(cfg.dataDir, "dispatcher.db"), REPO_ROOTS: join(root, "repo"), EXECUTION_RELEASE: pkg, EXECUTION_NODE: cfg.executionNode! };
  execFileSync("git", ["init", "-b", "main"], { cwd: join(root, "repo"), stdio: "pipe" });
  execFileSync("git", ["-c", "user.name=Validation", "-c", "user.email=validation", "commit", "--allow-empty", "-m", "Fixture"], { cwd: join(root, "repo"), stdio: "pipe" });
  const api = async (route: string, body?: unknown): Promise<any> => {
    const res = await fetch(`http://localhost:${port}/api/${route}`, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(1000) });
    const data = await res.json(); assert(res.ok, JSON.stringify(data)); return data;
  };
  const startWeb = async (release: string) => {
    command("systemd-run", "--quiet", "--collect", `--unit=${webName}`, `--uid=${cfg.user}`, "--property=KillMode=control-group", `--working-directory=${release}`,
      ...Object.entries({ ...env, EXECUTION_RELEASE: release }).map(([k, v]) => `--setenv=${k}=${v}`), cfg.executionNode!, join(release, "server.js"));
    await until(async () => { try { return (await api("health")).executionProtocol === 1; } catch { return false; } }, "web health");
  };
  await startWeb(pkg);
  const repo = (await api("repos", { path: join(root, "repo"), defaultBaseRef: "main" })).repo;
  const running: Array<{ taskId: string; key: string; pid: number; session: string }> = [];
  for (const agent of ["claude", "codex"]) {
    const { task } = await api("tasks", { repoId: repo.id, agent, isolate: true, prompt: JSON.stringify({ key: agent, mode: agent === "claude" ? "answered-hold" : "hold" }) });
    const ready = join(root, "control", agent + ".ready");
    await until(() => existsSync(ready), `${agent} provider starts`);
    running.push({ taskId: task.taskId, key: agent, ...JSON.parse(readFileSync(ready, "utf8")) });
  }
  store = new ExecutionStore(join(cfg.dataDir, "executions"));
  const identities = store.list();
  for (const row of identities) {
    const group = command("systemctl", "show", `${label}-execution@${row.id}.service`, "--property=ControlGroup", "--value").trim();
    assert(group.includes(label + "-execution@"));
    assert(!group.includes(webName));
  }
  command("systemctl", "stop", webName);
  for (const run of running) { process.kill(run.pid, 0); writeFileSync(join(root, "control", run.key + ".ping"), ""); }
  await until(() => identities.every(row => store!.get(row.id).lastSeq > row.lastSeq), "journals advance without web");
  const replacement = join(root, "data/releases/second");
  cpSync(prefix, replacement, { recursive: true });
  await startWeb(join(replacement, "node_modules/palmagent"));
  for (const run of running) {
    process.kill(run.pid, 0);
    const current = (await api(`tasks/${run.taskId}`)).task;
    assert.equal(current.sessionId, run.session);
    if (run.key === "claude") {
      assert.equal(current.pendingInput.requestId, "q1");
      await api(`tasks/${run.taskId}/answer`, { requestId: "q1", answers: [{ question: "Continue?", selected: ["Yes"] }] });
      await until(() => existsSync(join(root, "control/claude.answer")), "original stdin accepts answer");
    }
    writeFileSync(join(root, "control", run.key + ".release"), "");
    await until(async () => (await api(`tasks/${run.taskId}`)).task.status === "idle", `${run.key} completes`);
  }
  assert.deepEqual(store.list().map(row => [row.id, row.pid, row.release]), identities.map(row => [row.id, row.pid, row.release]));
  console.log("PASS: packed execution hosts retained the same Claude/Codex processes, sessions, input channels and artifacts across systemd web replacement");
} finally {
  spawnSync("sudo", ["-n", "systemctl", "stop", webName, `${label}-execution@*.service`, sliceName, `${label}.slice`], { stdio: "pipe" });
  store?.close();
  for (const file of unitFiles) spawnSync("sudo", ["-n", "rm", "-f", file], { stdio: "pipe" });
  spawnSync("sudo", ["-n", "systemctl", "daemon-reload"], { stdio: "pipe" });
  rmSync(root, { recursive: true, force: true });
}
