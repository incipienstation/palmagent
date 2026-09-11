import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { assertUserConfigPreserved, getUserConfig, initUserConfig, setUserChannel, userConfigPath } from "../src/cli/user-config.js";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "palmagent-preferences-"));
  const previous = process.env.PALMAGENT_HOME;
  process.env.PALMAGENT_HOME = join(root, "preferences");
  t.after(() => {
    if (previous === undefined) delete process.env.PALMAGENT_HOME;
    else process.env.PALMAGENT_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const dataDir = join(root, "installation");
  mkdirSync(dataDir);
  return { root, dataDir };
}

test("preferences exist independently of an installed service and initialize privately", (t) => {
  const { dataDir } = fixture(t);
  assert.deepEqual(getUserConfig({ dataDir }), { schemaVersion: 1, channel: "stable" });
  assert.deepEqual(readdirSync(dataDir), []);
  assert.throws(() => statSync(userConfigPath()), { code: "ENOENT" });
  initUserConfig({ dataDir, dryRun: true });
  assert.throws(() => statSync(userConfigPath()), { code: "ENOENT" });
  initUserConfig({ dataDir });
  assert.equal(statSync(userConfigPath()).mode & 0o777, 0o600);
  assert.equal(statSync(process.env.PALMAGENT_HOME!).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(process.env.PALMAGENT_HOME!), ["config.json"]);
});

test("legacy channel migrates once and cannot override a later user choice", (t) => {
  const { dataDir } = fixture(t);
  writeFileSync(join(dataDir, "install.env"), "RELEASE_CHANNEL=preview\n");
  assert.equal(initUserConfig({ dataDir }).channel, "preview");
  setUserChannel("stable");
  assert.equal(initUserConfig({ dataDir }).channel, "stable");
  rmSync(dataDir, { recursive: true });
  assert.equal(getUserConfig({ dataDir }).channel, "stable", "service removal retains user preferences");
});

test("pre-channel installs infer Preview from the legacy package only before migration", (t) => {
  const { root, dataDir } = fixture(t);
  const pkg = join(root, "package");
  mkdirSync(pkg);
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ version: "0.1.0-alpha.2" }));
  writeFileSync(join(dataDir, "install.env"), `MODE=package\nPKG_DIR=${pkg}\n`);
  assert.equal(initUserConfig({ dataDir }).channel, "preview");
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ version: "0.1.0" }));
  assert.equal(getUserConfig({ dataDir }).channel, "preview");
});

test("setting a channel preserves unrelated preferences and supports a read-only preview", (t) => {
  const { dataDir } = fixture(t);
  initUserConfig({ dataDir });
  writeFileSync(userConfigPath(), JSON.stringify({ schemaVersion: 1, channel: "stable", future: { enabled: true } }));
  const before = readFileSync(userConfigPath(), "utf8");
  assert.equal(setUserChannel("preview", { dryRun: true }).channel, "preview");
  assert.equal(readFileSync(userConfigPath(), "utf8"), before);
  setUserChannel("preview");
  assert.deepEqual(getUserConfig(), { schemaVersion: 1, channel: "preview", future: { enabled: true } });
  assert.deepEqual(readdirSync(process.env.PALMAGENT_HOME!), ["config.json"]);
});

test("invalid and future config versions fail closed without exposing values or resetting settings", (t) => {
  const { dataDir } = fixture(t);
  initUserConfig({ dataDir });
  for (const text of [
    '{"private":"do-not-echo-this",',
    '{"schemaVersion":2,"channel":"preview"}',
    '{"schemaVersion":1,"channel":"unexpected"}',
    '{"channel":"preview"}',
    '[]',
  ]) {
    writeFileSync(userConfigPath(), text);
    for (const operation of [() => getUserConfig(), () => initUserConfig(), () => setUserChannel("stable")]) {
      assert.throws(operation, (error: Error) => error.message.includes("cannot read user settings") && !error.message.includes("do-not-echo-this"));
      assert.equal(readFileSync(userConfigPath(), "utf8"), text);
    }
  }
});

test("an invalid channel never creates preferences; explicit selection can recover absent legacy metadata", (t) => {
  const { root, dataDir } = fixture(t);
  assert.throws(() => setUserChannel("next"), /stable or preview/);
  assert.throws(() => statSync(userConfigPath()), { code: "ENOENT" });
  writeFileSync(join(dataDir, "install.env"), `MODE=package\nPKG_DIR=${join(root, "missing")}\n`);
  assert.throws(() => initUserConfig({ dataDir }), /cannot infer/);
  assert.equal(setUserChannel("preview").channel, "preview");
  assert.equal(getUserConfig({ dataDir }).channel, "preview");
});

test("service purge cannot remove a directory containing shared settings", (t) => {
  const { root, dataDir } = fixture(t);
  assert.doesNotThrow(() => assertUserConfigPreserved(dataDir));
  assert.throws(() => assertUserConfigPreserved(root), /refusing to purge/);
  assert.throws(() => assertUserConfigPreserved(process.env.PALMAGENT_HOME!), /refusing to purge/);
});

test("a failed write preserves the previous file and leaves no partial config", (t) => {
  const { dataDir } = fixture(t);
  initUserConfig({ dataDir });
  const before = readFileSync(userConfigPath(), "utf8");
  const directory = process.env.PALMAGENT_HOME!;
  // Permission checks are meaningful for the unprivileged service/operator account.
  if (process.getuid?.() === 0) { t.skip("requires an unprivileged test process"); return; }
  chmodSync(directory, 0o500);
  try {
    assert.throws(() => setUserChannel("preview"));
    assert.equal(readFileSync(userConfigPath(), "utf8"), before);
    assert.deepEqual(readdirSync(directory), ["config.json"]);
  } finally { chmodSync(directory, 0o700); }
});
