import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { readStream } from "../../src/platform/http/read-stream.js";

test("read streams revalidate on every connection and release subscriptions on shutdown", async () => {
  const shutdown = new AbortController();
  let active = 0, changed = () => {};
  const app = new Hono().get("/stream", c => readStream(c, notify => {
    active++; changed = notify;
    return () => { active--; };
  }, 15000, shutdown.signal));
  const response = await app.request("/stream");
  assert.match(response.headers.get("cache-control")!, /no-store/);
  assert.equal(response.headers.get("x-accel-buffering"), "no");
  const reader = response.body!.getReader();
  const read = async () => new TextDecoder().decode((await reader.read()).value);
  assert.match(await read(), /read-change/);
  assert.equal(active, 1);
  changed(); assert.match(await read(), /read-change/);
  shutdown.abort();
  await reader.cancel();
  assert.equal(active, 0);
});

test("request abort and already aborted shutdown never leave live observers", async () => {
  let active = 0;
  const shutdown = new AbortController();
  const app = new Hono().get("/stream", c => readStream(c, () => {
    active++;
    return () => { active--; };
  }, 15000, shutdown.signal));
  const abort = new AbortController();
  const response = await app.request("/stream", { signal: abort.signal });
  const reader = response.body!.getReader();
  await reader.read(); abort.abort(); await reader.cancel();
  assert.equal(active, 0);
  shutdown.abort();
  const closed = await app.request("/stream");
  await closed.body!.cancel();
  assert.equal(active, 0);
});
