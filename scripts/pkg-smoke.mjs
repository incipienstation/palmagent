// Install and boot exactly the tarball packed by this run, with isolated state.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { freePort, smokeEnv, startSmokeServer } from "./lib/pkg-smoke-runtime.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PKG = join(ROOT, "build/pkg");
const args = process.argv.slice(2);
assert(args.length === 0 || (args.length === 2 && args[0] === "--pack-destination"),
  "Usage: node scripts/pkg-smoke.mjs [--pack-destination <directory>]");
const scratch = mkdtempSync(join(tmpdir(), "palmagent-smoke-"));
let server;

try {
  for (const dir of ["home", "cache", "tmp", "pack"]) mkdirSync(join(scratch, dir));
  assert(existsSync(join(PKG, "package.json")), "build/pkg missing: run pnpm pkg:build first");
  const pkg = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8"));
  const buildInfo = JSON.parse(readFileSync(join(PKG, "build-info.json"), "utf8"));
  const binName = Object.keys(pkg.bin ?? {})[0];
  assert(binName, "package has no bin");
  const port = await freePort();
  const env = smokeEnv(process.env, scratch, port);
  const options = { cwd: scratch, env, stdio: "inherit" };
  // CI retains the exact tarball installed below; the default remains disposable.
  const packDirectory = args.length ? resolve(ROOT, args[1]) : join(scratch, "pack");
  mkdirSync(packDirectory, { recursive: true });
  assert(!readdirSync(packDirectory).some((name) => name.endsWith(".tgz")),
    "Pack destination already contains a tarball; use a fresh directory");

  console.log("[smoke] packing current artifact");
  const packed = JSON.parse(execFileSync("npm",
    ["pack", "--json", "--pack-destination", packDirectory],
    { cwd: PKG, env, encoding: "utf8" }));
  assert.equal(packed.length, 1, "expected one freshly packed tarball");
  const tarball = join(packDirectory, packed[0].filename);
  const entries = execFileSync("tar", ["-tf", tarball], { env, encoding: "utf8" }).trim().split("\n");
  const has = (suffix) => entries.some((entry) =>
    entry === "package/" + suffix || entry.startsWith("package/" + suffix + "/"));
  for (const file of ["web/index.html", "README.md", "LICENSE"]) assert(has(file), "missing " + file);
  assert(!has("public") && !has("docs/archive"), "unexpected fallback or archive");
  execFileSync("npm", ["init", "-y"], { ...options, stdio: "ignore" });
  execFileSync("npm", ["install", tarball], options);
  const bin = join(scratch, "node_modules/.bin", binName);
  assert.equal(execFileSync(bin, ["--version"], { env, encoding: "utf8" }).trim(), pkg.version);

  const baseVersion = pkg.version.split("-")[0];
  for (const pluginVersion of [baseVersion, `${baseVersion}-alpha.1`, `${baseVersion}-beta.1`, `${baseVersion}-rc.1`]) {
    assert.match(execFileSync(bin, ["compatibility", "--plugin-version", pluginVersion],
      { env, encoding: "utf8" }), /: compatible/);
  }
  const [major, minor, patch] = baseVersion.split(".").map(Number);
  for (const cliArgs of [
    ["compatibility", "--plugin-version", `${major}.${minor}.${patch + 1}`],
    ["compatibility", "--plugin-version", "next"],
    ["compatibility", "--plugin-version"],
    ["update", "--channel"],
    ["doctor", "--channel", "preview"],
    ["update", "--plan=false"],
    ["update", "--plugin-manifest"],
    ["doctor", "--automatic"],
    ["auto-update", "enable", "--unexpected"],
  ]) {
    const result = spawnSync(bin, cliArgs, { env, encoding: "utf8" });
    assert.equal(result.status, 1, `invalid CLI request should fail: ${cliArgs.join(" ")}`);
  }
  assert(!existsSync(join(scratch, "data")), "compatibility and invalid flags must not create installation state");

  const configPath = join(env.HOME, ".palmagent", "config.json");
  const readPreferences = (cwd = scratch) => JSON.parse(execFileSync(bin, ["config", "get"],
    { cwd, env, encoding: "utf8" }));
  assert.deepEqual(readPreferences(), { schemaVersion: 1, channel: "stable" });
  assert(!existsSync(configPath), "reading settings must not create a file");
  execFileSync(bin, ["config", "init"], { env, encoding: "utf8" });
  execFileSync(bin, ["config", "set", "--channel", "preview"], { env, encoding: "utf8" });
  assert.equal(readPreferences(join(scratch, "home")).channel, "preview", "another process and working directory share preferences");
  const savedPreferences = readFileSync(configPath, "utf8");
  execFileSync(bin, ["config", "init"], { env, encoding: "utf8" });
  execFileSync(bin, ["config", "set", "--channel", "stable", "--dry-run"], { env, encoding: "utf8" });
  assert.equal(readFileSync(configPath, "utf8"), savedPreferences);
  assert.equal(statSync(configPath).mode & 0o777, 0o600);
  assert(!existsSync(join(scratch, "data")), "settings changes must not initialize service data");

  server = startSmokeServer(bin, scratch, env);
  const origin = `http://localhost:${port}`;
  let healthy = false;
  for (let i = 0; i < 40; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    server.assertRunning();
    // Require the new process's own listener announcement before accepting HTTP.
    if (!server.listening()) continue;
    try {
      const response = await fetch(origin + "/api/health", { signal: AbortSignal.timeout(1000) });
      const health = await response.json();
      if (response.ok && health.ok === true) {
        assert.deepEqual(health.build, buildInfo, "running package build identity differs from its artifact");
        assert.equal(health.updateMaintenance, false, "packed server exposes the maintenance handshake");
        healthy = true; break;
      }
    } catch { /* not ready yet */ }
  }
  assert(healthy, "new server did not become healthy within the deadline");
  const shell = await fetch(origin + "/", { signal: AbortSignal.timeout(3000) });
  assert(shell.ok && (await shell.text()).includes('<div id="root"'), "PWA shell missing");
  server.assertRunning();
  const db = join(scratch, "data/palmagent.db");
  assert(existsSync(db), "scratch SQLite database missing");
  assert.equal(statSync(join(scratch, "data")).mode & 0o777, 0o700);
  assert.equal(statSync(db).mode & 0o777, 0o600);
  assert.equal(readFileSync(configPath, "utf8"), savedPreferences, "starting the service preserves preferences");

  // The installed package's read-only planner uses fake registry metadata. No
  // systemd, real global install, or plugin-manager state is touched.
  const fakeBin = join(scratch, "registry-bin");
  mkdirSync(fakeBin);
  const target = `${major}.${minor + 1}.0`;
  writeFileSync(join(fakeBin, "npm"), `#!${process.execPath}\nif (process.argv[2] !== 'view') process.exit(1);\nconsole.log(JSON.stringify(${JSON.stringify(target)}));\n`, { mode: 0o700 });
  const manifest = join(scratch, "installed-plugin.json");
  writeFileSync(manifest, JSON.stringify({ name: "palmagent", version: pkg.version }));
  const installEnv = join(scratch, "data/install.env");
  writeFileSync(installEnv, ["MODE=package", "RUN_USER=palmagent", "RUN_GROUP=palmagent", "DOMAIN=palmagent.example.com", `PKG_DIR=${join(scratch, "node_modules", pkg.name)}`, `DATA_DIR=${join(scratch, "data")}`, ""].join("\n"));
  const beforePlan = readFileSync(installEnv, "utf8");
  const plan = JSON.parse(execFileSync(bin, ["update", "--plan", "--data-dir", join(scratch, "data"), "--plugin-manifest", manifest], {
    cwd: scratch, env: { ...env, PATH: fakeBin + ":" + env.PATH }, encoding: "utf8",
  }));
  assert.equal(plan.targetVersion, target);
  assert.equal(plan.plugins[0].action, "update");
  assert.equal(plan.automaticEligible, false);
  execFileSync(bin, ["auto-update", "enable", "--dry-run", "--data-dir", join(scratch, "data")], { env, encoding: "utf8" });
  assert.equal(readFileSync(installEnv, "utf8"), beforePlan);
  assert.equal(readFileSync(configPath, "utf8"), savedPreferences);
  assert(!existsSync(join(scratch, "data/update-result.json")), "planning never creates an update receipt");
  console.log("[smoke] PASS: packed CLI, isolated SQLite, and PWA");
} finally {
  await server?.stop();
  rmSync(scratch, { recursive: true, force: true });
}
