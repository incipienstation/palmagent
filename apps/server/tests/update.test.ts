import Database from "better-sqlite3";
import { createServer } from "node:net";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { checkUpdateAccess, readUpdateAccess, requestUpdateAccess, validUpdateRequest, clearUpdateRequest } from "../src/cli/update-access.js";
import { planUpdate, readPluginVersions, resolveUpdatePlan } from "../src/cli/update-plan.js";
import { acquireUpdateLock, readUpdateReceipt, writeUpdateReceipt } from "../src/cli/update-state.js";
import { autoUpdateService, startRequestedUpdate, retireAutoUpdateTimer, renderAutoUpdateUnits } from "../src/cli/auto-update.js";
import { DEFAULT_CAPS, loadConfig, saveConfig, type InstallConfig } from "../src/cli/config.js";
import { getUserConfig, setUserAutoUpdate, setUserChannel, userConfigPath } from "../src/cli/user-config.js";
import { beginUpdateMaintenance, isUpdateMaintenance, maintenancePath } from "../src/update-maintenance.js";
import { ExecutionStore } from "../src/execution/store.js";
import { update, setup, prepareIndependentRuntime, type Flags } from "../src/cli/install.js";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "palmagent-updates-"));
  const env = { ...process.env };
  const pkg = join(root, "palmagent");
  const dataDir = join(root, "state");
  mkdirSync(pkg); mkdirSync(dataDir); mkdirSync(join(root, "bin"));
  process.env.PALMAGENT_HOME = join(root, "preferences");
  process.env.PATH = join(root, "bin") + ":" + process.env.PATH;
  process.env.TEST_UPDATE_ROOT = root;
  t.after(() => { process.env = env; rmSync(root, { recursive: true, force: true }); });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ version: "0.1.0-alpha.2" }));
  const cfg: InstallConfig = {
    mode: "package", user: "palmagent", group: "palmagent", dataDir,
    pkgDir: pkg, workingDir: pkg, runnerSocket: join(dataDir, "runner.sock"), dbPath: join(dataDir, "palmagent.db"),
    execPath: "/usr/bin:/bin", domain: "palmagent.example.com", host: "localhost", port: 4100, concurrency: 2,
    rpId: "palmagent.example.com", rpName: "Palmagent", authOrigin: "https://palmagent.example.com", caps: DEFAULT_CAPS,
    pushSubject: "", repoRoots: "", claudeConfigDir: "",
  };
  saveConfig(cfg);
  setUserChannel("preview");
  const manifest = join(root, "plugin.json");
  writeFileSync(manifest, JSON.stringify({ name: "palmagent", version: "0.1.0-alpha.1" }));
  const calls = join(root, "calls.jsonl");
  writeFileSync(join(root, "bin", "sudo"), `#!${process.execPath}
require('node:fs').appendFileSync(require('node:path').join(process.env.TEST_UPDATE_ROOT, 'host.jsonl'), JSON.stringify(process.argv.slice(2)) + '\\n');
`, { mode: 0o700 });
  writeFileSync(join(root, "bin", "systemctl"), `#!${process.execPath}
const args = process.argv.slice(2);
require('node:fs').appendFileSync(require('node:path').join(process.env.TEST_UPDATE_ROOT, 'host.jsonl'), JSON.stringify(['systemctl', ...args]) + '\\n');
process.exit(args.join(' ') === 'is-active --quiet palmagent-runner.service' ? 0 : 1);
`, { mode: 0o700 });
  writeFileSync(join(root, "bin", "curl"), `#!${process.execPath}\nconsole.log(JSON.stringify({ ok: true, build: { version: process.env.TEST_UPDATE_HEALTH || '0.1.0-alpha.2' } }));\n`, { mode: 0o700 });
  writeFileSync(join(root, "bin", "npm"), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
fs.appendFileSync(path.join(process.env.TEST_UPDATE_ROOT, 'calls.jsonl'), JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.argv[2] === 'view') console.log(JSON.stringify((process.argv[3] === 'palmagent@next' && process.env.TEST_UPDATE_TAG_TARGET) || process.env.TEST_UPDATE_TARGET || '0.1.0-alpha.3'));
else if (process.argv[2] === 'root') console.log(process.env.TEST_UPDATE_ROOT);
else if (process.argv[2] === 'install' && process.env.TEST_UPDATE_INSTALL === 'success') {
  const pkg = path.join(process.env.TEST_UPDATE_ROOT, 'palmagent');
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ version: process.env.TEST_UPDATE_TARGET || '0.1.0-alpha.3' }));
  fs.writeFileSync(path.join(pkg, 'cli.js'), "const fs = require('node:fs'); const path = require('node:path'); if (process.argv[2] === '--version') console.log(require('./package.json').version); else fs.writeFileSync(path.join(process.env.TEST_UPDATE_ROOT, 'activation.json'), JSON.stringify({ args: process.argv.slice(2), sentinel: process.env.PALMAGENT_UPDATE_POST_UPGRADE }));");
}
else process.exit(1);
`, { mode: 0o700 });
  const flags: Flags = { dryRun: false, nonInteractive: true, force: false, purge: false, pull: true,
    get: (key) => key === "data-dir" ? dataDir : key === "plugin-manifest" ? manifest : undefined };
  return { root, cfg, manifest, flags, calls, readCalls: () => {
    try { return readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]); }
    catch { return []; }
  } };
}

async function idleFixture(t: TestContext, f: ReturnType<typeof fixture>, turns: string[] = []) {
  const db = new Database(f.cfg.dbPath);
  db.exec("CREATE TABLE tasks (status TEXT)");
  t.after(() => db.close());
  t.mock.method(globalThis, "fetch", async () => {
    assert.equal(isUpdateMaintenance(f.cfg.dbPath), true, "admission is closed before checking activity");
    return Response.json({ ok: true, updateMaintenance: true });
  });
  const messages: unknown[] = [];
  const runner = createServer((socket) => socket.on("data", (data) => {
    messages.push(JSON.parse(data.toString()));
    socket.end(JSON.stringify({ t: "live", turns }) + "\n");
  }));
  await new Promise<void>((resolve) => runner.listen(f.cfg.runnerSocket, resolve));
  t.after(() => new Promise<void>((resolve) => runner.close(() => resolve())));
  return { db, turns, messages };
}

test("one planner retains compatible plugins and identifies a required version-line transition", () => {
  const plugin = { manifest: "/opt/plugins/palmagent/plugin.json", version: "0.1.0-alpha.1" };
  const compatible = planUpdate("0.1.0-alpha.2", "0.1.0", "stable", [plugin]);
  assert.equal(compatible.automaticEligible, true);
  assert.equal(compatible.plugins[0].action, "keep");
  assert.equal(compatible.plugins[0].targetVersion, plugin.version);
  const transition = planUpdate("0.1.0", "0.2.0", "stable", [plugin]);
  assert.equal(transition.automaticEligible, false);
  assert.equal(transition.plugins[0].action, "update");
  assert.equal(transition.plugins[0].targetVersion, "0.2.0");
  assert.equal(planUpdate("0.1.0", "0.2.0", "stable", []).automaticEligible, false);
  assert.throws(() => planUpdate("0.2.0", "0.1.0", "stable", []), /downgrade/);
  assert.throws(() => planUpdate("0.1.0", "0.2.0-alpha.1", "stable", []), /Stable/);
});

test("planning resolves a single exact target without creating an update receipt or changing preferences", async (t) => {
  const f = fixture(t);
  const before = readFileSync(userConfigPath(), "utf8");
  const plan = resolveUpdatePlan("0.1.0-alpha.2", "preview", readPluginVersions([f.manifest, f.manifest]));
  assert.equal(plan.targetVersion, "0.1.0-alpha.3");
  assert.equal(plan.plugins.length, 1);
  assert.deepEqual(f.readCalls(), [["view", "palmagent@next", "version", "--json"]]);
  assert.equal(readUpdateReceipt(f.cfg.dataDir), undefined);
  assert.equal(readFileSync(userConfigPath(), "utf8"), before);
});

test("manual update refuses incompatible or missing plugin evidence before changing the package", async (t) => {
  const f = fixture(t);
  process.env.TEST_UPDATE_TARGET = "0.2.0-alpha.1";
  await assert.rejects(update(f.flags), /target needs a matching plugin/);
  assert.deepEqual(f.readCalls().map((args) => args[0]), ["view"]);
  assert.equal(readUpdateReceipt(f.cfg.dataDir), undefined);
  await assert.rejects(update({ ...f.flags, get: (key) => key === "data-dir" ? f.cfg.dataDir : undefined }), /requires --plugin-manifest/);
  assert(f.readCalls().every((args) => args[0] === "view"));
});

test("automatic updates are opt-in and defer across compatibility lines", async (t) => {
  const f = fixture(t);
  assert.equal(await update({ ...f.flags, automatic: true }), 0);
  assert.deepEqual(f.readCalls(), []);
  setUserAutoUpdate(true);
  process.env.TEST_UPDATE_TARGET = "0.2.0-alpha.1";
  assert.equal(await update({ ...f.flags, automatic: true }), 0);
  assert.deepEqual(f.readCalls().map((args) => args[0]), ["view"]);
  assert.equal(readUpdateReceipt(f.cfg.dataDir)?.reason, "plugin-update-required");
});

test("legacy plugin pull calls remain supported within the current compatibility line", async (t) => {
  const f = fixture(t);
  await idleFixture(t, f);
  rmSync(userConfigPath());
  assert.equal(await update({ ...f.flags, get: (key) => key === "data-dir" ? f.cfg.dataDir : undefined }), 1);
  assert.deepEqual(f.readCalls().map((args) => args[0]), ["view", "root", "install"], "the fixture reaches installation rather than rejecting an old plugin's supported call");
  assert.equal(JSON.parse(readFileSync(userConfigPath(), "utf8")).channel, "preview", "legacy preference is saved before a failed package install can lose its metadata");
});

test("an installation failure preserves preferences and blocks later automatic attempts", async (t) => {
  const f = fixture(t);
  await idleFixture(t, f);
  setUserAutoUpdate(true);
  const before = readFileSync(userConfigPath(), "utf8");
  assert.equal(await update(f.flags), 1);
  assert.deepEqual(f.readCalls().map((args) => args[0]), ["view", "root", "install"]);
  assert.deepEqual(f.readCalls()[2], ["install", "-g", "palmagent@0.1.0-alpha.3"]);
  assert.equal(readUpdateReceipt(f.cfg.dataDir)?.status, "failed");
  assert.equal(statSync(join(f.cfg.dataDir, "update-result.json")).mode & 0o777, 0o600);
  assert.equal(readFileSync(userConfigPath(), "utf8"), before);
  assert.equal(await update({ ...f.flags, automatic: true }), 0);
  assert.equal(f.readCalls().length, 3);
  writeUpdateReceipt(f.cfg.dataDir, { status: "applying", previousVersion: "0.1.0-alpha.2", targetVersion: "0.1.0-alpha.3", reason: "interrupted" });
  assert.equal(await update({ ...f.flags, automatic: true }), 0);
  assert.equal(f.readCalls().length, 3);
});

test("a healthy unchanged target is a no-op and a wrong npm prefix never installs", async (t) => {
  const f = fixture(t);
  process.env.TEST_UPDATE_TARGET = "0.1.0-alpha.2";
  assert.equal(await update(f.flags), 0);
  assert.deepEqual(f.readCalls().map((args) => args[0]), ["view"]);
  process.env.TEST_UPDATE_TARGET = "0.1.0-alpha.3";
  // Deliberately point metadata at another installation while leaving npm's root unchanged.
  const other = join(f.root, "other"); mkdirSync(other);
  writeFileSync(join(other, "package.json"), JSON.stringify({ version: "0.1.0-alpha.2" }));
  saveConfig({ ...f.cfg, pkgDir: other });
  await assert.rejects(update(f.flags), /npm prefix does not own/);
  assert(f.readCalls().every((args) => args[0] !== "install"));
});

test("activation uses the installed CLI and verifies runtime identity independently of its exit code", async (t) => {
  const f = fixture(t);
  await idleFixture(t, f);
  process.env.TEST_UPDATE_INSTALL = "success";
  // A nominally successful activation that leaves the old server alive is a failure.
  assert.equal(await update(f.flags), 1);
  assert.equal(readUpdateReceipt(f.cfg.dataDir)?.status, "failed");
  const activation = JSON.parse(readFileSync(join(f.root, "activation.json"), "utf8"));
  assert.equal(activation.sentinel, "1");
  assert.deepEqual(activation.args, ["update", "--data-dir", f.cfg.dataDir, "-y", "--expected-version", "0.1.0-alpha.3"]);
  // A manual same-version repair remains possible after a failed activation.
  process.env.TEST_UPDATE_HEALTH = "0.1.0-alpha.3";
  assert.equal(await update(f.flags), 0);
  assert.equal(readUpdateReceipt(f.cfg.dataDir)?.status, "succeeded");
  assert.equal(f.readCalls().filter((args) => args[0] === "install").length, 2);
});

test("the shared operation lock excludes another process and releases on close", (t) => {
  const f = fixture(t);
  const directory = dirname(userConfigPath());
  const release = acquireUpdateLock(directory);
  const probe = () => spawnSync("flock", ["-n", "-E", "75", join(directory, "update.lock"), "true"]).status;
  assert.equal(probe(), 75);
  release();
  assert.equal(probe(), 0);
  rmSync(join(directory, "update.lock"));
  symlinkSync(userConfigPath(), join(directory, "update.lock"));
  assert.throws(() => acquireUpdateLock(directory), /regular file/);
});

test("executor rendering preserves custom paths, owner, environment, and the saved-channel contract", (t) => {
  const { cfg } = fixture(t);
  const rendered = renderAutoUpdateUnits({ ...cfg, dataDir: "/srv/palmagent state", pkgDir: "/opt/palmagent package" }, {
    node: "/usr/bin/node", home: "/srv/operator", configHome: "/srv/operator/preferences",
  });
  assert.match(rendered.service, /User=palmagent/);
  assert.match(rendered.service, /"\/opt\/palmagent package\/cli.js"/);
  assert.match(rendered.service, /"update-request"/);
  assert.match(rendered.service, /PALMAGENT_NON_INTERACTIVE=1/);
  assert.match(rendered.service, /PALMAGENT_HOME=\/srv\/operator\/preferences/);
  assert(!rendered.service.includes("--channel"));
  assert.equal("timer" in rendered, false);
  assert(!rendered.service.includes("OnCalendar"));
  assert.throws(() => renderAutoUpdateUnits({ ...cfg, mode: "source" }), /installed Palmagent package/);
  assert.throws(() => renderAutoUpdateUnits({ ...cfg, user: "root" }), /unprivileged/);
  assert.throws(() => renderAutoUpdateUnits({ ...cfg, dataDir: "/srv/data\nExecStart=unexpected" }), /invalid systemd unit value/);
  assert.equal(getUserConfig().autoUpdate, undefined);
  setUserAutoUpdate(true, { dryRun: true });
  assert.equal(getUserConfig().autoUpdate, undefined);
});

test("systemd accepts the generated event-triggered executor", { skip: process.platform !== "linux" }, (t) => {
  const { cfg } = fixture(t);
  const directory = mkdtempSync(join(tmpdir(), "palmagent-systemd-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const rendered = renderAutoUpdateUnits({ ...cfg, dataDir: "/srv/palmagent state" });
  const service = join(directory, autoUpdateService.replace("@.", "@fixture."));
  writeFileSync(service, rendered.service);
  const checked = spawnSync("systemd-analyze", ["verify", "--man=no", service], { encoding: "utf8" });
  assert.equal(checked.error, undefined);
  assert.equal(checked.status, 0, checked.stderr);
});

test("access checks reuse a short cache, refresh on demand/channel change, and keep failed checks distinct", (t) => {
  const f = fixture(t);
  const now = Date.now();
  const first = checkUpdateAccess(f.cfg, false, now);
  assert.equal(first.discovery?.targetVersion, "0.1.0-alpha.3");
  assert.equal(first.pending, null, "checking alone never authorizes installation");
  assert.deepEqual(checkUpdateAccess(f.cfg, false, now + 1000), first);
  assert.equal(f.readCalls().length, 1);
  checkUpdateAccess(f.cfg, true, now + 2000);
  assert.equal(f.readCalls().length, 2);
  checkUpdateAccess(f.cfg, false, now + 16 * 60_000);
  assert.equal(f.readCalls().length, 3);
  setUserChannel("stable");
  const failed = checkUpdateAccess(f.cfg, false, now + 16 * 60_000 + 1);
  assert.equal(failed.discovery?.error, true, "a prerelease in Stable is not reported as current");
  assert.equal(failed.discovery?.targetVersion, null);
  checkUpdateAccess(f.cfg, false, now + 16 * 60_000 + 2);
  assert.equal(f.readCalls().length, 4, "failed checks are throttled too");
});

test("an install request pins the displayed target and cannot cross channel, version, or preference changes", (t) => {
  const f = fixture(t);
  checkUpdateAccess(f.cfg, true);
  assert.throws(() => requestUpdateAccess(f.cfg, true));
  assert.throws(() => requestUpdateAccess(f.cfg, false, "0.1.0-alpha.9"));
  requestUpdateAccess(f.cfg, false, "0.1.0-alpha.3");
  const manual = readUpdateAccess(f.cfg.dataDir).pending!;
  assert.equal(manual.automatic, false);
  assert(validUpdateRequest(f.cfg, manual));
  setUserAutoUpdate(true);
  process.env.TEST_UPDATE_TARGET = "0.1.0-alpha.4";
  checkUpdateAccess(f.cfg, true);
  requestUpdateAccess(f.cfg, true);
  assert.deepEqual(readUpdateAccess(f.cfg.dataDir).pending, manual, "later checks cannot replace an approved exact target");
  setUserChannel("stable");
  assert.equal(validUpdateRequest(f.cfg, manual), false);
  clearUpdateRequest(f.cfg, manual.id);
  assert.equal(readUpdateAccess(f.cfg.dataDir).pending, null);
  setUserChannel("preview");
  requestUpdateAccess(f.cfg, true);
  const automatic = readUpdateAccess(f.cfg.dataDir).pending!;
  setUserAutoUpdate(false);
  assert.equal(validUpdateRequest(f.cfg, automatic), false);
  writeUpdateReceipt(f.cfg.dataDir, { status: "failed", previousVersion: "0.1.0-alpha.2", targetVersion: "0.1.0-alpha.4", reason: "manual-recovery-required" });
  assert.throws(() => requestUpdateAccess(f.cfg, false, "0.1.0-alpha.4"), /recovery/);
});

test("a cancelled durable request never reaches registry resolution or installation", async (t) => {
  const f = fixture(t);
  checkUpdateAccess(f.cfg, true);
  requestUpdateAccess(f.cfg, false, "0.1.0-alpha.3");
  const request = readUpdateAccess(f.cfg.dataDir).pending!;
  clearUpdateRequest(f.cfg);
  assert.equal(await update({ ...f.flags, request }), 0);
  assert.deepEqual(f.readCalls().map((args) => args[0]), ["view"]);
});

test("a manual app update preserves busy work and resumes the pinned release without enabling automatic updates", async (t) => {
  const f = fixture(t);
  const db = new Database(f.cfg.dbPath);
  t.after(() => db.close());
  db.exec("CREATE TABLE tasks (status TEXT); INSERT INTO tasks VALUES ('running')");
  writeFileSync(join(f.root, "bin", "sudo"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  t.mock.method(globalThis, "fetch", async () => Response.json({ ok: true, updateMaintenance: true }));
  checkUpdateAccess(f.cfg, true);
  requestUpdateAccess(f.cfg, false, "0.1.0-alpha.3");
  const request = readUpdateAccess(f.cfg.dataDir).pending!;
  const flags = { ...f.flags, request };
  assert.equal(await update(flags), 0);
  assert.equal(readUpdateReceipt(f.cfg.dataDir)?.reason, "tasks-active");
  assert.deepEqual(readUpdateAccess(f.cfg.dataDir).pending, request);
  assert(!f.readCalls().some((args) => args[0] === "install"));
  db.exec("UPDATE tasks SET status = 'idle'");
  const runner = createServer((socket) => socket.on("data", () => socket.write('{"t":"live","turns":[]}\n')));
  await new Promise<void>((resolve) => runner.listen(f.cfg.runnerSocket, resolve));
  t.after(() => new Promise<void>((resolve) => runner.close(() => resolve())));
  process.env.TEST_UPDATE_INSTALL = "success";
  process.env.TEST_UPDATE_HEALTH = "0.1.0-alpha.3";
  assert.equal(await update(flags), 0);
  assert.equal(readUpdateReceipt(f.cfg.dataDir)?.status, "succeeded");
  assert.equal(readUpdateAccess(f.cfg.dataDir).pending, null);
  assert.equal(getUserConfig().autoUpdate, undefined);
  assert.deepEqual(f.readCalls().find((args) => args[0] === "install"), ["install", "-g", "palmagent@0.1.0-alpha.3"]);
});

test("automatic request CLI defers active sessions and then installs its queued exact version", async (t) => {
  const f = fixture(t);
  const idle = await idleFixture(t, f);
  setUserAutoUpdate(true);
  checkUpdateAccess(f.cfg, true);
  requestUpdateAccess(f.cfg, true);
  const request = readUpdateAccess(f.cfg.dataDir).pending!;
  assert.equal(request.automatic, true);
  process.env.TEST_UPDATE_TAG_TARGET = "0.1.0-alpha.4";
  const execute = async () => {
    const script = `
      globalThis.fetch = async () => Response.json({ ok: true, updateMaintenance: true });
      process.argv = [process.execPath, 'fixture', 'update-request', '--data-dir', process.env.TEST_ACTIVATION_DATA];
      await import(${JSON.stringify(new URL("../src/cli/index.ts", import.meta.url).href)});
    `;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      env: { ...process.env, TEST_ACTIVATION_DATA: f.cfg.dataDir }, stdio: "pipe", timeout: 10_000,
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    assert.equal(code, 0, output);
    assert.equal(isUpdateMaintenance(f.cfg.dbPath), false);
  };
  const assertDeferred = () => {
    assert.equal(readUpdateReceipt(f.cfg.dataDir)?.reason, "tasks-active");
    assert.deepEqual(readUpdateAccess(f.cfg.dataDir).pending, request);
    assert(!f.readCalls().some((args) => args[0] === "install"));
    const hostCalls = readFileSync(join(f.root, "host.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert(hostCalls.every((args) => args.join(" ") === "-n true"), "only a read-only privilege probe is allowed before idle verification");
  };
  idle.db.exec("INSERT INTO tasks VALUES ('running')");
  await execute();
  assertDeferred();
  idle.db.exec("DELETE FROM tasks");
  idle.turns.push("live-codex", "live-claude");
  await execute();
  assertDeferred();
  assert.deepEqual(idle.messages, [{ t: "hello" }], "activity checks never control agent sessions");
  idle.turns.length = 0;
  process.env.TEST_UPDATE_INSTALL = "success";
  process.env.TEST_UPDATE_HEALTH = request.targetVersion;
  await execute();
  assert.equal(readUpdateReceipt(f.cfg.dataDir)?.status, "succeeded");
  assert.equal(readUpdateReceipt(f.cfg.dataDir)?.targetVersion, request.targetVersion);
  assert.equal(readUpdateAccess(f.cfg.dataDir).pending, null);
  assert.equal(getUserConfig().autoUpdate, true);
  assert.deepEqual(f.readCalls().filter((args) => args[0] === "view").map((args) => args[1]),
    ["palmagent@next", ...Array(3).fill("palmagent@0.1.0-alpha.3")]);
  assert.deepEqual(f.readCalls().find((args) => args[0] === "install"), ["install", "-g", "palmagent@0.1.0-alpha.3"]);
});

test("public automatic updates still reject explicit version and channel overrides", async (t) => {
  const f = fixture(t);
  setUserAutoUpdate(true);
  for (const [key, value] of [["to", "0.1.0-alpha.3"], ["channel", "preview"]]) {
    await assert.rejects(update({ ...f.flags, automatic: true,
      get: (flag) => flag === key ? value : f.flags.get(flag) }), /follows only the saved channel/);
  }
  assert.deepEqual(f.readCalls(), []);
});

test("migration disables and removes only the legacy recurring timer", (t) => {
  const f = fixture(t);
  const unitDir = join(f.root, "units"); mkdirSync(unitDir);
  writeFileSync(join(unitDir, "palmagent-update.timer"), "[Timer]\nOnCalendar=daily\n");
  writeFileSync(join(f.root, "bin", "sudo"), `#!${process.execPath}
require('node:fs').appendFileSync(${JSON.stringify(f.calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');
`, { mode: 0o700 });
  retireAutoUpdateTimer(unitDir);
  assert.deepEqual(f.readCalls(), [
    ["systemctl", "disable", "--now", "palmagent-update.timer"],
    ["rm", "-f", join(unitDir, "palmagent-update.timer")],
    ["systemctl", "daemon-reload"],
  ]);
  startRequestedUpdate(); startRequestedUpdate();
  const starts = f.readCalls().slice(-2);
  assert(starts.every((args) => args.slice(0, 3).join(" ") === "systemctl start --no-block"));
  assert(starts.every((args) => /^palmagent-update@[a-f0-9-]+\.service$/.test(args[3])));
  assert.notEqual(starts[0][3], starts[1][3], "a new event cannot be swallowed by a service still exiting");
});

test("a corrupt failure record is never replaced by a recoverable request result", async (t) => {
  const f = fixture(t);
  checkUpdateAccess(f.cfg, true);
  requestUpdateAccess(f.cfg, false, "0.1.0-alpha.3");
  const request = readUpdateAccess(f.cfg.dataDir).pending!;
  const result = join(f.cfg.dataDir, "update-result.json");
  writeFileSync(result, "{invalid");
  await assert.rejects(update({ ...f.flags, request }), /last update result/);
  assert.equal(readFileSync(result, "utf8"), "{invalid");
  assert(!f.readCalls().some((args) => args[0] === "install"));
});

for (const pull of [true, false]) {
  test(`manual ${pull ? "package replacement" : "service activation"} preserves active sessions even with force`, async (t) => {
    const f = fixture(t);
    const idle = await idleFixture(t, f);
    const before = readFileSync(join(f.cfg.pkgDir!, "package.json"), "utf8");
    for (const status of ["running", "queued", "awaiting_input", "awaiting_approval"]) {
      idle.db.prepare("INSERT INTO tasks VALUES (?)").run(status);
      assert.equal(await update({ ...f.flags, pull, force: true }), 1, status);
      assert.equal(isUpdateMaintenance(f.cfg.dbPath), false, "deferral reopens task admission");
      idle.db.exec("DELETE FROM tasks");
    }
    idle.turns.push("live-codex", "live-claude");
    assert.equal(await update({ ...f.flags, pull, force: true }), 1, "runner activity also blocks when DB is idle");
    assert.deepEqual(idle.messages, [{ t: "hello" }], "activity checks never signal, resume, or cancel a turn");
    assert.equal(readFileSync(join(f.cfg.pkgDir!, "package.json"), "utf8"), before);
    assert(!f.readCalls().some((args) => args[0] === "install"));
    assert.throws(() => readFileSync(join(f.root, "host.jsonl")), { code: "ENOENT" }, "no service/config mutation before idle verification");
    assert.equal(isUpdateMaintenance(f.cfg.dbPath), false);
  });

  test(`manual ${pull ? "replacement" : "activation"} fails closed when activity cannot be verified`, async (t) => {
    const f = fixture(t);
    const idle = await idleFixture(t, f);
    t.mock.method(globalThis, "fetch", async () => Response.json({ ok: true, updateMaintenance: false }));
    if (pull) assert.equal(await update(f.flags), 1);
    else await assert.rejects(update({ ...f.flags, pull }), /maintenance/);
    assert.deepEqual(idle.messages, []);
    assert.equal(isUpdateMaintenance(f.cfg.dbPath), false);
    assert(!f.readCalls().some((args) => args[0] === "install"));
    assert.throws(() => readFileSync(join(f.root, "host.jsonl")), { code: "ENOENT" });
  });
}

test("a deferred recovery retains the failed receipt and automatic retry hold", async (t) => {
  const f = fixture(t);
  const idle = await idleFixture(t, f);
  idle.db.exec("INSERT INTO tasks VALUES ('running')");
  writeUpdateReceipt(f.cfg.dataDir, { status: "failed", previousVersion: "0.1.0-alpha.2", targetVersion: "0.1.0-alpha.3", reason: "manual-recovery-required" });
  const before = readUpdateReceipt(f.cfg.dataDir);
  assert.equal(await update(f.flags), 1);
  assert.deepEqual(readUpdateReceipt(f.cfg.dataDir), before);
  assert.equal(isUpdateMaintenance(f.cfg.dbPath), false);
});

test("an activation sentinel without the live updater parent's window cannot bypass safety", async (t) => {
  const f = fixture(t);
  process.env.PALMAGENT_UPDATE_POST_UPGRADE = "1";
  const flags = { ...f.flags, pull: false, get: (key: string) => key === "expected-version" ? "0.1.0-alpha.2" : f.flags.get(key) };
  await assert.rejects(update(flags), /parent's maintenance window/);
  writeFileSync(maintenancePath(f.cfg.dbPath), JSON.stringify({ schemaVersion: 1, pid: process.ppid, identity: "prior-boot:1", token: "fixture" }));
  await assert.rejects(update(flags), /parent's maintenance window/);
  assert.throws(() => readFileSync(join(f.root, "host.jsonl")), { code: "ENOENT" });
});

test("source setup checks the current listener and leaves active sessions and configuration intact", async (t) => {
  const f = fixture(t);
  const idle = await idleFixture(t, f);
  idle.turns.push("live-codex", "live-claude");
  const before = readFileSync(join(f.cfg.dataDir, "install.env"), "utf8");
  // Setup is also the maintainer source-update path. A new port must not become
  // the activity probe target until the existing installation is safely idle.
  t.mock.method(globalThis, "fetch", async (url: string) => {
    assert.equal(url, `http://${f.cfg.host}:${f.cfg.port}/api/health`);
    return Response.json({ ok: true, updateMaintenance: true });
  });
  assert.equal(await setup({ ...f.flags, get: (key) => key === "port" ? "4101" : f.flags.get(key) }), 1);
  assert.equal(readFileSync(join(f.cfg.dataDir, "install.env"), "utf8"), before);
  assert.deepEqual(idle.messages, [{ t: "hello" }]);
  assert.equal(isUpdateMaintenance(f.cfg.dbPath), false);
  assert.throws(() => readFileSync(join(f.root, "host.jsonl")), { code: "ENOENT" });
});

test("idle direct activation may restart services only after both activity checks", async (t) => {
  const f = fixture(t);
  const idle = await idleFixture(t, f);
  writeFileSync(join(f.cfg.pkgDir!, "runner-daemon.js"), "// Fixture runner artifact\n");
  assert.equal(await update({ ...f.flags, pull: false }), 0);
  assert.deepEqual(idle.messages, [{ t: "hello" }]);
  const calls = readFileSync(join(f.root, "host.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert(calls.some((args) => args.join(" ") === "systemctl restart palmagent-runner.service"));
  assert(calls.some((args) => args.join(" ") === "systemctl restart palmagent.service"));
  assert.equal(isUpdateMaintenance(f.cfg.dbPath), false);
});

test("the activation child reuses its live parent's lock but still rejects a busy runner", async (t) => {
  const f = fixture(t);
  const idle = await idleFixture(t, f, ["live-codex"]);
  const unlock = acquireUpdateLock(dirname(userConfigPath()));
  const release = beginUpdateMaintenance(f.cfg.dbPath);
  try {
    const script = `
      import { update } from ${JSON.stringify(new URL("../src/cli/install.ts", import.meta.url).href)};
      globalThis.fetch = async () => Response.json({ ok: true, updateMaintenance: true });
      const code = await update({ dryRun: false, nonInteractive: true, force: false, purge: false, pull: false,
        get: (key) => key === 'data-dir' ? process.env.TEST_ACTIVATION_DATA : key === 'expected-version' ? '0.1.0-alpha.2' : undefined });
      process.exit(code);
    `;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      env: { ...process.env, TEST_ACTIVATION_DATA: f.cfg.dataDir, PALMAGENT_UPDATE_POST_UPGRADE: "1" }, stdio: "pipe", timeout: 10_000,
    });
    let errors = "";
    child.stderr.on("data", (chunk) => { errors += chunk; });
    const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    assert.equal(code, 1, errors);
    assert.deepEqual(idle.messages, [{ t: "hello" }], "child passed parent ownership validation and checked activity");
    assert.equal(isUpdateMaintenance(f.cfg.dbPath), true, "child must not release its parent's window");
    assert.throws(() => readFileSync(join(f.root, "host.jsonl")), { code: "ENOENT" });
  } finally { release(); unlock(); }
});

for (const command of ["update", "setup"]) {
  test(`${command} CLI entrypoint owns one lock and reaches the session guard`, async (t) => {
    const f = fixture(t);
    const idle = await idleFixture(t, f, ["live-claude"]);
    const script = `
      globalThis.fetch = async () => Response.json({ ok: true, updateMaintenance: true });
      process.argv = [process.execPath, 'fixture', process.env.TEST_ACTIVATION_COMMAND, '--data-dir', process.env.TEST_ACTIVATION_DATA, '-y'];
      await import(${JSON.stringify(new URL("../src/cli/index.ts", import.meta.url).href)});
    `;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      env: { ...process.env, TEST_ACTIVATION_DATA: f.cfg.dataDir, TEST_ACTIVATION_COMMAND: command }, stdio: "pipe", timeout: 10_000,
    });
    let errors = "";
    child.stderr.on("data", (chunk) => { errors += chunk; });
    const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    assert.equal(code, 1, errors);
    assert.deepEqual(idle.messages, [{ t: "hello" }], "entrypoint must reach activity checks without trying to acquire the lock twice");
    assert.equal(isUpdateMaintenance(f.cfg.dbPath), false);
    assert.throws(() => readFileSync(join(f.root, "host.jsonl")), { code: "ENOENT" });
  });
}


for (const outcome of ["success", "contract", "rollback", "provision"]) test(`automatic independent application activation: ${outcome}`, async (t) => {
  const f = fixture(t);
  process.env.TEST_INDEPENDENT_OUTCOME = outcome;
  writeFileSync(join(f.root, "bin", "sleep"), `#!${process.execPath}\n`, { mode: 0o700 });
  f.cfg.executionNode = process.execPath;
  f.cfg.user = userInfo().username;
  for (const file of ["execution-host.js", "execution-launcher.js", "server.js", "cli.js"]) writeFileSync(join(f.cfg.pkgDir!, file), "// Retained fixture artifact\n");
  writeFileSync(join(f.cfg.pkgDir!, "runtime-contract.json"), JSON.stringify({ executionProtocol: 1, productStorage: 1, applicationApi: 1 }));
  saveConfig(f.cfg);
  setUserAutoUpdate(true);
  const executions = new ExecutionStore(join(f.cfg.dataDir, "executions"));
  t.after(() => executions.close());
  const active = executions.reserve({ taskId: "active", agent: "claude", cwd: f.root, prompt: "Fixture" }, f.cfg.pkgDir!, process.execPath);
  executions.admit(1); executions.claim(active.id);
  const db = new Database(f.cfg.dbPath);
  db.exec("CREATE TABLE tasks (status TEXT); INSERT INTO tasks VALUES ('running'),('awaiting_input')");
  t.after(() => db.close());
  t.mock.method(globalThis, "fetch", async () => {
    assert(isUpdateMaintenance(f.cfg.dbPath));
    return Response.json({ ok: true, updateMaintenance: true, executionProtocol: 1 });
  });
  writeFileSync(join(f.root, "bin", "npm"), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(path.join(process.env.TEST_UPDATE_ROOT, 'calls.jsonl'), JSON.stringify(args) + '\\n');
if (args[0] === 'view') console.log(JSON.stringify('0.1.0-alpha.3'));
else if (args[0] === 'install' && args.includes('--prefix')) {
  const receipt = JSON.parse(fs.readFileSync(path.join(process.env.TEST_UPDATE_ROOT, 'state', 'update-result.json'), 'utf8'));
  if (receipt.status !== 'applying' || receipt.reason !== 'candidate-preparation') process.exit(98);
  const pkg = path.join(args[args.indexOf('--prefix') + 1], 'node_modules', 'palmagent');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ version: '0.1.0-alpha.3' }));
  fs.writeFileSync(path.join(pkg, 'runtime-contract.json'), JSON.stringify({ executionProtocol: process.env.TEST_INDEPENDENT_OUTCOME === 'contract' ? 2 : 1, productStorage: 1, applicationApi: 1, hostSetup: 1, ingressOwner: 'plugin' }));
  fs.writeFileSync(path.join(pkg, 'cli.js'), "if (process.argv[2] === 'runtime-setup' && process.env.TEST_INDEPENDENT_OUTCOME === 'provision') process.exit(1); if (process.argv[2] === 'runtime-setup') require('node:fs').writeFileSync(require('node:path').join(process.env.TEST_UPDATE_ROOT, 'candidate-setup'), 'provisioned'); else console.log('0.1.0-alpha.3');");
  for (const name of ['server.js', 'execution-host.js', 'execution-launcher.js']) fs.writeFileSync(path.join(pkg, name), '// Candidate fixture artifact');
} else process.exit(1);
`, { mode: 0o700 });
  // Model toolchains that put npm beside Node. Selecting the retained Node must
  // not replace the npm executable already selected on the installation PATH.
  const runtimeBin = join(f.root, "other-toolchain"); mkdirSync(runtimeBin);
  const originalNode = process.execPath;
  symlinkSync(originalNode, join(runtimeBin, "node"));
  writeFileSync(join(runtimeBin, "npm"), `#!${originalNode}\nprocess.exit(99);\n`, { mode: 0o700 });
  process.execPath = join(runtimeBin, "node");
  t.after(() => { process.execPath = originalNode; });
  checkUpdateAccess(f.cfg, true); requestUpdateAccess(f.cfg, true);
  const request = readUpdateAccess(f.cfg.dataDir).pending!;
  process.env.TEST_UPDATE_HEALTH = ["rollback", "provision"].includes(outcome) ? "0.1.0-alpha.2" : request.targetVersion;
  assert.equal(await update({ ...f.flags, automatic: true, request }), outcome === "success" ? 0 : 1);
  assert.equal(readUpdateReceipt(f.cfg.dataDir)?.status, outcome === "success" ? "succeeded" : "failed");
  if (outcome !== "success") {
    assert.equal(loadConfig({ dataDir: f.cfg.dataDir }).pkgDir, f.cfg.pkgDir);
    if (["rollback", "provision"].includes(outcome)) assert.equal(JSON.parse(readFileSync(join(f.cfg.dataDir, "application-activation.json"), "utf8")).status, "restored");
  }
  assert.equal(existsSync(join(f.root, 'candidate-setup')), ['success', 'rollback'].includes(outcome));
  assert.equal(executions.get(active.id).state, "running");
  assert.equal(executions.get(active.id).release, f.cfg.pkgDir);
  assert.equal(readFileSync(join(f.cfg.pkgDir!, "execution-host.js"), "utf8"), "// Retained fixture artifact\n");
  const commands = readFileSync(join(f.root, "host.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
  assert.equal(commands.some((args) => args.join(" ").includes("restart palmagent.service")), outcome !== "contract");
  assert(!commands.some((args) => args.join(" ").includes("restart palmagent-runner.service")));
  assert(!commands.some((args) => args.includes("stop")));
  assert(!f.readCalls().some((args) => args.includes("-g")), "no global package tree is replaced");
  if (outcome === "success") assert.equal(readUpdateAccess(f.cfg.dataDir).pending, null);
});


test("internal runtime setup refuses direct invocation before host mutations", t => {
  const f = fixture(t);
  assert.throws(() => prepareIndependentRuntime(f.flags, f.cfg.pkgDir!, process.execPath), /live updater parent's maintenance window/);
  assert.equal(existsSync(join(f.root, "host.jsonl")), false);
});

test("target runtime setup installs application services without touching ingress or activation ownership", t => {
  const f = fixture(t);
  const pkg = join(f.cfg.dataDir, "releases", "candidate", "palmagent");
  const node = join(f.cfg.dataDir, "runtimes", "candidate", "node");
  mkdirSync(pkg, { recursive: true }); mkdirSync(dirname(node), { recursive: true });
  writeFileSync(node, "Fixture retained runtime");
  writeFileSync(join(pkg, "runtime-contract.json"), JSON.stringify({ executionProtocol: 1, productStorage: 1, applicationApi: 1, hostSetup: 1, terminalProtocol: 1 }));
  for (const name of ["cli.js", "server.js", "execution-host.js", "execution-launcher.js", "terminal-host.js", "terminal-launcher.js"]) writeFileSync(join(pkg, name), "// Fixture");
  const installed = readFileSync(join(f.cfg.dataDir, "install.env"), "utf8");
  const release = beginUpdateMaintenance(f.cfg.dbPath);
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { prepareIndependentRuntime } from ${JSON.stringify(new URL("../src/cli/install.ts", import.meta.url).href)};
      prepareIndependentRuntime({ dryRun: false, nonInteractive: true, force: false, purge: false, pull: false,
        get: key => key === "data-dir" ? ${JSON.stringify(f.cfg.dataDir)} : undefined }, ${JSON.stringify(pkg)}, ${JSON.stringify(node)});
    `], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const commands = readFileSync(join(f.root, "host.jsonl"), "utf8");
    assert.match(commands, /palmagent-terminal@/);
    assert.doesNotMatch(commands, /nginx|certbot|letsencrypt|openssl/);
    assert(!commands.includes("restart"));
    assert.equal(readFileSync(join(f.cfg.dataDir, "install.env"), "utf8"), installed);
    assert(isUpdateMaintenance(f.cfg.dbPath));
  } finally { release(); }
});

// These commands are deliberately tested with the real orchestrator and a fake
// host executor: no TLS files or working proxy are available or necessary.
test("setup and uninstall preserve external ingress across legacy configuration adoption", async t => {
  const { uninstall } = await import("../src/cli/install.js");
  const f = fixture(t);
  await idleFixture(t, f);
  const flags = { ...f.flags, pull: false };
  assert.equal(await setup(flags), 0);
  assert.equal(await uninstall(flags), 0);
  const calls = readFileSync(join(f.root, "host.jsonl"), "utf8");
  assert.match(calls, /restart.*palmagent.service/);
  assert.doesNotMatch(calls, /nginx|certbot|letsencrypt|openssl|caddy/);
});

test("connection command reads legacy state without writes and reports IPv6 upstream correctly", t => {
  const f = fixture(t);
  saveConfig({ ...f.cfg, host: "::1" });
  const before = readFileSync(join(f.cfg.dataDir, "install.env"), "utf8");
  const result = spawnSync(process.execPath, ["--import", "tsx", new URL("../src/cli/index.ts", import.meta.url).pathname, "connection", "--data-dir", f.cfg.dataDir], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const contract = JSON.parse(result.stdout);
  assert.equal(contract.publicOrigin, f.cfg.authOrigin);
  assert.equal(contract.upstream, "http://[::1]:4100");
  assert.equal(contract.ingressOwner, "plugin");
  assert.equal(contract.proxy.websocket.upgrade, true);
  assert(!result.stdout.includes(f.cfg.dataDir));
  assert.equal(readFileSync(join(f.cfg.dataDir, "install.env"), "utf8"), before);
  assert.equal(existsSync(join(f.root, "host.jsonl")), false);
});

test("preflight and doctor do not require or invoke host ingress tools", async t => {
  const { preflight, doctor } = await import("../src/cli/checks.js");
  const f = fixture(t);
  fakeRuntimeTools(f.root);
  assert(!preflight().some(check => check.level === "fail"));
  const checks = doctor(f.cfg);
  assert(!checks.some(check => /nginx|TLS|certbot/.test(check.name)));
  assert.equal(checks.find(check => check.name === "local HTTP")?.level, "ok");
  writeFileSync(join(f.root, "bin", "curl"), `#!${process.execPath}\nconsole.log('invalid health');\n`, { mode: 0o700 });
  assert.equal(doctor(f.cfg).find(check => check.name === "local HTTP")?.level, "fail");
  assert.doesNotMatch(readFileSync(join(f.root, "host.jsonl"), "utf8"), /nginx|certbot|letsencrypt|openssl|caddy/);
});

function fakeRuntimeTools(root: string): void {
  writeFileSync(join(root, "bin", "bash"), `#!${process.execPath}
const command = process.argv.at(-1);
if (command.startsWith('command -v ')) {
 const tool = command.slice(11);
 if (['systemctl', 'node', 'git', 'codex'].includes(tool)) console.log(require('node:path').join(process.env.TEST_UPDATE_ROOT, 'bin', tool));
 else process.exit(1);
}
`, { mode: 0o700 });
  writeFileSync(join(root, "bin", "codex"), `#!${process.execPath}\nconsole.log('codex 0.116.0');\n`, { mode: 0o700 });
}

test("first installation needs no proxy tools or certificates and defers enrollment", async t => {
  const { install } = await import("../src/cli/install.js");
  const f = fixture(t);
  await idleFixture(t, f);
  fakeRuntimeTools(f.root);
  rmSync(join(f.cfg.dataDir, "install.env"));
  const messages: string[] = [];
  t.mock.method(console, "log", (...args: unknown[]) => { messages.push(args.join(" ")); });
  const flags = { ...f.flags, pull: false, get: (key: string) =>
    key === "domain" ? f.cfg.domain : f.flags.get(key) };
  assert.equal(await install(flags), 0);
  const calls = readFileSync(join(f.root, "host.jsonl"), "utf8");
  assert.match(calls, /restart.*palmagent.service/);
  assert.doesNotMatch(calls, /nginx|certbot|letsencrypt|openssl|caddy/);
  assert(!messages.some(message => message.includes("/#/enroll/")));
  assert.equal(loadConfig({ dataDir: f.cfg.dataDir, requireInstalled: true }).authOrigin, f.cfg.authOrigin);
});

test("rollback provisioning never executes an older candidate's ingress-managing installer", async t => {
  const { provisionIndependentRuntime } = await import("../src/cli/install.js");
  const f = fixture(t);
  writeFileSync(join(f.cfg.pkgDir!, "runtime-contract.json"), JSON.stringify({ executionProtocol: 1, productStorage: 1, applicationApi: 1, hostSetup: 1 }));
  for (const name of ["server.js", "execution-host.js", "execution-launcher.js"]) writeFileSync(join(f.cfg.pkgDir!, name), "// Fixture");
  const marker = join(f.root, "legacy-installer-called");
  writeFileSync(join(f.cfg.pkgDir!, "cli.js"), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unsafe old ingress setup');`);
  provisionIndependentRuntime({ ...f.cfg, executionNode: process.execPath }, f.flags);
  assert(!existsSync(marker));
  const calls = readFileSync(join(f.root, "host.jsonl"), "utf8");
  assert.match(calls, /palmagent.service/);
  assert.doesNotMatch(calls, /nginx|certbot|letsencrypt|openssl|caddy/);
});
