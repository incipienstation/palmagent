import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tempDir = mkdtempSync(join(tmpdir(), "palmagent-runtime-smoke-"));
const socketPath = join(tempDir, "runner.sock");
const dbPath = join(tempDir, "palmagent.db");
const children = [];

const sanitizedEnv = { ...process.env };
for (const name of [
  "AUTH_COOKIE_NAME",
  "AUTH_DISABLED",
  "AUTH_ENABLED",
  "AUTH_ORIGIN",
  "AUTH_RP_ID",
  "DISPATCHER_DB",
  "DISPATCHER_DATA_DIR",
  "HOST",
  "NODE_ENV",
  "PORT",
  "PUSH_SUBJECT",
  "REPO_ROOTS",
  "RUNNER_SOCKET",
  "STATIC_DIR",
]) {
  delete sanitizedEnv[name];
}

try {
  await assertConfigContract();

  const port = await getFreePort();
  const runner = startTypeScript("src/runner-daemon.ts", {
    ...sanitizedEnv,
    RUNNER_SOCKET: socketPath,
  });
  children.push(runner.child);
  await waitUntil("runner socket", () => existsSync(socketPath), runner);

  const web = startTypeScript("src/server.ts", {
    ...sanitizedEnv,
    AUTH_DISABLED: "1",
    DISPATCHER_DATA_DIR: tempDir,
    HOST: "localhost",
    NODE_ENV: "development",
    PORT: String(port),
    RUNNER_SOCKET: socketPath,
  });
  children.push(web.child);

  let health;
  await waitUntil(
    "health endpoint",
    async () => {
      try {
        const response = await fetch(`http://localhost:${port}/api/health`);
        if (!response.ok) return false;
        health = await response.json();
        return true;
      } catch {
        return false;
      }
    },
    web,
  );

  assert.deepEqual(health, { ok: true });
  assert.equal(existsSync(dbPath), true, "Palmagent database was not created");
  assert.match(web.output(), /using daemon backend/, "server did not connect to the runner daemon");
  console.log("runtime smoke passed");
} finally {
  await Promise.all(children.reverse().map(stopProcess));
  rmSync(tempDir, { recursive: true, force: true });
}

async function assertConfigContract() {
  const probe = await runNode(
    'import("./src/config.ts").then(({ config }) => console.log(JSON.stringify({' +
      'host: config.host, authOrigin: config.authOrigin, cookieName: config.cookieName, dbPath: config.dbPath' +
      "})))",
    {
      ...sanitizedEnv,
      AUTH_DISABLED: "1",
      DISPATCHER_DATA_DIR: tempDir,
      NODE_ENV: "development",
    },
  );
  assert.equal(probe.code, 0, probe.stderr);
  const values = JSON.parse(probe.stdout.trim());
  assert.deepEqual(values, {
    host: "localhost",
    authOrigin: "https://localhost",
    cookieName: "palmagent_session",
    dbPath,
  });

  const rejected = await runNode('import("./src/config.ts")', {
    ...sanitizedEnv,
    AUTH_DISABLED: "1",
    AUTH_ORIGIN: "http://localhost",
    DISPATCHER_DATA_DIR: tempDir,
  });
  assert.notEqual(rejected.code, 0, "plaintext AUTH_ORIGIN was accepted");
  assert.match(rejected.stderr, /AUTH_ORIGIN must use https:\/\//);

  const publicBind = await runNode('import("./src/config.ts")', {
    ...sanitizedEnv,
    AUTH_DISABLED: "1",
    DISPATCHER_DATA_DIR: tempDir,
    HOST: ["0", "0", "0", "0"].join("."),
  });
  assert.notEqual(publicBind.code, 0, "a public plaintext listener was accepted");
  assert.match(publicBind.stderr, /HOST must be loopback/);

  const plaintextPushSubject = await runNode('import("./src/config.ts")', {
    ...sanitizedEnv,
    AUTH_DISABLED: "1",
    DISPATCHER_DATA_DIR: tempDir,
    PUSH_SUBJECT: "http://example.invalid",
  });
  assert.notEqual(plaintextPushSubject.code, 0, "a plaintext PUSH_SUBJECT was accepted");
  assert.match(plaintextPushSubject.stderr, /PUSH_SUBJECT must be a mailto: or https:\/\//);
}

function startTypeScript(entry, env) {
  const child = spawn(process.execPath, ["--import", "tsx", entry], {
    cwd: serverDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  return { child, output: () => output };
}

function runNode(source, env) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--eval", source], {
      cwd: serverDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("exit", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

function getFreePort() {
  return new Promise((resolvePromise, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "localhost", () => {
      const address = probe.address();
      assert(address && typeof address === "object");
      const port = address.port;
      probe.close((error) => (error ? reject(error) : resolvePromise(port)));
    });
  });
}

async function waitUntil(label, predicate, processInfo, timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (processInfo.child.exitCode !== null) {
      throw new Error(`${label}: process exited early\n${processInfo.output()}`);
    }
    if (await predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`${label}: timed out\n${processInfo.output()}`);
}

async function stopProcess(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolvePromise) => child.once("exit", resolvePromise)),
    new Promise((resolvePromise) => setTimeout(resolvePromise, 3_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}
