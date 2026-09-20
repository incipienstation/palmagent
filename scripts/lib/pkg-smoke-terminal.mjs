import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Exercise the installed native addon and bundled host, without touching systemd. */
export async function smokeTerminal(pkgDir, scratch, env) {
  if (process.platform !== "linux") return;
  const require = createRequire(join(pkgDir, "package.json"));
  const Database = require("better-sqlite3");
  const directory = join(scratch, "terminal-state");
  mkdirSync(directory, { mode: 0o700 });
  const db = new Database(join(directory, "registry.sqlite"));
  db.exec("CREATE TABLE terminals (id TEXT PRIMARY KEY, request_id TEXT UNIQUE NOT NULL, record TEXT NOT NULL)");
  const id = randomUUID();
  const record = { id, requestId: randomUUID(), repoId: "smoke", title: "Smoke", initialCwd: scratch,
    release: pkgDir, node: process.execPath, directory, cols: 80, rows: 24, state: "starting", createdAt: Date.now(), protocol: 1 };
  db.prepare("INSERT INTO terminals VALUES (?, ?, ?)").run(id, record.requestId, JSON.stringify(record));
  const socketRoot = join("/tmp", "palmagent-term-" + process.getuid() + "-" + createHash("sha256").update(directory).digest("hex").slice(0, 12));
  const child = spawn(process.execPath, [join(pkgDir, "terminal-host.js"), directory, id], { env, cwd: scratch, stdio: ["ignore", "ignore", "pipe"] });
  let errorOutput = "";
  child.stderr.on("data", data => { errorOutput = (errorOutput + data).slice(-8000); });
  const exited = new Promise(resolve => child.once("exit", resolve));
  const sockets = [];
  const wait = async predicate => {
    const deadline = Date.now() + 10_000;
    while (!predicate()) {
      assert.equal(child.exitCode, null, "bundled terminal host exited early: " + errorOutput);
      assert(Date.now() < deadline, "bundled terminal did not become ready");
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  const attach = async () => {
    const socket = createConnection(join(socketRoot, id + ".sock"));
    sockets.push(socket);
    await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    const frames = [];
    let buffer = "";
    socket.setEncoding("utf8");
    const send = value => socket.write(JSON.stringify(value) + "\n");
    socket.on("data", data => {
      buffer += data;
      let end;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const frame = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); frames.push(frame);
        if ("seq" in frame) send({ type: "ack", seq: frame.seq });
      }
    });
    await wait(() => frames.some(frame => frame.type === "snapshot"));
    return { socket, frames, send };
  };
  try {
    const { existsSync } = await import("node:fs");
    await wait(() => JSON.parse(db.prepare("SELECT record FROM terminals WHERE id = ?").get(id).record).state === "running");
    assert(existsSync(join(socketRoot, id + ".sock")), "a ready terminal must have its endpoint available");
    const first = await attach();
    first.send({ type: "claim-control" });
    await wait(() => first.frames.some(frame => frame.type === "control" && frame.writable));
    const epoch = first.frames.filter(frame => frame.type === "control").at(-1).epoch;
    first.send({ type: "input", epoch, data: "printf 'PACKED-%s\\n' 'TERMINAL'\r" });
    await wait(() => first.frames.some(frame => frame.type === "output" && frame.data.includes("PACKED-TERMINAL")));
    first.socket.destroy();
    // No connected viewer owns the process lifetime.
    await new Promise(resolve => setTimeout(resolve, 100));
    const next = await attach();
    assert(next.frames.some(frame => frame.type === "snapshot" && frame.data.includes("PACKED-TERMINAL")));
    assert.equal(JSON.parse(db.prepare("SELECT record FROM terminals WHERE id = ?").get(id).record).pid, child.pid);
    console.log("[smoke] packaged PTY host survives detach and restores its screen");
  } finally {
    for (const socket of sockets) socket.destroy();
    if (child.exitCode === null) child.kill("SIGTERM");
    const force = setTimeout(() => child.kill("SIGKILL"), 5000);
    await exited; clearTimeout(force);
    db.close();
    rmSync(socketRoot, { recursive: true, force: true });
  }
}
