import { test, expect, type Page } from "@playwright/test";
import { installScopedStream, open, send } from "./_scoped-stream";
import { assertViewportLocked } from "./_helpers";

test.use({ serviceWorkers: "block" });
const source = 'const message = "<script>alert(1)</script>";\nconsole.log(message);\n';
async function reply(page: Page, text: string, running = false) {
  await installScopedStream(page);
  const taskId = running ? "t-run" : "t-idle-rich";
  await open(page, taskId);
  await send(page, taskId, { type: "tasks", tasks: [], historyThrough: 0 });
  await send(page, taskId, { type: "event", event: { taskId, agent: "claude", ts: 1, kind: "assistant_text",
    payload: { text, messageId: "code-reply" } } }, 1);
  return taskId;
}
for (const mode of ["static", "streaming", "long"] as const) {
  test(`${mode} code is highlighted, contained and copied exactly`, async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { configurable: true,
      value: { writeText: async (text: string) => { Object.assign(window, { copiedCode: text }); } } }));
    const prefix = mode === "long" ? "<!--" + "x".repeat(4100) + "-->\n\n" : "";
    await reply(page, prefix + '```js filename="example.js"\n' + source + '```', mode === "streaming");
    const frame = page.locator("[data-code-block]");
    await expect(frame).toBeVisible();
    await expect(frame.locator(".token.keyword").first()).toHaveText("const");
    await expect(frame.locator("pre code")).toHaveText(source);
    await expect(frame.locator("script")).toHaveCount(0);
    await frame.getByRole("button", { name: "Copy code", exact: true }).click();
    await expect(frame.getByRole("button", { name: "Code copied", exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as Window & { copiedCode?: string }).copiedCode)).toBe(source);
    const dark = await frame.locator(".token.keyword").first().evaluate(el => getComputedStyle(el).color);
    await page.emulateMedia({ colorScheme: "light" });
    await expect.poll(() => frame.locator(".token.keyword").first().evaluate(el => getComputedStyle(el).color)).not.toBe(dark);
    await assertViewportLocked(page);
  });
}
test("unfinished code streams without losing text or the copy control", async ({ page }) => {
  const id = await reply(page, "```ts\nconst answer =", true);
  await expect(page.locator("[data-code-block] pre")).toContainText("const answer =");
  await send(page, id, { type: "event", event: { taskId: id, agent: "claude", ts: 2, kind: "assistant_text",
    payload: { text: " 42;\n```", messageId: "code-reply" } } }, 2);
  await expect(page.locator("[data-code-block] pre")).toHaveText("const answer = 42;\n");
  await expect(page.getByRole("button", { name: "Copy code", exact: true })).toHaveCount(1);
});
test("unknown, unlabelled and large code remain readable; clipboard failure is recoverable", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { configurable: true,
    value: { writeText: async () => { throw new Error("Clipboard unavailable"); } } }));
  await reply(page, '```unknown\n' + source + '```\n\n```\nplain\n```\n\n```js\n' + 'x'.repeat(21_000) + '\n```');
  const frames = page.locator("[data-code-block]");
  await expect(frames).toHaveCount(3);
  await expect(frames.first().locator("pre")).toHaveText(source);
  await expect(frames.nth(1).locator("pre")).toHaveText("plain\n");
  await expect(frames.last().locator(".token")).toHaveCount(0);
  await frames.first().getByRole("button", { name: "Copy code", exact: true }).click();
  await expect(frames.first().getByRole("status").filter({ hasText: "Couldn’t copy" })).toBeVisible();
  await expect(frames.first().getByRole("button", { name: "Copy code", exact: true })).toBeEnabled();
  await assertViewportLocked(page);
});
test("syntax chunk failure leaves copyable plain code", async ({ page }) => {
  await page.route("**/CodeHighlight-*.js", route => route.abort());
  await reply(page, '```js\n' + source + '```');
  await expect(page.locator("[data-code-block] pre")).toHaveText(source);
  await expect(page.getByRole("button", { name: "Copy code", exact: true })).toBeEnabled();
});
