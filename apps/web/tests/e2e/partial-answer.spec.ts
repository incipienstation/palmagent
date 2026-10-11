import { test, expect } from "@playwright/test";
import { installScopedStream, open, send } from "./_scoped-stream";

for (const width of [360, 1280]) test(`partial answers retain reading order, draft and activity state at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(() => localStorage.setItem("pref:output-mode", "compact"));
  await installScopedStream(page);
  await open(page, "t-run");
  await send(page, "t-run", { type: "tasks", tasks: [], historyThrough: 0 });
  let seq = 0;
  const emit = (kind: string, payload: unknown) => send(page, "t-run", { type: "event", event: {
    taskId: "t-run", agent: "codex", ts: seq, kind, payload,
  } }, ++seq);
  await emit("status", { subtype: "turn_started" });
  await emit("tool_call", { id: "read", name: "Read" });
  await emit("tool_result", { tool_use_id: "read", output: "Earlier diagnostic output" });
  await emit("assistant_text", { messageId: "p", text: "The session uses an expired token." });
  await emit("status", { subtype: "assistant_message", messageId: "p", phase: "partial" });
  const answer = page.getByText("The session uses an expired token.", { exact: true });
  await expect(answer).toBeVisible();
  await expect(page.getByText("Working…", { exact: true })).toHaveCount(0);
  const groups = page.locator("[data-activity]").filter({ has: page.locator("button[aria-expanded]") });
  const first = groups.first().getByRole("button").first();
  await first.click();
  await expect(first).toHaveAttribute("aria-expanded", "true");
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  await input.fill("Keep this unsent draft");
  const before = await answer.boundingBox();
  await emit("assistant_text", { messageId: "work", text: "Verifying the token refresh.", phase: "progress" });
  await emit("tool_call", { id: "verify", name: "bash", command: "Run session tests" });
  await expect(groups).toHaveCount(2);
  await expect(groups.nth(1).getByRole("button").first()).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByText("Working…", { exact: true })).toBeVisible();
  await expect(first).toHaveAttribute("aria-expanded", "true");
  await expect(input).toHaveValue("Keep this unsent draft");
  const after = await answer.boundingBox();
  expect(Math.abs(after!.y - before!.y)).toBeLessThanOrEqual(2);
  expect((await groups.nth(1).boundingBox())!.y).toBeGreaterThan(after!.y + after!.height);
  await emit("tool_result", { tool_use_id: "verify", output: "Session tests passed", exit_code: 0 });
  await emit("assistant_text", { messageId: "final", text: "The fix is verified.", phase: "final" });
  await emit("result", { is_error: false });
  await expect(page.getByText("Working…", { exact: true })).toHaveCount(0);
  const final = page.getByText("The fix is verified.", { exact: true });
  await expect(final).toBeVisible();
  expect((await final.boundingBox())!.y).toBeGreaterThan((await groups.nth(1).boundingBox())!.y);
  await expect(answer).toHaveCount(1);
  await expect(first).toHaveAttribute("aria-expanded", "true");
  await expect(input).toHaveValue("Keep this unsent draft");
});
