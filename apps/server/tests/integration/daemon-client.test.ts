import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { daemonRequest } from "../../src/platform/process/daemon-client.js";

async function fixture(t: TestContext, respond: (socket: Socket, request: unknown) => void) {
  const data = mkdtempSync(join(tmpdir(), "palmagent-direct-control-"));
  const directory = `/tmp/palmagentd-${process.getuid!()}-${createHash("sha256").update(data).digest("hex").slice(0, 20)}`;
  mkdirSync(directory, { mode: 0o700 });
  mkdirSync(join(data, "daemon"), { mode: 0o700 });
  // A pre-routine launcher must never parse or block the new control request.
  writeFileSync(join(data, "daemon/launcher"), "#!/bin/sh\nexit 97\n", { mode: 0o700 });
  let requests = 0;
  const server = createServer(socket => {
    let input = "";
    socket.on("error", () => {});
    socket.on("data", chunk => {
      input += chunk;
      if (!input.includes("\n")) return;
      requests++;
      respond(socket, JSON.parse(input));
    });
  });
  const socket = join(directory, "control.sock");
  await new Promise<void>(resolve => server.listen(socket, resolve));
  chmodSync(socket, 0o600);
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    rmSync(directory, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  });
  return { data, socket, requests: () => requests };
}

test("new routine requests reach the daemon without executing an obsolete launcher", async t => {
  const f = await fixture(t, (socket, envelope) => {
    assert.deepEqual(envelope, { protocol: 1, request: { action: "inspect", kind: "routine", id: "17" } });
    socket.write('{"protocol":1,"ok":true,"result":');
    setImmediate(() => socket.end('{"alive":false,"state":"absent"}}\n'));
  });
  assert.deepEqual(await daemonRequest(f.data, { action: "inspect", kind: "routine", id: "17" }), { alive: false, state: "absent" });
  assert.equal(f.requests(), 1);
});

test("uncertain delivery is rejected without resending a launch", async t => {
  const f = await fixture(t, socket => socket.destroy());
  await assert.rejects(daemonRequest(f.data, { action: "launch", kind: "execution", id: "aa" }), /delivery is unconfirmed/);
  assert.equal(f.requests(), 1);
});

for (const [reply, error] of [
  ['{"protocol":2,"ok":true,"result":{}}\n', /Incompatible daemon protocol/],
  ['{"protocol":1,"ok":false,"error":"private detail"}\n', /request failed/],
  ["x".repeat(65_537), /response is too large/],
] as const) test(`daemon response validation: ${error.source}`, async t => {
  const f = await fixture(t, socket => socket.end(reply));
  await assert.rejects(daemonRequest(f.data, { action: "status" }), error);
  assert.equal(f.requests(), 1);
});

test("a non-private control socket is rejected before sending", async t => {
  const f = await fixture(t, socket => socket.end());
  chmodSync(f.socket, 0o666);
  await assert.rejects(daemonRequest(f.data, { action: "status" }), /private and owned/);
  assert.equal(f.requests(), 0);
});


test("host inventory sends an explicit read-only pagination cursor", async t => {
  const f = await fixture(t, (socket, envelope) => {
    assert.deepEqual(envelope, { protocol: 1, request: { action: "list", after: "terminal-ab" } });
    socket.end(JSON.stringify({ protocol: 1, ok: true, result: { hosts: [], next: null } }) + "\n");
  });
  assert.deepEqual(await daemonRequest(f.data, { action: "list", after: "terminal-ab" }), { hosts: [], next: null });
  assert.equal(f.requests(), 1);
});

test("web activation can reply after the former transport deadline without a second launch", async t => {
  let respond!: () => void;
  let received!: () => void;
  const onReceived = new Promise<void>(resolve => { received = resolve; });
  const f = await fixture(t, (socket, envelope) => {
    assert.deepEqual(envelope, { protocol: 1, request: { action: "restart-web" } });
    respond = () => socket.end('{"protocol":1,"ok":true,"result":{"alive":true,"state":"running"}}\n');
    received();
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const activation = daemonRequest(f.data, { action: "restart-web" });
  await onReceived;
  t.mock.timers.tick(41_000);
  respond();
  assert.deepEqual(await activation, { alive: true, state: "running" });
  assert.equal(f.requests(), 1);
});

for (const [action, deadline] of [["status", 40_000], ["restart-web", 95_000]] as const) {
  test(`${action} retains a bounded deadline and never retries uncertain delivery`, async t => {
    let received!: () => void;
    const onReceived = new Promise<void>(resolve => { received = resolve; });
    const f = await fixture(t, () => received());
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const request = daemonRequest(f.data, { action });
    const rejection = assert.rejects(request, /timed out; delivery is unconfirmed/);
    await onReceived;
    t.mock.timers.tick(deadline);
    await rejection;
    assert.equal(f.requests(), 1);
  });
}
