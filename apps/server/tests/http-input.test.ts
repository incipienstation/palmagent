import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { hc } from "hono/client";
import { EmptyBodySchema, HistoryQuerySchema, IdParamsSchema, RegisterOptionsSchema, RenameTaskSchema } from "@palmagent/shared/requests";
import { jsonBody, params, query } from "../src/http/input.js";
import { handleError } from "../src/http/errors.js";

test("validated JSON preserves empty bodies, missing content types, and safe errors", async () => {
  let mutations = 0;
  const app = new Hono().onError(handleError)
    .post("/empty", jsonBody(EmptyBodySchema), (c) => c.json(c.req.valid("json"), 200))
    .post("/register", jsonBody(RegisterOptionsSchema), (c) => c.json(c.req.valid("json"), 200))
    .patch("/rename", jsonBody(RenameTaskSchema), (c) => { mutations++; return c.json(c.req.valid("json"), 200); });
  for (const path of ["/empty", "/register"]) {
    for (const headers of [undefined, { "content-type": "application/json" }]) {
      const response = await app.request(path, { method: "POST", headers });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {});
    }
  }
  for (const headers of [undefined, { "content-type": "text/plain" }, { "content-type": "application/json" }]) {
    const response = await app.request("/rename", { method: "PATCH", headers, body: '{"title":"  updated  ","ignored":true}' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { title: "updated" });
  }
  for (const body of ["{", "null", "[]", '{"title":12}', '{"title":"private\\nvalue"}']) {
    const response = await app.request("/rename", { method: "PATCH", body });
    assert.equal(response.status, 400);
    assert.doesNotMatch(await response.text(), /private|value/);
  }
  assert.equal(mutations, 3);
});

test("Hono RPC preserves encoded params and validates history cursor strings", async () => {
  const app = new Hono().onError(handleError).get("/tasks/:id", params(IdParamsSchema), query(HistoryQuerySchema), (c) =>
    c.json({ id: c.req.valid("param").id, before: c.req.valid("query").before }, 200));
  const client = hc<typeof app>("http://localhost", { fetch: (input: string | Request | URL, init?: RequestInit) => app.request(input instanceof URL ? input.toString() : input, init) });
  const response = await client.tasks[":id"].$get({ param: { id: encodeURIComponent("id /?#한") }, query: { before: "12" } });
  assert.deepEqual(await response.json(), { id: "id /?#한", before: "12" });
  const repeated = await app.request("/tasks/fixture?before=12&before=invalid");
  assert.deepEqual(await repeated.json(), { id: "fixture", before: "12" });
  for (const before of ["0", "-1", "NaN", "9007199254740992"]) {
    assert.equal((await app.request(`/tasks/fixture?before=${before}`)).status, 400);
  }
});
