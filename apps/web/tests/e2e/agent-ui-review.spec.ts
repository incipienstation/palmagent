import { test, expect } from "@playwright/test";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { installScopedStream, open, send } from "./_scoped-stream";
import { assertViewportLocked } from "./_helpers";

// The same scenarios can capture both revisions for visual review.
for (const width of [360, 1280]) {
  for (const scenario of ["code", "activity", "questions", "approval"]) {
    test(`agent UI review ${scenario} at ${width}px`, async ({ page }) => {
      test.skip(!process.env.VISUAL_REVIEW_DIR, "Opt-in before/after captures");
      await page.setViewportSize({ width, height: width === 360 ? 780 : 900 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      if (scenario === "questions" || scenario === "approval") {
        await page.goto(`/#/task/${scenario === "questions" ? "t-input" : "t-await"}`);
        await expect(page.getByRole("button", { name: scenario === "questions" ? "Send answer" : "Approve", exact: true })).toBeVisible();
        await expect(page.getByRole("region", { name: "Account limits" }).getByText("72%", { exact: true })).toBeVisible();
      } else {
        await installScopedStream(page);
        const id = "t-idle-rich";
        await open(page, id);
        await send(page, id, { type: "tasks", tasks: [], historyThrough: 0 });
        const frames = scenario === "code" ? [
          { kind: "assistant_text", payload: { text: 'The retry helper is ready.\n\n```typescript\nexport async function retry<T>(\n  run: () => Promise<T>,\n  attempts = 3,\n): Promise<T> {\n  for (let n = 1; ; n++) {\n    try { return await run(); }\n    catch (error) {\n      if (n >= attempts) throw error;\n    }\n  }\n}\n```', messageId: "review" } },
        ] : [
          { kind: "assistant_text", payload: { text: "Checking the retry helper and its tests.", messageId: "progress", phase: "progress" } },
          { kind: "tool_call", payload: { id: "read", name: "Read", input: { file_path: "src/retry.ts" } } },
          { kind: "tool_result", payload: { tool_use_id: "read", content: "Read 18 lines" } },
          { kind: "tool_call", payload: { id: "edit", name: "Edit", input: { file_path: "src/retry.ts", old_string: "attempts = 1", new_string: "attempts = 3" } } },
          { kind: "tool_result", payload: { tool_use_id: "edit", content: "Updated src/retry.ts" } },
          { kind: "tool_call", payload: { id: "test", name: "Bash", input: { command: "pnpm test retry" } } },
          { kind: "tool_result", payload: { tool_use_id: "test", content: "4 tests passed" } },
          { kind: "assistant_text", payload: { text: "Updated the retry limit. All four tests pass.", messageId: "final", phase: "final" } },
        ];
        for (const [i, frame] of frames.entries()) await send(page, id, { type: "event", event: { taskId: id, agent: "claude", ts: i + 1, ...frame } }, i + 1);
        await expect(page.getByText(scenario === "code" ? "The retry helper is ready." : "Updated the retry limit. All four tests pass.", { exact: true })).toBeVisible();
      }
      await page.evaluate(() => document.fonts.ready);
      await assertViewportLocked(page);
      // Allow virtual row measurements and asynchronous highlighting to settle.
      await page.waitForTimeout(700);
      await mkdir(process.env.VISUAL_REVIEW_DIR!, { recursive: true });
      await page.screenshot({ path: join(process.env.VISUAL_REVIEW_DIR!, `${scenario}-${width}.png`) });
      await page.emulateMedia({ colorScheme: "light" });
      await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
      await page.screenshot({ path: join(process.env.VISUAL_REVIEW_DIR!, `${scenario}-${width}-light.png`), animations: "disabled" });
    });
  }
}
