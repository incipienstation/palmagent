import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as httpServer } from "node:http";
import { createServer as socketServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { verifyUpdateIdle, runnerIsIdle } from "../src/cli/update-idle.js";
import { beginUpdateMaintenance, isUpdateMaintenance, maintenancePath } from "../src/update-maintenance.js";
import type { InstallConfig } from "../src/cli/config.js";

test("automatic update idle verification requires an acknowledgement and checks waiting/queued tasks and runner state", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "palmagent-update-idle-"));
  const dbPath = join(directory, "tasks.db");
  const db = new Database(dbPath);
  db.exec("CREATE TABLE tasks (status TEXT)");
  let acknowledged: boolean | undefined;
  let turns: string[] = [];
  const web = httpServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, updateMaintenance: acknowledged }));
  });
  web.listen(0, "localhost");
  await once(web, "listening");
  const runnerSocket = join(directory, "runner.sock");
  const runner = socketServer((socket) => socket.once("data", () => socket.end(JSON.stringify({ t: "live", turns }) + "\n")));
  runner.listen(runnerSocket);
  await once(runner, "listening");
  t.after(async () => {
    web.closeAllConnections();
    await Promise.all([new Promise<void>((resolve) => web.close(() => resolve())), new Promise<void>((resolve) => runner.close(() => resolve()))]);
    db.close(); rmSync(directory, { recursive: true, force: true });
  });
  const cfg = { dbPath, runnerSocket, host: "localhost", port: (web.address() as AddressInfo).port } as InstallConfig;
  await assert.rejects(verifyUpdateIdle(cfg), /maintenance/);
  acknowledged = false;
  await assert.rejects(verifyUpdateIdle(cfg), /maintenance/);
  acknowledged = true;
  for (const status of ["running", "awaiting_input", "awaiting_approval", "queued"]) {
    db.prepare("INSERT INTO tasks VALUES (?)").run(status);
    assert.equal(await verifyUpdateIdle(cfg), false, status);
    db.exec("DELETE FROM tasks");
  }
  turns = ["still-alive"];
  assert.equal(await verifyUpdateIdle(cfg), false);
  turns = [];
  assert.equal(await verifyUpdateIdle(cfg), true);
  await assert.rejects(runnerIsIdle(join(directory, "missing.sock")), /cannot verify runner activity/);
});

test("maintenance releases normally and a reused PID cannot retain an old window", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "palmagent-update-owner-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const dbPath = join(directory, "tasks.db");
  const release = beginUpdateMaintenance(dbPath);
  assert.equal(isUpdateMaintenance(dbPath), true);
  assert.throws(() => beginUpdateMaintenance(dbPath), /already active/);
  release();
  assert.equal(isUpdateMaintenance(dbPath), false);
  writeFileSync(maintenancePath(dbPath), JSON.stringify({ schemaVersion: 1, pid: process.pid, identity: "a-prior-boot:1" }));
  assert.equal(isUpdateMaintenance(dbPath), false);
  beginUpdateMaintenance(dbPath)();
  writeFileSync(maintenancePath(dbPath), "malformed");
  assert.equal(isUpdateMaintenance(dbPath), true, "unreadable ownership must fail closed");
});
