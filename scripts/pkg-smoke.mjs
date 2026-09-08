// Install and boot exactly the tarball packed by this run, with isolated state.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
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
  console.log("[smoke] PASS: packed CLI, isolated SQLite, and PWA");
} finally {
  await server?.stop();
  rmSync(scratch, { recursive: true, force: true });
}
