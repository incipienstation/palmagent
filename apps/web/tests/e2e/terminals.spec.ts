import { test, expect, type Page, type WebSocketRoute } from "@playwright/test";
import { captureForReview, assertViewportLocked } from "./_helpers";

const id = "80a6a201-c6df-4229-ae7c-7b6b42b72d2f";

for (const layout of ["mobile"]) {
  test(`${layout} stopped shell offers recovery in its original target from All spaces`, async ({ page }) => {
    if (layout === "desktop") await page.setViewportSize({ width: 1440, height: 900 });
    const original = { id, repoId: "repo-app", ...(layout === "desktop" ? { taskId: "t-run" } : {}),
      title: "Shell", initialCwd: "/projects/sample-app", state: "lost", createdAt: 1, protocol: 1 };
    const requests: { target: unknown; requestId: string }[] = [];
    let created = false;
    await page.route("**/api/terminals**", async route => {
      if (route.request().method() === "POST") {
        requests.push(route.request().postDataJSON());
        // A failed request must leave a usable retry with the same idempotency key.
        if (requests.length === 1) {
          await route.fulfill({ status: 503, json: { error: "Temporarily unavailable" } });
          return;
        }
        created = true;
        await route.fulfill({ status: 201, json: { terminal: { ...original, id: "replacement", state: "starting" } } });
      } else await route.fulfill({ json: { terminals: [original, ...(created ? [{ ...original, id: "replacement", state: "starting" }] : [])],
        capabilities: { available: true, persistent: true } } });
    });
    await page.goto("/#/terminals");
    const region = page.getByRole("region", { name: "Terminals", exact: true });
    await expect(region.getByRole("button", { name: "New terminal", exact: true })).toBeEnabled();
    await expect(region.getByRole("combobox", { name: "Select terminal" })).toHaveText("Shell · Stopped");
    await expect(region.getByRole("combobox", { name: "Terminal Space" })).toHaveCount(0);
    const recover = region.getByRole("button", { name: "Open new terminal", exact: true });
    await expect(recover).toBeVisible();
    await expect(region.locator("header")).toHaveCount(1);
    await assertViewportLocked(page);
    await captureForReview(page, `terminal-recovery-${layout}.png`);
    await recover.focus();
    await page.keyboard.press("Enter");
    await expect(region.getByRole("alert")).toContainText("Temporarily unavailable");
    await expect(recover).toBeEnabled();
    if (layout === "desktop") await region.getByRole("button", { name: "New terminal", exact: true }).click();
    else await recover.click();
    await expect(region.getByRole("combobox", { name: "Select terminal" })).toHaveText("Shell · Starting");
    expect(requests).toHaveLength(2);
    expect(requests[0].target).toEqual({ repoId: "repo-app" });
    expect(requests[1]).toEqual(requests[0]);
  });
}

test("empty global terminals asks for a concrete Space before creation", async ({ page }) => {
  const requests: { target: unknown }[] = [];
  await page.route("**/api/terminals**", async route => {
    if (route.request().method() === "POST") {
      requests.push(route.request().postDataJSON());
      await route.fulfill({ status: 503, json: { error: "Temporarily unavailable" } });
    } else await route.fulfill({ json: { terminals: [], capabilities: { available: true, persistent: true } } });
  });
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/#/terminals");
  const picker = page.getByRole("combobox", { name: "Terminal Space" });
  await expect(picker).toHaveText("Choose a Space");
  await expect(page.getByRole("button", { name: "Open terminal", exact: true })).toBeDisabled();
  await picker.click();
  await expect(page.getByRole("option", { name: "All spaces", exact: true })).toHaveCount(0);
  await page.getByRole("option", { name: "sample-app", exact: true }).click();
  await expect(page.getByRole("button", { name: "Open terminal", exact: true })).toBeEnabled();
  await assertViewportLocked(page);
  await page.getByRole("button", { name: "Open terminal", exact: true }).click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].target).toEqual({ repoId: "repo-app" });
});

for (const available of [true, false]) {
  test(`exited task shell recovery preserves task context with services ${available ? "available" : "unavailable"}`, async ({ page }) => {
    const requests: { target: unknown }[] = [];
    let releaseCreate: (() => void) | undefined;
    await page.route("**/api/terminals**", async route => {
      if (route.request().method() === "POST") {
        requests.push(route.request().postDataJSON());
        await new Promise<void>(resolve => { releaseCreate = resolve; });
        await route.fulfill({ status: 503, json: { error: "Please retry" } });
      } else await route.fulfill({ json: {
        terminals: [{ id, repoId: "repo-app", taskId: "t-run", title: "Shell", initialCwd: "/projects/sample-app",
          state: "exited", exitCode: 1, createdAt: 1, protocol: 1 }],
        capabilities: { available, persistent: available, ...(!available ? { reason: "Terminal services unavailable" } : {}) },
      } });
    });
    await page.goto("/#/task/t-run");
    await page.getByRole("button", { name: "Task actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Open terminal" }).click();
    await expect(page.getByText("Shell exited · 1", { exact: true })).toBeVisible();
    const recover = page.getByRole("button", { name: "Open new terminal", exact: true });
    expect(requests).toHaveLength(0);
    if (!available) {
      await expect(recover).toBeDisabled();
      await expect(page.getByRole("button", { name: "New terminal", exact: true })).toBeDisabled();
      await expect(page.getByRole("alert")).toContainText("Terminal services unavailable");
      return;
    }
    await recover.click();
    try {
      await expect.poll(() => requests.length).toBe(1);
      expect(requests[0].target).toEqual({ taskId: "t-run" });
      await expect(page.getByRole("button", { name: "Opening terminal…", exact: true })).toBeDisabled();
      await expect(page.getByRole("button", { name: "New terminal", exact: true })).toBeDisabled();
    } finally { releaseCreate?.(); }
    await expect(page.getByRole("alert")).toContainText("Please retry");
    await expect(recover).toBeEnabled();
  });
}

async function terminalFixture(page: Page, options: { legacy?: boolean; occupied?: boolean } = {}) {
  let created = false, terminated = false, count = 0;
  const inputs: string[] = [];
  const claims: unknown[] = [];
  let owner: WebSocketRoute | "elsewhere" | undefined = options.occupied ? "elsewhere" : undefined;
  let epoch = 0;
  const sockets = new Set<WebSocketRoute>();
  const controls = () => {
    for (const ws of sockets) ws.send(JSON.stringify({ type: "control", writable: owner === ws, epoch,
      ...(options.legacy ? {} : { available: !owner }) }));
  };
  const terminal = () => ({ id, repoId: "repo-app", taskId: "t-run", title: "Shell", initialCwd: "/projects/sample-app",
    state: terminated ? "exited" : "running", createdAt: 1, protocol: 1 });
  await page.route("**/api/terminals**", async route => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    let value: unknown;
    if (url.pathname.endsWith("/attach-ticket")) value = { ticket: "test-ticket", protocol: 1 };
    else if (url.pathname.endsWith("/terminate")) { terminated = true; value = { terminal: terminal() }; }
    else if (method === "POST") { created = true; value = { terminal: terminal() }; }
    else value = { terminals: created ? [terminal()] : [], capabilities: { available: true, persistent: true } };
    await route.fulfill({ status: method === "POST" && url.pathname === "/api/terminals" ? 201 : 200, json: value });
  });
  await page.routeWebSocket("**/api/terminals/*/stream", ws => {
    count++;
    ws.onMessage(data => {
      const frame = JSON.parse(String(data));
      if (frame.type === "attach") {
        ws.send(JSON.stringify({ type: "snapshot", data: "Persistent shell\r\n$ ", seq: 1, cols: 40, rows: 15 }));
        sockets.add(ws); controls();
      } else if (frame.type === "claim-control") {
        claims.push(frame);
        if (!frame.ifAvailable || !owner) { owner = ws; epoch++; }
        controls();
      } else if (frame.type === "release-control") {
        if (owner === ws) { owner = undefined; epoch++; } controls();
      } else if (frame.type === "input" && owner === ws && frame.epoch === epoch) inputs.push(frame.data);
    });
    ws.onClose(() => { sockets.delete(ws); if (owner === ws) { owner = undefined; epoch++; } controls(); });
  });
  return { inputs, claims, connections: () => count, terminated: () => terminated,
    takeElsewhere() { owner = "elsewhere"; epoch++; controls(); },
    releaseElsewhere() { owner = undefined; epoch++; controls(); },
    disconnect(occupied = false) {
      for (const ws of sockets) ws.close();
      sockets.clear(); owner = occupied ? "elsewhere" : undefined; epoch++;
    },
  };
}

test("global terminals ignore a stale browsing scope; Space terminals use an explicit scope", async ({ page }) => {
  const requests: string[] = [];
  await page.addInitScript(() => localStorage.setItem("working-directory", "/projects/sample-app"));
  await page.route("**/api/terminals*", async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === "GET") requests.push(url.searchParams.get("repoId") ?? "all");
    await route.fulfill({ json: { terminals: [], capabilities: { available: true, persistent: true } } });
  });
  await page.goto("/#/terminals");
  await expect.poll(() => requests.includes("all")).toBe(true);
  await page.goto("/#/terminals/repo/repo-app");
  await page.getByRole("button", { name: "Terminal actions" }).click();
  await page.getByRole("menuitem", { name: "Terminal details" }).click();
  await expect(page.getByRole("combobox", { name: "Terminal Space" })).toHaveText("sample-app");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect.poll(() => requests.includes("repo-app")).toBe(true);
  await assertViewportLocked(page);
});

test("mobile task terminal keeps its shell when returning to conversation and requires explicit termination", async ({ page }) => {
  const f = await terminalFixture(page);
  await page.goto("/#/task/t-run");
  await page.getByRole("button", { name: "Task actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Open terminal" }).click();
  await page.getByRole("button", { name: "New terminal", exact: true }).click();
  await expect(page.getByText("Connected · sample-app", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Ctrl+C", exact: true })).toBeEnabled();
  await expect(page.locator(".xterm-helper-textarea")).not.toBeFocused();
  await expect(page.getByRole("button", { name: "Release control" })).toHaveCount(0);
  await page.getByRole("button", { name: "Ctrl+C", exact: true }).click();
  await expect.poll(() => f.inputs.includes("\x03")).toBe(true);
  await assertViewportLocked(page);
  await captureForReview(page, "terminal-mobile-dark.png");
  await page.getByRole("button", { name: "Back to conversation" }).click();
  expect(f.terminated()).toBe(false);
  await page.getByRole("button", { name: "Task actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Open terminal" }).click();
  await expect(page.getByText("Connected · sample-app", { exact: true })).toBeVisible();
  expect(f.connections()).toBe(2);
  await page.getByRole("button", { name: "Terminal actions" }).click();
  await page.getByRole("menuitem", { name: "Terminate terminal", exact: true }).click();
  await page.getByRole("button", { name: "Keep running", exact: true }).click();
  expect(f.terminated()).toBe(false);
  await page.getByRole("button", { name: "Terminal actions" }).click();
  await page.getByRole("menuitem", { name: "Terminate terminal", exact: true }).click();
  await page.getByRole("button", { name: "Terminate", exact: true }).click();
  await expect(page.getByText("Shell exited", { exact: true })).toBeVisible();
  expect(f.terminated()).toBe(true);
});
test("desktop shows conversation and terminal together; narrow light layout remains reachable", async ({ page }) => {
  await terminalFixture(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?__theme=light#/task/t-run");
  await page.getByRole("button", { name: "Task actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Open terminal" }).click();
  await page.getByRole("button", { name: "New terminal", exact: true }).click();
  await expect(page.getByText("Connected · sample-app", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
  await assertViewportLocked(page);
  await captureForReview(page, "terminal-desktop-light.png");
  await page.setViewportSize({ width: 320, height: 568 });
  // Chromium can acknowledge the viewport before delivering resize to the PWA.
  // Wait for the visible shell to resize before measuring document overflow.
  await expect(page.getByRole("region", { name: "Terminals", exact: true })).toHaveCSS("height", "568px");
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeHidden();
  await expect(page.getByRole("button", { name: "Ctrl+C", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Type here" })).toHaveCount(0);
  await assertViewportLocked(page);
  await captureForReview(page, "terminal-mobile-light.png");
});


test("missing terminal services explain a pending shell and disable new shells", async ({ page }) => {
  await page.route("**/api/terminals**", route => route.fulfill({ json: {
    terminals: [{ id, repoId: "repo-app", taskId: "t-run", title: "Shell", initialCwd: "/projects/sample-app",
      state: "starting", startError: "Terminal services are not installed. Run palmagent setup to repair this installation.", createdAt: 1, protocol: 1 }],
    capabilities: { available: false, persistent: false, reason: "Terminal services are not installed. Run palmagent setup to repair this installation." },
  } }));
  await page.goto("/#/task/t-run");
  await page.getByRole("button", { name: "Task actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Open terminal" }).click();
  await expect(page.getByText("Shell could not start", { exact: true })).toBeVisible();
  await expect(page.getByText(/Run palmagent setup to repair/)).toHaveCount(1);
  await expect(page.getByRole("button", { name: "New terminal", exact: true })).toBeDisabled();
  await expect(page.getByText("Starting shell…", { exact: true })).toHaveCount(0);
});

async function openTerminal(page: Page) {
  await page.goto("/#/task/t-run");
  await page.getByRole("button", { name: "Task actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Open terminal" }).click();
  await page.getByRole("button", { name: "New terminal", exact: true }).click();
  await expect(page.getByText("Connected · sample-app", { exact: true })).toBeVisible();
}

test("input moves only on explicit takeover and idle reconnects recover without replay", async ({ page }) => {
  const f = await terminalFixture(page, { occupied: true });
  await openTerminal(page);
  await expect(page.getByText("In use on another screen", { exact: true })).toBeVisible();
  expect(f.claims).toHaveLength(0);
  await page.getByTestId("terminal-screen").click();
  await page.keyboard.type("blocked");
  expect(f.inputs).toEqual([]);
  expect(f.claims).toHaveLength(0);
  await page.getByRole("button", { name: "Type here" }).click();
  await expect(page.getByRole("button", { name: "Ctrl+C", exact: true })).toBeEnabled();
  await page.keyboard.type("hello");
  await expect.poll(() => f.inputs.join("")).toBe("hello");
  f.takeElsewhere();
  await expect(page.getByText("Input moved to another screen", { exact: true })).toBeVisible();
  await page.keyboard.type("ignored");
  expect(f.inputs.join("")).toBe("hello");
  f.releaseElsewhere();
  await expect(page.getByText("Viewing terminal output", { exact: true })).toBeVisible();
  expect(f.claims).toHaveLength(1);
  f.disconnect();
  await expect(page.getByText(/Disconnected/)).toBeVisible();
  await page.keyboard.type("offline");
  await expect(page.getByRole("button", { name: "Ctrl+C", exact: true })).toBeEnabled();
  expect(f.inputs.join("")).toBe("hello");
  expect(f.claims).toEqual([{ type: "claim-control" }, { type: "claim-control", ifAvailable: true }]);
  f.disconnect(true);
  await expect(page.getByText("In use on another screen", { exact: true })).toBeVisible();
  expect(f.claims).toHaveLength(2);
});

test("read-only survives reconnect and remains selectable until explicitly enabled", async ({ page }) => {
  const f = await terminalFixture(page);
  await openTerminal(page);
  await expect(page.getByRole("button", { name: "Ctrl+C", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Terminal actions" }).click();
  await page.getByRole("menuitem", { name: "View read-only" }).click();
  await expect(page.getByText("Read-only · sample-app", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Ctrl+C", exact: true })).toBeDisabled();
  f.disconnect();
  await expect.poll(f.connections).toBe(2);
  await expect(page.getByText("Read-only · sample-app", { exact: true })).toBeVisible();
  expect(f.claims).toHaveLength(1);
  await page.getByRole("button", { name: "Terminal actions" }).click();
  await page.getByRole("menuitem", { name: "Terminal details" }).click();
  await expect(page.getByRole("dialog")).toContainText("/projects/sample-app");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Type here" }).click();
  await expect(page.getByRole("button", { name: "Ctrl+C", exact: true })).toBeEnabled();
  expect(f.claims).toHaveLength(2);
});

test("older persistent hosts support explicit input without unsupported automatic claims", async ({ page }) => {
  const f = await terminalFixture(page, { legacy: true });
  await openTerminal(page);
  await expect(page.getByRole("button", { name: "Type here" })).toBeEnabled();
  expect(f.claims).toEqual([]);
  await page.getByRole("button", { name: "Type here" }).click();
  await expect(page.getByRole("button", { name: "Ctrl+C", exact: true })).toBeEnabled();
  expect(f.claims).toEqual([{ type: "claim-control" }]);
});


test("terminal uses one header and grouped presets preserve input and fitted zoom", async ({ page }) => {
  const f = await terminalFixture(page);
  await openTerminal(page);
  const region = page.getByRole("region", { name: "Terminals", exact: true });
  await expect(region.locator("header")).toHaveCount(1);
  const screen = page.getByTestId("terminal-screen");
  await expect.poll(async () => (await screen.boundingBox())!.y).toBeLessThan(80);
  await expect(page.getByRole("group", { name: "Common keys", exact: true })).toBeVisible();
  for (const [name, data] of [["Enter", "\r"], ["Shift+Tab", "\x1b[Z"], ["Home", "\x1b[H"], ["End", "\x1b[F"], ["Page up", "\x1b[5~"], ["Page down", "\x1b[6~"], ["Ctrl+R", "\x12"], ["Arrow left", "\x1b[D"]]) {
    await page.getByRole("button", { name, exact: true }).click();
    await expect.poll(() => f.inputs.at(-1)).toBe(data);
    await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  }
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect(page.getByRole("button", { name: "Reset terminal zoom" })).toHaveText("15px");
  await page.getByRole("button", { name: "Reset terminal zoom" }).click();
  await expect(page.getByRole("button", { name: "Reset terminal zoom" })).toHaveText("14px");
  await assertViewportLocked(page);
});
