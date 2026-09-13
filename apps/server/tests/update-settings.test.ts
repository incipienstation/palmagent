import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { UpdateSettingsChange, UpdateSettingsState } from "@palmagent/shared";
import { createUpdateSettingsService } from "../src/update-settings.js";
import { runUpdateSettingsCommand } from "../src/cli/update-settings.js";
import { getUserConfig, setUserAutoUpdate, setUserChannel, userConfigPath } from "../src/cli/user-config.js";
import { acquireUpdateLock } from "../src/cli/update-state.js";
import { loadConfig } from "../src/cli/config.js";
import { renderUnits } from "../src/cli/units.js";

function directory(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "palmagent-update-settings-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const state: UpdateSettingsState = { availability: "available", settings: {
  channel: "preview", autoUpdate: false, timerActive: false, lastUpdate: null,
} };

test("the web bridge invokes only its own CLI, validates input/output, and hides subprocess details", async (t) => {
  const root = directory(t);
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  writeFileSync(join(root, "cli.js"), `
    import {readFileSync, writeFileSync} from 'node:fs';
    import {fileURLToPath} from 'node:url';
    const path = (name) => fileURLToPath(new URL(name, import.meta.url));
    writeFileSync(path('call.json'), JSON.stringify({args:process.argv.slice(2), nonInteractive:process.env.PALMAGENT_NON_INTERACTIVE}));
    console.log(readFileSync(path('response.json'), 'utf8'));
  `);
  const response = (value: unknown) => writeFileSync(join(root, "response.json"), JSON.stringify(value));
  const service = createUpdateSettingsService({ packageDir: root, dataDir: "/srv/palmagent state", dbPath: "/srv/db/palmagent.db" });
  response({ ok: true, state });
  assert.deepEqual(await service.status(), state);
  assert.deepEqual(JSON.parse(readFileSync(join(root, "call.json"), "utf8")), {
    args: ["update-settings", "status", "--data-dir", "/srv/palmagent state", "--expected-db", "/srv/db/palmagent.db"], nonInteractive: "1",
  });
  await service.change({ autoUpdate: true });
  assert.deepEqual(JSON.parse(readFileSync(join(root, "call.json"), "utf8")).args.slice(-2), ["--auto-update", "true"]);
  await service.change({ channel: "stable" });
  const call = readFileSync(join(root, "call.json"), "utf8");
  assert.deepEqual(JSON.parse(call).args.slice(-2), ["--channel", "stable"]);
  await assert.rejects(service.change({ channel: "preview", command: "unexpected" } as unknown as UpdateSettingsChange));
  assert.equal(readFileSync(join(root, "call.json"), "utf8"), call);
  response({ ok: false, error: "busy" });
  await assert.rejects(service.change({ autoUpdate: true }), { status: 409 });
  response({ ok: false, error: "save-failed", private: "/private/fixture" });
  await assert.rejects(service.change({ autoUpdate: false }), (error: Error) => !error.message.includes("/private/fixture"));
  response({ malformed: "private fixture value" });
  assert.deepEqual(await service.status(), { availability: "unavailable", settings: null });
  await assert.rejects(service.change({ autoUpdate: true }), /Could not confirm/);
  const source = createUpdateSettingsService({ dataDir: root, dbPath: join(root, "db") });
  assert.deepEqual(await source.status(), { availability: "source-install", settings: null });
  await assert.rejects(source.change({ autoUpdate: true }), { status: 409 });
});

function installedFixture(t: test.TestContext) {
  const root = directory(t);
  const previous = { PATH: process.env.PATH, PALMAGENT_HOME: process.env.PALMAGENT_HOME };
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const bin = join(root, "bin"); mkdirSync(bin);
  const data = join(root, "data"); mkdirSync(data);
  const db = join(data, "palmagent.db");
  process.env.PALMAGENT_HOME = join(root, "preferences");
  process.env.PATH = `${bin}:${previous.PATH}`;
  const executable = (name: string, text: string) => writeFileSync(join(bin, name), `#!/bin/sh\n${text}\n`, { mode: 0o755 });
  executable("sudo", 'exit 0');
  executable("systemctl", 'exit 3');
  const pkg = fileURLToPath(new URL("../src/cli", import.meta.url));
  const content = `MODE=package\nRELEASE_CHANNEL=stable\nDOMAIN=updates.example\nRUN_USER=${userInfo().username}\nRUN_GROUP=fixture\nPKG_DIR=${pkg}\nEXEC_PATH=${process.env.PATH}\nDISPATCHER_DB=${db}\n`;
  writeFileSync(join(data, "install.env"), content);
  const args = ["--data-dir", data, "--expected-db", db];
  return { root, data, db, args, executable, content };
}

test("CLI settings share preferences, preserve other keys, and exclude concurrent installation changes", (t) => {
  const f = installedFixture(t);
  const initial = runUpdateSettingsCommand(["status", ...f.args]);
  assert.equal(initial.ok, true);
  if (!initial.ok) return;
  assert.equal(initial.state.settings?.autoUpdate, false);
  assert.equal(initial.state.settings?.channel, "stable");
  assert.equal(existsSync(userConfigPath()), false, "reading status does not initialize preferences");
  setUserAutoUpdate(true, { dataDir: f.data });
  const saved = JSON.parse(readFileSync(userConfigPath(), "utf8"));
  writeFileSync(userConfigPath(), JSON.stringify({ ...saved, futurePreference: "retained" }));
  assert.equal(runUpdateSettingsCommand(["set", ...f.args, "--channel", "preview"]).ok, true);
  assert.deepEqual(getUserConfig(), { ...saved, channel: "preview", futurePreference: "retained" });
  const unlock = acquireUpdateLock(dirname(userConfigPath()));
  try {
    assert.deepEqual(runUpdateSettingsCommand(["set", ...f.args, "--channel", "stable"]), { ok: false, error: "busy" });
    assert.equal(runUpdateSettingsCommand(["status", ...f.args]).ok, true);
    assert.equal(getUserConfig().channel, "preview");
  } finally { unlock(); }
  const bytes = readFileSync(userConfigPath(), "utf8");
  assert.equal(runUpdateSettingsCommand(["set", ...f.args, "--channel", "stable", "--auto-update", "false"]).ok, false);
  assert.equal(readFileSync(userConfigPath(), "utf8"), bytes);
  f.executable("sudo", "exit 1");
  const denied = runUpdateSettingsCommand(["status", ...f.args]);
  assert(denied.ok && denied.state.availability === "permission-required");
  assert.equal(runUpdateSettingsCommand(["set", ...f.args, "--auto-update", "false"]).ok, false);
  assert.equal(readFileSync(userConfigPath(), "utf8"), bytes);
});

test("settings fail closed for mismatched installations and invalid files, and retain custom service paths", (t) => {
  const f = installedFixture(t);
  const mismatched = runUpdateSettingsCommand(["status", "--data-dir", f.data, "--expected-db", join(f.root, "other.db")]);
  assert(mismatched.ok && mismatched.state.availability === "installation-mismatch");
  writeFileSync(join(f.data, "install.env"), f.content.replace("MODE=package", "MODE=source"));
  const source = runUpdateSettingsCommand(["status", ...f.args]);
  assert(source.ok && source.state.availability === "source-install");
  writeFileSync(join(f.data, "install.env"), f.content);
  setUserChannel("preview");
  writeFileSync(userConfigPath(), "{invalid JSON");
  assert.deepEqual(runUpdateSettingsCommand(["status", ...f.args]), { ok: false, error: "unavailable" });
  assert.equal(runUpdateSettingsCommand(["set", ...f.args, "--auto-update", "true"]).ok, false);
  assert.equal(readFileSync(userConfigPath(), "utf8"), "{invalid JSON");
  const rendered = renderUnits(loadConfig({ dataDir: f.data, requireInstalled: true }), { settingsHome: "/srv/settings % owner" });
  assert(rendered.web.text.includes(`Environment="DISPATCHER_DATA_DIR=${f.data}"`));
  assert(rendered.web.text.includes('Environment="PALMAGENT_HOME=/srv/settings %% owner"'));
});

test("automatic settings are saved only after scheduler activation and preserve the selected channel", (t) => {
  const f = installedFixture(t);
  setUserChannel("preview");
  f.executable("sudo", 'case "$*" in *"enable --now"*) exit 1;; *) exit 0;; esac');
  assert.deepEqual(runUpdateSettingsCommand(["set", ...f.args, "--auto-update", "true"]), { ok: false, error: "save-failed" });
  assert.equal(getUserConfig().autoUpdate, undefined);
  assert.equal(getUserConfig().channel, "preview");
  f.executable("sudo", "exit 0");
  assert.equal(runUpdateSettingsCommand(["set", ...f.args, "--auto-update", "true"]).ok, true);
  assert.equal(getUserConfig().autoUpdate, true);
  assert.equal(getUserConfig().channel, "preview");
  assert.equal(runUpdateSettingsCommand(["set", ...f.args, "--auto-update", "false"]).ok, true);
  assert.equal(getUserConfig().autoUpdate, false);
  assert.equal(getUserConfig().channel, "preview");
});
