import assert from "node:assert/strict";
import { mock } from "node:test";
import { test } from "@playwright/test";
import { createApi, ApiError } from "../../src/api-client";
import { cacheSession, resetClientSession } from "../../src/query-lifecycle";
import { MESSAGE_PROTOCOL_HEADER, MESSAGE_PROTOCOL_VERSION } from "@palmagent/shared/http";

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

for (const operation of ["read", "logout"] as const) {
  test(`a delayed ${operation} 401 cannot invalidate a newer session`, async () => {
    let complete!: (response: Response) => void;
    let sent!: () => void;
    let active = 0, unauthorized = 0;
    const sending = new Promise<void>(resolve => { sent = resolve; });
    const response = new Promise<Response>(resolve => { complete = resolve; });
    const api = createApi({
      version: () => "fixture", observeServerVersion: () => {},
      beginBrowserWork: () => { active++; return () => { active--; }; },
      onUnauthorized: () => { unauthorized++; },
    }, async () => { sent(); return response; });
    const pending = operation === "read" ? api.getTask("fixture") : api.auth.logout();
    await sending;
    resetClientSession();
    const current = cacheSession();
    complete(Response.json({ error: "unauthorized" }, { status: 401 }));
    await assert.rejects(pending, /Session changed/);
    assert.equal(cacheSession(), current);
    assert.equal(unauthorized, 0);
    assert.equal(active, 0);
  });
}

test("auth writes retire the session only after confirmed success", async () => {
  let response = Promise.withResolvers<Response>();
  const api = createApi({
    version: () => "fixture", observeServerVersion: () => {},
    beginBrowserWork: () => () => {}, onUnauthorized: () => assert.fail("unexpected 401"),
  }, () => response.promise);
  const generation = cacheSession();
  const failed = api.auth.logout();
  assert.equal(cacheSession(), generation);
  response.resolve(Response.json({ error: "unavailable" }, { status: 503 }));
  await assert.rejects(failed, { status: 503 });
  assert.equal(cacheSession(), generation);
  response = Promise.withResolvers<Response>();
  const successful = api.auth.logout();
  assert.equal(cacheSession(), generation);
  response.resolve(Response.json({ ok: true }));
  await successful;
  assert.equal(cacheSession(), generation + 1);
});

test("message retry retains the exact payload and browser-work hold through maintenance and a lost response", async () => {
  let active = 0;
  const bodies: string[] = [];
  const input = { clientMessageId: "11111111-1111-4111-8111-111111111111", text: "Original", mode: "send" as const, expectedRunId: "original-run" };
  const api = createApi({
    version: () => "old-screen", observeServerVersion: () => {},
    beginBrowserWork: () => { active++; return () => { active--; }; }, onUnauthorized: () => assert.fail("unexpected 401"),
  }, async (_url, init) => {
    assert.equal(active, 1, "the PWA must not replace an unresolved submission");
    assert.equal(new Headers(init?.headers).get(MESSAGE_PROTOCOL_HEADER), MESSAGE_PROTOCOL_VERSION);
    bodies.push(String(init?.body));
    if (bodies.length === 1) {
      input.text = "A later draft";
      return Response.json({ error: "Updating", code: "update_in_progress" }, { status: 503 });
    }
    if (bodies.length === 2) throw new TypeError("Failed to fetch");
    return Response.json({ revision: 2, paused: false, runId: "original-run", messages: [] });
  });
  const queue = await api.submitMessage("retry-fixture", input);
  assert.equal(queue.revision, 2);
  assert.equal(bodies.length, 3);
  assert.equal(new Set(bodies).size, 1);
  assert.equal(JSON.parse(bodies[0]).text, "Original");
  assert.equal(active, 0);
});

test("first-message retry keeps its creation ID; legacy creation without an ID never retries", async () => {
  const bodies: string[] = [];
  const api = createApi({ version: () => "fixture", observeServerVersion: () => {}, beginBrowserWork: () => () => {}, onUnauthorized: () => {} },
    async (_url, init) => {
      if (init?.method === "GET") return Response.json({ error: "Not found" }, { status: 404 });
      bodies.push(String(init?.body));
      const input = JSON.parse(String(init?.body));
      if (!input.clientRequestId || bodies.length === 1) return Response.json({ error: "Updating", code: "update_in_progress" }, { status: 503 });
      return Response.json({ task: { taskId: `t_${input.clientRequestId}` } });
    });
  const request = { repoId: "r", agent: "codex" as const, prompt: "Hello", clientRequestId: "11111111-1111-4111-8111-111111111111" };
  assert.equal((await api.createTask(request)).taskId, `t_${request.clientRequestId}`);
  assert.equal(bodies[0], bodies[1]);
  await assert.rejects(api.createTask({ repoId: "r", agent: "codex", prompt: "Legacy" }), { status: 503 });
  assert.equal(bodies.length, 3);
});

test("a session change cancels a pending retry before it can submit with new credentials", async () => {
  let active = 0, calls = 0;
  let sent!: () => void;
  const called = new Promise<void>(resolve => { sent = resolve; });
  const api = createApi({ version: () => "fixture", observeServerVersion: () => {},
    beginBrowserWork: () => { active++; return () => { active--; }; }, onUnauthorized: () => {} }, async () => {
    calls++; sent();
    return Response.json({ error: "Updating", code: "update_in_progress" }, { status: 503 });
  });
  const pending = api.submitMessage("session-retry", { clientMessageId: "11111111-1111-4111-8111-111111111111", text: "Private", mode: "queue", expectedRunId: null });
  await called;
  resetClientSession();
  await assert.rejects(pending, /Session changed/);
  assert.equal(calls, 1);
  assert.equal(active, 0);
});

for (const code of ["update-required", "conflict", "unauthorized"]) test(`message retries stop on ${code}`, async () => {
  let calls = 0;
  const api = createApi({ version: () => "fixture", observeServerVersion: () => {}, beginBrowserWork: () => () => {}, onUnauthorized: () => {} },
    async () => { calls++; return Response.json({ error: code, code }, { status: code === "unauthorized" ? 401 : 409 }); });
  await assert.rejects(api.submitMessage(`no-retry-${code}`, { clientMessageId: "11111111-1111-4111-8111-111111111111", text: "Hello", mode: "queue", expectedRunId: null }));
  assert.equal(calls, 1);
});

test("a hung submission has a bounded wait and always releases the PWA hold", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  let active = 0;
  let sent!: () => void;
  const called = new Promise<void>(resolve => { sent = resolve; });
  const api = createApi({ version: () => "fixture", observeServerVersion: () => {},
    beginBrowserWork: () => { active++; return () => { active--; }; }, onUnauthorized: () => {} }, async () => {
    sent(); return new Promise<Response>(() => {});
  });
  try {
    const rejected = assert.rejects(api.submitMessage("timeout-fixture", {
      clientMessageId: "11111111-1111-4111-8111-111111111111", text: "Preserve this", mode: "queue", expectedRunId: null,
    }), /Connection did not recover/);
    await called;
    mock.timers.tick(120_000);
    await rejected;
    assert.equal(active, 0);
  } finally { mock.timers.reset(); }
});

for (const operation of ["message", "creation"] as const) {
  test(`a slow attachment ${operation} survives both old timeouts without restarting the upload`, async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    let active = 0, calls = 0;
    let signal: AbortSignal | null | undefined;
    const called = Promise.withResolvers<void>();
    const response = Promise.withResolvers<Response>();
    const api = createApi({ version: () => "fixture", observeServerVersion: () => {},
      beginBrowserWork: () => { active++; return () => { active--; }; }, onUnauthorized: () => {} }, async (_url, init) => {
      calls++; signal = init?.signal; called.resolve(); return response.promise;
    });
    try {
      const images = [{ mediaType: "application/octet-stream", data: "A".repeat(20 * 1024 * 1024), file: { name: "archive.zip" } }];
      const id = "11111111-1111-4111-8111-111111111111";
      const pending = operation === "message"
        ? api.submitMessage("slow-upload", { clientMessageId: id, text: "Archive", mode: "queue", expectedRunId: null, images })
        : api.createTask({ clientRequestId: id, repoId: "r", agent: "codex", prompt: "Archive", images });
      await called.promise;
      mock.timers.tick(130_000);
      assert.equal(signal?.aborted, false, "an in-flight upload must survive the former 15-second and 2-minute limits");
      assert.equal(active, 1, "keep the PWA from replacing a pending upload");
      response.resolve(Response.json({ task: { taskId: "uploaded" }, revision: 1, messages: [] }));
      await pending;
      assert.equal(calls, 1);
      assert.equal(active, 0);
    } finally { resetClientSession(); mock.timers.reset(); }
  });
}

test("an unresponsive attachment upload still has a bounded deadline and releases browser work", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  let active = 0;
  const called = Promise.withResolvers<void>();
  const api = createApi({ version: () => "fixture", observeServerVersion: () => {},
    beginBrowserWork: () => { active++; return () => { active--; }; }, onUnauthorized: () => {} }, async () => {
    called.resolve(); return new Promise<Response>(() => {});
  });
  try {
    const rejected = assert.rejects(api.submitMessage("hung-upload", {
      clientMessageId: "11111111-1111-4111-8111-111111111111", text: "Archive", mode: "queue", expectedRunId: null,
      images: [{ mediaType: "application/octet-stream", data: "AAAA", file: { name: "archive.zip" } }],
    }), /Connection did not recover/);
    await called.promise;
    mock.timers.tick(60 * 60_000);
    await rejected;
    assert.equal(active, 0);
  } finally { mock.timers.reset(); }
});
