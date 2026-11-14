import { test, expect } from "@playwright/test";
import type { MessageQueue, TaskState } from "@palmagent/shared";
import { tasks } from "../fixtures.mjs";
import { installScopedStream, open, send } from "./_scoped-stream";

const task = tasks.find(task => task.taskId === "t-run")!;
const queue: MessageQueue = { revision: 1, runId: null, paused: false, messages: [] };
const frame = (status: TaskState["status"], messageQueue = queue) => ({
  type: "tasks", tasks: [{ ...task, status, messageQueue }], historyThrough: 0,
});

for (const width of [360]) test(`placeholder updates without moving or replacing the focused input at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 780 });
  await installScopedStream(page);
  await open(page, "t-run");
  await send(page, "t-run", frame("running"));
  const input = page.getByRole("textbox");
  await expect(input).toHaveAttribute("placeholder", "Guide the current task…");
  await input.focus();
  await input.evaluate(async el => {
    await Promise.all(el.closest('[aria-label="Message composer"]')!.getAnimations({ subtree: true })
      .map(animation => animation.finished.catch(() => {})));
  });
  const element = (await input.elementHandle())!;
  const height = (await input.boundingBox())!.height;
  await send(page, "t-run", frame("idle"));
  await expect(input).toHaveAttribute("placeholder", "Message Palmagent…");
  expect(await element.evaluate(el => el.isConnected && document.activeElement === el)).toBe(true);
  expect((await input.boundingBox())!.height).toBe(height);

  await input.fill("Keep this draft");
  await input.evaluate(el => (el as HTMLTextAreaElement).setSelectionRange(5, 9));
  await send(page, "t-run", frame("running"));
  await expect(input).toHaveValue("Keep this draft");
  expect(await input.evaluate(el => [(el as HTMLTextAreaElement).selectionStart, (el as HTMLTextAreaElement).selectionEnd])).toEqual([5, 9]);
  await expect(input).toHaveCSS("opacity", "1");
  await input.fill("");
  await expect(input).toHaveAttribute("placeholder", "Guide the current task…");

  await page.emulateMedia({ reducedMotion: "reduce" });
  await send(page, "t-run", frame("idle"));
  await expect(input).toHaveAttribute("placeholder", "Message Palmagent…");
  expect(await input.evaluate(el => getComputedStyle(el, "::placeholder").transitionDuration)).toBe("0s");
});
