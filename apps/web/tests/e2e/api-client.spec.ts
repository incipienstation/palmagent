import assert from "node:assert/strict";
import { test } from "@playwright/test";
import { createApi, ApiError } from "../../src/api-client";

test("browser RPC preserves URL encoding, version headers, write tracking, and abort signals", async () => {
  let active = 0;
  const observed: Array<string | null> = [];
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const api = createApi({
    version: () => "fixture-client", observeServerVersion: (version) => observed.push(version),
    beginBrowserWork: () => { active++; return () => { active--; }; }, onUnauthorized: () => assert.fail("unexpected 401"),
  }, async (input, init) => {
    assert.equal(active, init?.method === "GET" ? 0 : 1);
    assert.equal(new Headers(init?.headers).get("x-palmagent-version"), "fixture-client");
    calls.push({ url: String(input), init: init! });
    return Response.json({ task: { taskId: "fixture" } }, { headers: { "x-palmagent-version": "fixture-server" } });
  });
  const id = "id /?#한";
  await api.renameTask(id, { title: "updated" });
  assert.equal(active, 0);
  assert.equal(calls[0].url, `/api/tasks/${encodeURIComponent(id)}`);
  assert.equal(calls[0].init.method, "PATCH");
  assert.equal(calls[0].init.body, '{"title":"updated"}');
  assert.equal(new Headers(calls[0].init.headers).get("content-type"), "application/json");
  const signal = new AbortController().signal;
  await api.taskHistory(id, 12, "full", signal);
  assert.equal(calls[1].url, `/api/tasks/${encodeURIComponent(id)}/history?before=12`);
  assert.equal(calls[1].init.signal, signal);
  await api.taskHistoryChanges(id, 4, 12, "summary", signal);
  assert.equal(calls[2].url, `/api/tasks/${encodeURIComponent(id)}/history/changes?after=4&through=12&details=summary`);
  assert.equal(calls[2].init.signal, signal);
  await api.taskHistory(id);
  assert.equal(calls[3].url, `/api/tasks/${encodeURIComponent(id)}/history`);
  await api.validateRepoPath("/space ?#한");
  assert.equal(new URL(calls[4].url, "http://localhost").searchParams.get("path"), "/space ?#한");
  assert.deepEqual(observed, Array(5).fill("fixture-server"));
});

test("browser RPC keeps auth probes local and releases writes after every failure", async () => {
  let active = 0;
  let unauthorized = 0;
  let response = () => Response.json({ error: "unauthorized" }, { status: 401 });
  const api = createApi({
    version: () => "fixture", observeServerVersion: () => {},
    beginBrowserWork: () => { active++; return () => { active--; }; }, onUnauthorized: () => { unauthorized++; },
  }, async () => response());
  await assert.rejects(api.auth.loginOptions(), { status: 401 });
  assert.equal(unauthorized, 0);
  await assert.rejects(api.createRepo({ path: "/fixture" }), { status: 401 });
  assert.equal(unauthorized, 1);
  assert.equal(active, 0);
  response = () => Response.json({ error: "Refresh the app", code: "update-required" }, { status: 409 });
  await assert.rejects(api.stop("fixture"), (error: unknown) =>
    error instanceof ApiError && error.status === 409 && error.code === "update-required" && error.message === "Refresh the app");
  assert.equal(active, 0);
  response = () => Response.json({ error: "invalid", code: 42 }, { status: 400 });
  await assert.rejects(api.stop("fixture"), (error: unknown) =>
    error instanceof ApiError && error.status === 400 && error.code === undefined);
  response = () => new Response("<html>too large</html>", { status: 413 });
  await assert.rejects(api.push.subscribe({ endpoint: "https://push.example/sub" }), (error: unknown) =>
    error instanceof ApiError && error.status === 413 && error.message.includes("Request too large for the proxy"));
  assert.equal(active, 0);
  response = () => { throw new Error("network failure"); };
  await assert.rejects(api.stop("fixture"), /network failure/);
  assert.equal(active, 0);
  response = () => new Response("invalid JSON", { status: 200 });
  await assert.rejects(api.cancel("fixture"), SyntaxError);
  assert.equal(active, 0);
});

test("typed API reads leave caching to TanStack Query", async () => {
  let reads = 0;
  const api = createApi({
    version: () => "fixture", observeServerVersion: () => {},
    beginBrowserWork: () => () => {}, onUnauthorized: () => {},
  }, async (_input, init) => {
    assert.equal(init?.cache, "no-store");
    reads++;
    return Response.json({ repos: [{ id: String(reads) }] });
  });
  await Promise.all([api.listRepos(), api.listRepos()]);
  assert.equal(reads, 2);
  assert.equal((await api.listRepos())[0]?.id, "3");
  assert.equal(reads, 3);
});

test("runtime model catalog API leaves cache behavior to TanStack Query", async () => {
  let reads = 0;
  const api = createApi({
    version: () => "fixture", observeServerVersion: () => {},
    beginBrowserWork: () => () => {}, onUnauthorized: () => assert.fail("unexpected 401"),
  }, async (input) => {
    assert.equal(String(input), "/api/model-catalog");
    reads++;
    return Response.json({ agent: "codex", source: "runtime", fetchedAt: 1, models: [{ value: "default", label: "default", efforts: [{ value: "default", label: "default" }] }] });
  });
  await Promise.all([api.modelCatalog(), api.modelCatalog()]);
  assert.equal(reads, 2);
  await api.modelCatalog();
  assert.equal(reads, 3);
});
