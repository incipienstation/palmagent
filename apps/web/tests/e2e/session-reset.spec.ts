import { test, expect, type Page } from "@playwright/test";
import { tasks } from "../fixtures.mjs";

test.use({ serviceWorkers: "block" });

type SessionHarness = {
  connections: Array<{ url: string; closed: boolean; onmessage?: (event: MessageEvent) => void }>;
};

async function installStreams(page: Page) {
  await page.addInitScript(tasks => {
    const connections: SessionHarness["connections"] = [];
    class Stream {
      url: string;
      closed = false;
      onopen?: (event: Event) => void;
      onmessage?: (event: MessageEvent) => void;
      constructor(url: string) {
        this.url = url;
        connections.push(this);
        queueMicrotask(() => {
          this.onopen?.(new Event("open"));
          this.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ type: "tasks", tasks }) }));
        });
      }
      close() { this.closed = true; }
    }
    window.EventSource = Stream as unknown as typeof EventSource;
    Object.assign(window, { connections });
  }, tasks);
}

async function resetFromOtherTab(page: Page) {
  const other = await page.context().newPage();
  try {
    await other.goto(new URL("/manifest.webmanifest", page.url()).href);
    await other.evaluate(() => {
      const channel = new BroadcastChannel("palmagent-cache");
      channel.postMessage("session");
      channel.close();
    });
    await expect(page.getByRole("button", { name: "Sign in with passkey" })).toBeVisible();
  } finally { await other.close(); }
}

test("a remote session reset hides cached history, closes streams and discards its checkpoint", async ({ page }) => {
  await installStreams(page);
  await page.route("**/api/tasks/t-idle-rich/history?*", route => route.fulfill({ json: {
    events: [{ seq: 1, event: { taskId: "t-idle-rich", agent: "codex", ts: 1, kind: "assistant_text",
      payload: { text: "Previous session response" } } }], before: null, cursor: 1,
  } }));
  await page.goto("/#/task/t-idle-rich");
  await expect(page.getByText("Previous session response", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as SessionHarness).connections.filter(s => !s.closed).map(s => s.url).sort())).toEqual([
    "/api/stream?snapshots=1", "/api/stream?task=t-idle-rich&details=summary",
  ].sort());
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("palmagent-screen-state", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("checkpoints");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("checkpoints", "readwrite");
      tx.objectStore("checkpoints").put({ values: { transcript: "Previous session response" } }, "previous-session");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    sessionStorage.setItem("palmagent:screen-checkpoint", "previous-session");
  });

  await resetFromOtherTab(page);
  await expect(page.getByText("Previous session response", { exact: true })).toHaveCount(0);
  const closedCount = await page.evaluate(() => (window as unknown as SessionHarness).connections.length);
  expect(await page.evaluate(() => (window as unknown as SessionHarness).connections.every(s => s.closed))).toBe(true);
  expect(await page.evaluate(() => sessionStorage.getItem("palmagent:screen-checkpoint"))).toBeNull();
  await expect.poll(() => page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>(resolve => {
      const request = indexedDB.open("palmagent-screen-state", 1);
      request.onsuccess = () => resolve(request.result);
    });
    try {
      return await new Promise(resolve => {
        const request = db.transaction("checkpoints").objectStore("checkpoints").get("previous-session");
        request.onsuccess = () => resolve(request.result ?? null);
      });
    } finally { db.close(); }
  })).toBeNull();

  // Deliver a callback already queued by a retired connection, then foreground
  // the page. Neither may reopen a stream or restore the protected screen.
  await page.evaluate(() => {
    for (const source of (window as unknown as SessionHarness).connections) {
      source.onmessage?.(new MessageEvent("message", { lastEventId: "2", data: JSON.stringify({ type: "event",
        event: { taskId: "t-idle-rich", agent: "codex", ts: 2, kind: "assistant_text", payload: { text: "Late session response" } },
      }) }));
    }
    window.dispatchEvent(new Event("online"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.getByRole("button", { name: "Sign in with passkey" })).toBeVisible();
  await expect(page.getByText("Late session response", { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as SessionHarness).connections.length)).toBe(closedCount);
});

test("an auth probe started before a remote reset cannot reopen the authenticated app", async ({ page }) => {
  let release!: () => void;
  let started = false;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/auth/me", async route => {
    started = true;
    await pending;
    await route.fulfill({ json: { required: true, authenticated: true, credentialCount: 1 } });
  });
  await page.goto("/");
  await expect.poll(() => started).toBe(true);
  await resetFromOtherTab(page);
  const response = page.waitForResponse("**/api/auth/me");
  release();
  await (await response).finished();
  await expect(page.getByRole("button", { name: "Sign in with passkey" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open navigation", exact: true })).toHaveCount(0);
});
