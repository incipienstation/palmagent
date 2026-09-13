import Database from "better-sqlite3";
import { createServer } from "node:net";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { checkUpdateAccess, readUpdateAccess, requestUpdateAccess, validUpdateRequest, clearUpdateRequest } from "../src/cli/update-access.js";
import { planUpdate, readPluginVersions, resolveUpdatePlan } from "../src/cli/update-plan.js";
import { acquireUpdateLock, readUpdateReceipt, writeUpdateReceipt } from "../src/cli/update-state.js";
import { autoUpdateService, startRequestedUpdate, retireAutoUpdateTimer, renderAutoUpdateUnits } from "../src/cli/auto-update.js";
import { DEFAULT_CAPS, saveConfig, type InstallConfig } from "../src/cli/config.js";
import { getUserConfig, setUserAutoUpdate, setUserChannel, userConfigPath } from "../src/cli/user-config.js";
import { update, type Flags } from "../src/cli/install.js";

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
  writeFileSync(join(root, "bin", "curl"), `#!${process.execPath}\nconsole.log(JSON.stringify({ ok: true, build: { version: process.env.TEST_UPDATE_HEALTH || '0.1.0-alpha.2' } }));\n`, { mode: 0o700 });
  writeFileSync(join(root, "bin", "npm"), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
fs.appendFileSync(path.join(process.env.TEST_UPDATE_ROOT, 'calls.jsonl'), JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.argv[2] === 'view') console.log(JSON.stringify(process.env.TEST_UPDATE_TARGET || '0.1.0-alpha.3'));
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
  rmSync(userConfigPath());
  assert.equal(await update({ ...f.flags, get: (key) => key === "data-dir" ? f.cfg.dataDir : undefined }), 1);
  assert.deepEqual(f.readCalls().map((args) => args[0]), ["view", "root", "install"], "the fixture reaches installation rather than rejecting an old plugin's supported call");
  assert.equal(JSON.parse(readFileSync(userConfigPath(), "utf8")).channel, "preview", "legacy preference is saved before a failed package install can lose its metadata");
});

test("an installation failure preserves preferences and blocks later automatic attempts", async (t) => {
  const f = fixture(t);
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
  const flags = { ...f.flags, request, get: (key: string) => key === "to" ? request.targetVersion : f.flags.get(key) };
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
