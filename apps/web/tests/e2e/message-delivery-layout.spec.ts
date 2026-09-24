import { test, expect } from "@playwright/test";
import type { MessageQueue } from "@palmagent/shared";
import { tasks } from "../fixtures.mjs";
import { installScopedStream, open, send } from "./_scoped-stream";
import { assertViewportLocked } from "./_helpers";

test.use({ serviceWorkers: "block" });

for (const height of [780, 500]) test(`delivery recovery keeps the composer reachable at ${height}px`, async ({ page }) => {
  await page.setViewportSize({ width: 360, height });
  await installScopedStream(page);
  const task = { ...tasks.find(task => task.taskId === "t-run")!, messageQueue: {
    revision: 1, runId: "run-1", paused: true, messages: [
      { id: "sending", version: 1, mode: "send", status: "unknown", text: "Please include the mobile layout in the review." },
      { id: "waiting", version: 1, mode: "queue", status: "queued", text: "Review the test results after this turn" },
    ],
  } satisfies MessageQueue };
  await page.route("**/api/tasks/t-run", route => route.fulfill({ json: { task } }));
  await open(page, "t-run");
  await send(page, "t-run", { type: "tasks", tasks: [task], historyThrough: 0 });
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("My next draft");
  const sendButton = page.getByRole("button", { name: "Send now", exact: true });
  await expect(sendButton).toBeInViewport();
  await expect.poll(async () => {
    const box = await sendButton.boundingBox();
    return box ? box.y + box.height : Infinity;
  }).toBeLessThanOrEqual(height);
  const dismiss = page.getByRole("button", { name: "Dismiss delivery notice" });
  await dismiss.scrollIntoViewIfNeeded();
  await expect(dismiss).toBeInViewport();
  await expect(sendButton).toBeInViewport();
  await assertViewportLocked(page);
});
