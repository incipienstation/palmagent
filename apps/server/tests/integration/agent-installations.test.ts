import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireUpdateLock } from "../../src/platform/filesystem/update-lock.js";
import { createAgentInstallationService } from "../../src/modules/agents/composition.js";

const installed = { version: "0.156.1", installation: "native" as const, command: "/fixture/bin/codex" };
const home = () => "/fixture/home";

test("version reads coalesce release checks and never invoke the updater", async () => {
  let now = 1, checks = 0, updates = 0;
  const service = createAgentInstallationService(home, {
    inspect: async () => installed, now: () => now,
    latest: async () => { checks++; return "0.156.2"; },
    update: async () => { updates++; },
  });
  const [first, second] = await Promise.all([service.get("codex"), service.get("codex")]);
  assert.deepEqual(first, second);
  assert.equal(checks, 1); assert.equal(updates, 0);
  assert.equal(first.compatible, true);
  assert.doesNotMatch(JSON.stringify(first), /fixture|command/);
  now += 60_001;
  await service.get("codex"); assert.equal(checks, 2);
});

test("concurrent updates are rejected before probing, remain visible, and verify the new executable", async () => {
  let finish!: () => void, version = installed.version, updates = 0;
  const hold = new Promise<void>(resolve => { finish = resolve; });
  const service = createAgentInstallationService(home, {
    inspect: async () => ({ ...installed, version }), latest: async () => "0.156.2",
    update: async () => { updates++; await hold; version = "0.156.2"; },
  });
  const first = service.update("codex", installed.version);
  await assert.rejects(service.update("codex", installed.version), /already running/);
  assert.equal((await first).update.state, "running");
  assert.equal((await service.get("codex")).update.state, "running");
  assert.equal(updates, 1);
  finish(); await service.close();
  const result = await service.get("codex");
  assert.equal(result.version, "0.156.2");
  assert.equal(result.update.state, "succeeded");
  assert.match(result.update.message!, /0.156.1 to 0.156.2/);
});

test("changed or externally managed installations cannot be updated from stale controls", async () => {
  let updates = 0;
  const deps = { latest: async () => "0.156.2", update: async () => { updates++; } };
  const native = createAgentInstallationService(home, { ...deps, inspect: async () => installed });
  await assert.rejects(native.update("codex", "0.155.0"), /version changed/);
  const external = createAgentInstallationService(home, { ...deps, inspect: async () => ({ ...installed, installation: "external" }) });
  await assert.rejects(external.update("codex", installed.version), /package manager/);
  assert.equal(updates, 0);
});

test("release and updater failures remain distinct and never expose native diagnostics", async () => {
  let releaseAvailable = false;
  const service = createAgentInstallationService(home, {
    inspect: async () => installed, latest: async () => { if (!releaseAvailable) throw new Error("private endpoint"); return "0.156.2"; },
    update: async () => { throw new Error("private credential and path"); },
  });
  assert.equal((await service.get("codex")).releaseState, "error");
  releaseAvailable = true;
  await service.update("codex", installed.version); await service.close();
  const failed = await service.get("codex");
  assert.equal(failed.version, installed.version);
  assert.equal(failed.update.state, "failed");
  assert.doesNotMatch(JSON.stringify(failed), /private|credential|fixture/);
});

test("a successful updater exit is not success when the installed CLI cannot be verified", async () => {
  let updated = false;
  const service = createAgentInstallationService(home, {
    inspect: async () => updated ? { version: null, installation: "unavailable" } : installed,
    latest: async () => "0.156.2", update: async () => { updated = true; },
  });
  await service.update("codex", installed.version); await service.close();
  assert.equal((await service.get("codex")).update.state, "failed");
});


test("already-current and newer local installs never reinstall or downgrade the executable", async () => {
  let version = "0.156.2", updates = 0;
  const service = createAgentInstallationService(home, {
    inspect: async () => ({ ...installed, version }), latest: async () => "0.156.2",
    update: async () => { updates++; },
  });
  assert.match((await service.update("codex", version)).update.message!, /Already on the latest/);
  version = "0.160.0";
  await assert.rejects(service.update("codex", version), /No downgrade/);
  assert.equal(updates, 0);
});


test("native updates share the host lock and persist results without replaying interrupted work", async t => {
  const dir = mkdtempSync(join(tmpdir(), "palmagent-agent-update-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let finish!: () => void, version = installed.version, updates = 0;
  const hold = new Promise<void>(resolve => { finish = resolve; });
  const deps = {
    inspect: async () => ({ ...installed, version }), latest: async () => "0.156.2",
    lock: () => acquireUpdateLock(dir),
    update: async () => { updates++; await hold; version = "0.156.2"; },
  };
  const first = createAgentInstallationService(home, deps, dir);
  await first.update("codex", version);
  assert.throws(() => acquireUpdateLock(dir), /already running/);
  const restarted = createAgentInstallationService(home, deps, dir);
  assert.equal((await restarted.get("codex")).update.state, "failed");
  assert.equal(updates, 1, "loading a running receipt must not replay an update");
  await assert.rejects(restarted.update("codex", version), /already running/);
  finish(); await first.close();
  const release = acquireUpdateLock(dir); release();
  const reopened = createAgentInstallationService(home, deps, dir);
  assert.equal((await reopened.get("codex")).update.state, "succeeded");
  writeFileSync(join(dir, "agent-updates.json"), "invalid");
  const corrupt = createAgentInstallationService(home, deps, dir);
  await assert.rejects(corrupt.update("codex", version), /Saved update state/);
  assert.equal(updates, 1);
});

test("a read started before update completion cannot pair the old version with a success receipt", async () => {
  let version = installed.version, now = 1, holdRelease = false;
  let finishUpdate!: () => void, finishRelease!: () => void, releaseStarted!: () => void;
  const updateHold = new Promise<void>(resolve => { finishUpdate = resolve; });
  const releaseHold = new Promise<void>(resolve => { finishRelease = resolve; });
  const releaseSeen = new Promise<void>(resolve => { releaseStarted = resolve; });
  const service = createAgentInstallationService(home, {
    inspect: async () => ({ ...installed, version }), now: () => now,
    latest: async () => { if (holdRelease) { releaseStarted(); await releaseHold; } return "0.156.2"; },
    update: async () => { await updateHold; version = "0.156.2"; },
  });
  await service.update("codex", version);
  now += 60_001; holdRelease = true;
  const stale = service.get("codex");
  await releaseSeen;
  finishUpdate(); await service.close();
  holdRelease = false; finishRelease();
  const refreshed = await stale;
  assert.equal(refreshed.version, "0.156.2");
  assert.equal(refreshed.update.state, "succeeded");
});
