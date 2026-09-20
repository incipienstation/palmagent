import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { authBudget } from "../src/http/auth-budget.js";

test("authentication budget bounds work despite spoofed forwarding headers, then recovers", async () => {
  let time = 0;
  let handled = 0;
  const app = new Hono().use("*", authBudget(() => time)).all("*", c => { handled++; return c.text("ok"); });
  for (let i = 0; i < 40; i++) {
    assert.equal((await app.request("/api/auth/login/options", { method: "POST", headers: { "X-Forwarded-For": `192.0.2.${i}` } })).status, 200);
  }
  const limited = await app.request("/api/auth/register/options", { method: "POST" });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("Retry-After"), "1");
  assert.equal(handled, 40);
  assert.equal((await app.request("/api/health")).status, 200);
  assert.equal((await app.request("/api/tasks", { method: "POST" })).status, 200);
  time = 50;
  assert.equal((await app.request("/api/auth/login/options", { method: "POST" })).status, 200);
  assert.equal((await app.request("/api/auth/login/options", { method: "POST" })).status, 429);
  time = 100_000;
  for (let i = 0; i < 40; i++) assert.equal((await app.request("/api/auth/logout", { method: "POST" })).status, 200);
  assert.equal((await app.request("/api/auth/logout", { method: "POST" })).status, 429);
});
