import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { smokeEnv } from "../lib/pkg-smoke-runtime.mjs";

test("package smoke boots with scratch paths despite hostile inherited runtime settings", () => {
  const scratch = mkdtempSync(join(tmpdir(), "palmagent-smoke-env-"));
  try {
    mkdirSync(join(scratch, "home"));
    const env = smokeEnv({
      ...process.env,
      RUNNER_SOCKET: "must-not-connect.sock",
      DISPATCHER_DB: "must-not-open.db",
      STATIC_DIR: "must-not-serve",
      REPO_ROOTS: "must-not-discover",
      VAPID_KEY_PATH: "must-not-write",
      AUTH_ENABLED: "1",
      AUTH_ORIGIN: "invalid-origin",
      PUSH_SUBJECT: "invalid-subject",
      GITHUB_TOKEN: "must-not-inherit",
      NODE_OPTIONS: "--require=must-not-load",
      FUTURE_RUNTIME_OPTION: "must-not-inherit",
    }, scratch, 12345);
    const probe = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { config, validateConfig } from "./apps/server/src/config.ts";
      validateConfig();
      console.log(JSON.stringify({
        socket: config.runnerSocket, db: config.dbPath,
        roots: config.repoRoots, auth: config.authEnabled,
        token: config.githubToken, home: process.env.HOME,
        unknown: process.env.FUTURE_RUNTIME_OPTION,
      }));
    `], { env, encoding: "utf8" });
    const values = JSON.parse(probe.trim());
    assert.equal(values.socket, undefined);
    assert.equal(values.db, join(scratch, "data/palmagent.db"));
    assert.deepEqual(values.roots, []);
    assert.equal(values.auth, false);
    assert.equal(values.token, undefined);
    assert.equal(values.home, join(scratch, "home"));
    assert.equal(values.unknown, undefined);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
