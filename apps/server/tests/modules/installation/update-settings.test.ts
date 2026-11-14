import assert from "node:assert/strict";
import { test } from "node:test";
import type { UpdateReceipt } from "@palmagent/shared/updates";
import type { InstallConfig } from "../../../src/modules/installation/domain/installation.js";
import type { UpdateAccessState } from "../../../src/modules/installation/domain/update-access.js";
import type { UpdateAccessStore, UpdateDiscoveryHost, UpdatePreferences, UpdateSettingsHost } from "../../../src/modules/installation/application/ports/outbound/update-settings.js";
import { createUpdateAccess } from "../../../src/modules/installation/application/use-cases/update-access.js";
import { createUpdateSettings } from "../../../src/modules/installation/application/use-cases/update-settings.js";
import { planUpdate } from "../../../src/modules/installation/domain/update-plan.js";
import { createUpdateSettingsCommand } from "../../../src/modules/installation/adapters/inbound/update-settings-cli.js";

function fixture() {
  const config: InstallConfig = { mode: "package", distribution: "npm", user: "owner", group: "owner",
    dataDir: "/installation", dbPath: "/installation/db", runnerSocket: "/installation/runner", pkgDir: "/package",
    executionNode: "/runtime/node", supervisor: "palmagentd", workingDir: "/package", execPath: "/bin",
    domain: "app.example.com", host: "localhost", port: 4100, concurrency: 2, rpId: "app.example.com", rpName: "Palmagent",
    authOrigin: "https://app.example.com", pushSubject: "", repoRoots: "", claudeConfigDir: "",
    caps: { memHigh: "1G", memMax: "2G", tasksMaxRunner: 10, tasksMaxWeb: 10, cpuQuota: "100%", nofile: 1000 } };
  let state: UpdateAccessState = { discovery: null, pending: null };
  let receipt: UpdateReceipt | undefined;
  let now = 1_000_000, sequence = 0;
  const preferences: UpdatePreferences = { channel: "preview", autoUpdate: true };
  const calls: string[] = [];
  const store: UpdateAccessStore = {
    read: () => structuredClone(state), write: (_dir, value) => { state = structuredClone(value); calls.push("write"); }, receipt: () => receipt,
  };
  const discovery: UpdateDiscoveryHost = {
    preferences: () => ({ ...preferences }), version: () => "0.2.0-alpha.1", distribution: cfg => cfg.distribution!,
    now: () => now, requestId: () => `request-${++sequence}`,
    discover: (_cfg, current, channel) => { calls.push("discover"); return { ok: true, plan: planUpdate(current, "0.2.0-alpha.2", channel, []) }; },
  };
  const host: UpdateSettingsHost = {
    lock: () => { calls.push("lock"); return () => { calls.push("unlock"); }; },
    installation: () => ({ cfg: config, availability: "available" }),
    setChannel: (_cfg, channel, dryRun) => { if (!dryRun) preferences.channel = channel; },
    configureAutomatic: async (_cfg, enabled, dryRun) => { if (!dryRun) preferences.autoUpdate = enabled; },
    retireTimer: () => { calls.push("retire"); }, legacyTasksIdle: () => { calls.push("idle"); return true; },
    prepare: async () => { calls.push("prepare"); }, start: async () => { calls.push("start"); },
  };
  const access = createUpdateAccess(store, discovery);
  const settings = createUpdateSettings(store, discovery, host, access);
  const target = { dataDir: config.dataDir, expectedDb: config.dbPath };
  return { config, store, discovery, host, access, settings, preferences, calls, target,
    state: () => state, time: (value: number) => { now = value; },
    failed: () => { receipt = { schemaVersion: 1, checkedAt: "2026-01-01T00:00:00Z", status: "failed", previousVersion: "0.2.0-alpha.1", targetVersion: "0.2.0-alpha.2", reason: "activation-failed" }; },
  };
}

test("discovery reuses success for 15 minutes, failure for one minute, and honors explicit refresh", () => {
  const f = fixture();
  f.access.check(f.config, false, 0); f.access.check(f.config, false, 899_999);
  assert.equal(f.calls.filter(c => c === "discover").length, 1);
  f.access.check(f.config, false, 900_000);
  assert.equal(f.calls.filter(c => c === "discover").length, 2);
  f.discovery.discover = () => { f.calls.push("failure"); return { ok: false, failure: { source: "registry", code: "timeout" } }; };
  f.access.check(f.config, true, 900_001); f.access.check(f.config, false, 960_000);
  assert.equal(f.calls.filter(c => c === "failure").length, 1);
  f.access.check(f.config, false, 960_001);
  assert.equal(f.calls.filter(c => c === "failure").length, 2);
});

test("changed distribution and a backwards clock invalidate discovery", () => {
  const f = fixture();
  f.access.check(f.config, false, 100, "npm");
  f.access.check(f.config, false, 101, "standalone");
  f.access.check(f.config, false, 99, "standalone");
  assert.equal(f.calls.filter(c => c === "discover").length, 3);
});

test("requests pin the displayed target, preserve manual requests, and clear only matching IDs", () => {
  const f = fixture(); f.access.check(f.config, true);
  assert.throws(() => f.access.request(f.config, false, "0.2.0-alpha.9"));
  f.access.request(f.config, false, "0.2.0-alpha.2");
  const request = f.state().pending!;
  f.access.request(f.config, true); assert.deepEqual(f.state().pending, request);
  assert.equal(f.access.valid(f.config, request), true);
  f.access.clear(f.config, "another-request"); assert.deepEqual(f.state().pending, request);
  f.preferences.channel = "stable"; assert.equal(f.access.valid(f.config, request), false);
  f.access.clear(f.config, request.id); assert.equal(f.state().pending, null);
});

test("opt-out and failed activation prevent automatic requests", () => {
  const f = fixture(); f.access.check(f.config, true); f.preferences.autoUpdate = false;
  assert.throws(() => f.access.request(f.config, true));
  f.preferences.autoUpdate = true; f.failed();
  assert.throws(() => f.access.request(f.config, true), /recovery/);
  assert.equal(f.state().pending, null);
});

test("status never acquires a lock or launches a pending update", async () => {
  const f = fixture(); f.access.check(f.config, true); f.access.request(f.config, false);
  f.calls.length = 0;
  assert.equal((await f.settings.execute({ ...f.target, action: "status" })).ok, true);
  assert.deepEqual(f.calls, []);
});

test("visit persists the request and releases the lock before supervisor startup", async () => {
  const f = fixture();
  assert.equal((await f.settings.execute({ ...f.target, action: "visit" })).ok, true);
  assert.deepEqual(f.calls, ["lock", "discover", "write", "write", "prepare", "unlock", "start"]);
  assert.equal(f.state().pending?.automatic, true);
});

test("legacy active tasks defer startup while retaining the request", async () => {
  const f = fixture(); delete f.config.executionNode;
  f.host.legacyTasksIdle = () => false;
  await f.settings.execute({ ...f.target, action: "visit" });
  assert(f.state().pending); assert(!f.calls.includes("prepare"));
  assert.equal(f.calls.at(-1), "unlock");
});

test("channel changes cancel old requests and check availability without installing", async () => {
  const f = fixture(); f.access.check(f.config, true); f.access.request(f.config, true);
  f.discovery.discover = (_cfg, current, channel) => ({ ok: true, plan: planUpdate(current, "0.2.0", channel, []) });
  await f.settings.execute({ ...f.target, action: "set", change: { channel: "stable" } });
  assert.equal(f.state().pending, null); assert.equal(f.state().discovery?.channel, "stable");
  assert(!f.calls.includes("start"));
});

test("busy and preparation errors retain stable errors and release owned locks", async () => {
  const f = fixture(); f.host.lock = () => undefined;
  assert.deepEqual(await f.settings.execute({ ...f.target, action: "visit" }), { ok: false, error: "busy" });
  assert.deepEqual(f.calls, []);
  f.host.lock = () => () => { f.calls.push("unlock"); };
  f.host.prepare = async () => { throw new Error("private host detail"); };
  assert.deepEqual(await f.settings.execute({ ...f.target, action: "visit" }), { ok: false, error: "update-failed" });
  assert.equal(f.calls.at(-1), "unlock"); assert(f.state().pending);
});

test("migration is explicit, pinned, and cannot replace an existing request", async () => {
  const f = fixture();
  f.discovery.discover = (_cfg, current, channel, distribution) => {
    assert.equal(distribution, "standalone");
    return { ok: true, plan: planUpdate(current, "0.2.0-alpha.2", channel, [], "npm", "standalone", {
      distribution: "standalone", version: "0.2.0-alpha.2", manifestUrl: "https://example.com/manifest.json", manifestSha256: "a".repeat(64),
      artifact: { target: "linux-x64-glibc", filename: "palmagent-0.2.0-alpha.2-linux-x64-glibc.tar.gz", url: "https://example.com/archive.tar.gz", sha256: "b".repeat(64), size: 10, unpackedSize: 20, minGlibc: "2.35", requiredLibraries: [] },
    }) };
  };
  assert.equal((await f.settings.execute({ ...f.target, action: "migrate" })).ok, true);
  assert.equal(f.state().pending?.selection?.manifestSha256, "a".repeat(64));
  assert.equal(f.state().pending?.automatic, false);
  assert.deepEqual(await f.settings.execute({ ...f.target, action: "migrate" }), { ok: false, error: "stale-update" });
});

test("CLI parsing rejects malformed mutations before acquiring the lock", async () => {
  const f = fixture(), run = createUpdateSettingsCommand(f.settings);
  assert.deepEqual(await run(["set", "--data-dir", "/installation", "--expected-db", "/installation/db", "--auto-update", "maybe"]), { ok: false, error: "save-failed" });
  assert.deepEqual(f.calls, []);
});
