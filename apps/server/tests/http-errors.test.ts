import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { handleError } from "../src/http/errors.js";
import { createSessionApp } from "../src/local/app.js";
import { HttpError } from "../src/service.js";

const input = { agent: "codex", sessionId: "fixture", cwd: "/fixture", home: "/fixture", waitPid: 1 };

test("local dispatch preserves domain error statuses and masks unexpected failures", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  for (const status of [400, 409, 503]) {
    const app = createSessionApp({ dispatchSession() { throw new HttpError(status, "domain failure"); } });
    const response = await app.request("/dispatch", { method: "POST", body: JSON.stringify(input) });
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error: "domain failure" });
  }
  assert.equal(logged.mock.callCount(), 0);
  const failure = new Error("private internal failure");
  const app = createSessionApp({ dispatchSession() { throw failure; } });
  const response = await app.request("/dispatch", { method: "POST", body: JSON.stringify(input) });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "internal server error" });
  assert.deepEqual(logged.mock.calls[0].arguments, ["HTTP request failed", failure]);
});

test("Hono exceptions preserve explicit responses and protocol headers", async () => {
  const app = new Hono().onError(handleError);
  app.use("*", async (c, next) => { c.header("X-Palmagent-Version", "fixture"); await next(); });
  app.get("/limited", () => { throw new HTTPException(429, {
    res: new Response(JSON.stringify({ error: "slow down" }), {
      status: 429, headers: { "Retry-After": "60", "Content-Type": "application/json" },
    }),
  }); });
  app.get("/auth", () => { throw new HTTPException(401, {
    res: new Response("authentication required", { status: 401, headers: { "WWW-Authenticate": "Bearer" } }),
  }); });
  app.get("/message", () => { throw new HTTPException(403, { message: "forbidden" }); });
  const limited = await app.request("/limited");
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("Retry-After"), "60");
  assert.equal(limited.headers.get("X-Palmagent-Version"), "fixture");
  assert.deepEqual(await limited.json(), { error: "slow down" });
  const auth = await app.request("/auth");
  assert.equal(auth.status, 401);
  assert.equal(auth.headers.get("WWW-Authenticate"), "Bearer");
  assert.equal(await auth.text(), "authentication required");
  const message = await app.request("/message");
  assert.equal(message.status, 403);
  assert.deepEqual(await message.json(), { error: "forbidden" });
});
