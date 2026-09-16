import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { SettingsStore } from "../src/settings.js";
import { acquireUpdateLock } from "../src/cli/update-state.js";

function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "palmagent-settings-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const defaults = join(dir, "default"), added = join(dir, "with spaces"), data = join(dir, "state");
  mkdirSync(defaults); mkdirSync(added);
  const store = new SettingsStore(data, [defaults]);
  return { dir, data, defaults, added, store };
}

test("settings preserve fallback, explicit empty, reset, unknown fields and private durable state", (t) => {
  const { data, defaults, added, store } = fixture(t);
  assert.deepEqual(store.get(), { repoRoots: [defaults], defaults: [defaults], source: "installation" });
  assert.equal(existsSync(data), false, "reads must not create state");
  assert.deepEqual(store.change({ action: "add", paths: [added] }, true).repoRoots, [defaults, added]);
  assert.equal(existsSync(data), false, "dry runs must not create a lock or settings file");
  store.change({ action: "add", paths: [added, added + "/."] });
  assert.equal(statSync(store.path).mode & 0o777, 0o600);
  const second = new SettingsStore(data, [defaults]);
  assert.deepEqual(second.get().repoRoots, [defaults, added]);
  second.change({ action: "set", paths: [] });
  assert.deepEqual(store.get().repoRoots, []);
  assert.equal(store.get().source, "saved");
  writeFileSync(store.path, JSON.stringify({ schemaVersion: 1, repoRoots: [], future: { keep: true } }));
  store.change({ action: "reset" });
  assert.deepEqual(store.get().repoRoots, [defaults]);
  assert.equal(store.get().source, "installation");
  assert.deepEqual(JSON.parse(readFileSync(store.path, "utf8")).future, { keep: true });
  writeFileSync(join(data, "install.env"), `REPO_ROOTS=${added}\n`);
  assert.deepEqual(store.get().defaults, [added], "installed CLI and server share installation defaults");
  assert.deepEqual(second.get().repoRoots, [added]);
  second.change({ action: "set", paths: ["~"] });
  assert.deepEqual(second.get().repoRoots, [homedir()]);
});

test("invalid and inaccessible additions cannot replace saved paths; missing paths can be removed", (t) => {
  const { dir, added, store } = fixture(t);
  store.change({ action: "set", paths: [added] });
  const original = readFileSync(store.path, "utf8");
  const file = join(dir, "file"); writeFileSync(file, "");
  const denied = join(dir, "denied"); mkdirSync(denied);
  for (const path of ["relative", "~/../missing-settings-fixture", join(dir, "missing"), file, "", "a\nb"]) {
    assert.throws(() => store.change({ action: "add", paths: [path] }));
    assert.equal(readFileSync(store.path, "utf8"), original);
  }
  chmodSync(denied, 0);
  try {
    if (process.getuid?.() !== 0) assert.throws(() => store.change({ action: "add", paths: [denied] }), /inaccessible/);
  } finally { chmodSync(denied, 0o700); }
  rmSync(added, { recursive: true });
  assert.deepEqual(store.change({ action: "remove", paths: [added] }).repoRoots, []);
  const release = acquireUpdateLock(store.dataDir);
  try {
    assert.throws(() => store.change({ action: "reset" }), /another Palmagent operation/);
    assert.deepEqual(store.get().repoRoots, []);
  } finally { release(); }
});

test("malformed saved settings fail closed for reads, writes and reset", (t) => {
  const { store } = fixture(t);
  mkdirSync(store.dataDir);
  for (const text of ["{", '{"schemaVersion":2}', '{"schemaVersion":1,"repoRoots":["relative"]}', '{"schemaVersion":1,"repoRoots":null}']) {
    writeFileSync(store.path, text);
    assert.throws(() => store.get(), /preserved/);
    assert.throws(() => store.change({ action: "reset" }), /preserved/);
    assert.equal(readFileSync(store.path, "utf8"), text);
  }
});

test("public settings CLI validates arguments and shares changes with the running store", (t) => {
  const { data, defaults, added, store } = fixture(t);
  const cli = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
  const run = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", cli, "settings", ...args, "--data-dir", data], {
    encoding: "utf8", env: { ...process.env, PALMAGENT_CLI_FORWARDED: "1", REPO_ROOTS: defaults },
  });
  const json = (...args: string[]) => {
    const result = run(...args, "--json");
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  assert.equal(run("--help").status, 0);
  assert.equal(json("get").source, "installation");
  assert.deepEqual(json("add", "repo-roots", added, "--dry-run").repoRoots, [defaults, added]);
  assert.equal(existsSync(data), false);
  json("add", "repo-roots", added);
  assert.deepEqual(store.get().repoRoots, [defaults, added]);
  store.change({ action: "remove", paths: [defaults] });
  assert.deepEqual(json("get", "repo-roots").repoRoots, [added]);
  json("set", "repo-roots");
  assert.deepEqual(store.get().repoRoots, []);
  json("reset", "repo-roots");
  assert.deepEqual(store.get().repoRoots, [defaults]);
  const before = readFileSync(store.path, "utf8");
  for (const args of [[], ["get", "other"], ["get", "repo-roots", "extra"], ["get", "--dry-run"],
    ["add", "repo-roots"], ["reset", "repo-roots", added], ["get", "--unknown"], ["set", "repo-roots", "relative"]]) {
    assert.notEqual(run(...args).status, 0, args.join(" "));
    assert.equal(readFileSync(store.path, "utf8"), before);
  }
});
