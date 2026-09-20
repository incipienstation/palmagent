import { test, expect, type Page } from "@playwright/test";
import { assertViewportLocked } from "./_helpers";

const id = "80a6a201-c6df-4229-ae7c-7b6b42b72d2f";
async function terminalFixture(page: Page) {
  let created = false, terminated = false, count = 0;
  const inputs: string[] = [];
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
        ws.send(JSON.stringify({ type: "control", writable: false, epoch: count }));
      } else if (frame.type === "claim-control") ws.send(JSON.stringify({ type: "control", writable: true, epoch: count }));
      else if (frame.type === "release-control") ws.send(JSON.stringify({ type: "control", writable: false, epoch: count + 1 }));
      else if (frame.type === "input") inputs.push(frame.data);
    });
  });
  return { inputs, connections: () => count, terminated: () => terminated };
}
test("mobile task terminal keeps its shell when returning to conversation and requires explicit termination", async ({ page }, testInfo) => {
  const f = await terminalFixture(page);
  await page.goto("/#/task/t-run");
  await page.getByRole("button", { name: "Task actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Open terminal" }).click();
  await page.getByRole("button", { name: "New terminal", exact: true }).click();
  await expect(page.getByText("Connected · View only", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Control here" }).click();
  await expect(page.getByText("Connected · You have control", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Ctrl+C", exact: true }).click();
  await expect.poll(() => f.inputs.includes("\x03")).toBe(true);
  await assertViewportLocked(page);
  await page.screenshot({ path: testInfo.outputPath("terminal-mobile-dark.png") });
  await page.getByRole("button", { name: "Back to conversation" }).click();
  expect(f.terminated()).toBe(false);
  await page.getByRole("button", { name: "Task actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Open terminal" }).click();
  await expect(page.getByText("Connected · View only", { exact: true })).toBeVisible();
  expect(f.connections()).toBe(2);
  await page.getByRole("button", { name: "Terminate terminal", exact: true }).click();
  await page.getByRole("button", { name: "Keep running", exact: true }).click();
  expect(f.terminated()).toBe(false);
  await page.getByRole("button", { name: "Terminate terminal", exact: true }).click();
  await page.getByRole("button", { name: "Terminate", exact: true }).click();
  await expect(page.getByText("Shell exited", { exact: true })).toBeVisible();
  expect(f.terminated()).toBe(true);
});
test("desktop shows conversation and terminal together; narrow light layout remains reachable", async ({ page }, testInfo) => {
  await terminalFixture(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?__theme=light#/task/t-run");
  await page.getByRole("button", { name: "Task actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Open terminal" }).click();
  await page.getByRole("button", { name: "New terminal", exact: true }).click();
  await expect(page.getByText("Connected · View only", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
  await assertViewportLocked(page);
  await page.screenshot({ path: testInfo.outputPath("terminal-desktop-light.png") });
  await page.setViewportSize({ width: 320, height: 568 });
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeHidden();
  await expect(page.getByRole("button", { name: "Control here" })).toBeVisible();
  await assertViewportLocked(page);
  await page.screenshot({ path: testInfo.outputPath("terminal-mobile-light.png") });
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
