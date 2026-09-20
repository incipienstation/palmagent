import { test, expect, type Page } from "@playwright/test";
import { join } from "node:path";
import { assertViewportLocked } from "./_helpers";
import { installScopedStream, open, send } from "./_scoped-stream";

test.use({ serviceWorkers: "block" });

async function reply(page: Page, text: string, running = false) {
  await installScopedStream(page);
  const taskId = running ? "t-run-charts" : "t-idle-rich";
  await open(page, taskId);
  await send(page, taskId, { type: "tasks", tasks: [], replayThrough: 0 });
  await send(page, taskId, { type: "event", event: {
    taskId, agent: "codex", ts: 1, kind: "assistant_text", payload: { text, messageId: "mermaid-reply" },
  } }, 1);
  return taskId;
}

async function screenshot(page: Page, name: string) {
  if (process.env.VISUAL_REVIEW_DIR) {
    await page.screenshot({ path: join(process.env.VISUAL_REVIEW_DIR, `${name}.png`) });
  }
}

const fence = (source: string) => "```mermaid\n" + source + "\n```";
const flow = "flowchart TD\n  A[Start] --> B[Render diagram]\n  B --> C[Done]";

for (const parser of ["static", "streaming", "long"] as const) {
  test(`${parser} Markdown renders Mermaid and preserves source and ordinary code`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const prefix = parser === "long" ? "<!--" + "x".repeat(4100) + "-->\n\n" : "";
    await reply(page, prefix + fence(flow) + '\n\n```js\nconst value = 1;\n```', parser === "streaming");
    const diagram = page.getByRole("img", { name: "Mermaid diagram", exact: true });
    await expect(diagram).toBeVisible();
    await expect.poll(() => diagram.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
    const svg = decodeURIComponent((await diagram.getAttribute("src"))!.split(",").slice(1).join(","));
    expect(svg.replace(/<[^>]*>/g, "")).toContain("Render diagram");
    expect(svg).not.toContain("<foreignObject");
    await expect(page.locator("pre").filter({ hasText: "const value = 1;" })).toBeVisible();
    await page.getByText("Diagram source", { exact: true }).click();
    await expect(page.locator("pre").filter({ hasText: flow })).toBeVisible();
    await assertViewportLocked(page);
    expect(errors).toEqual([]);
  });
}

test("an incomplete streaming diagram recovers when the fence is completed", async ({ page }) => {
  const taskId = await reply(page, '```mermaid\nflowchart TD\n A[', true);
  await expect(page.getByText("Diagram unavailable — showing source.")).toBeVisible();
  await send(page, taskId, { type: "event", event: {
    taskId, agent: "codex", ts: 2, kind: "assistant_text", payload: { text: "Ready] --> B[Done]\n```", messageId: "mermaid-reply" },
  } }, 2);
  await expect(page.getByRole("img", { name: "Mermaid diagram", exact: true })).toBeVisible();
  await expect(page.getByText("Diagram unavailable — showing source.")).toHaveCount(0);
  await expect(page.locator('body > div[aria-hidden="true"]')).toHaveCount(0);
});

test("multiple diagrams, theme changes, and wide mobile content remain contained", async ({ page }) => {
  await reply(page, fence(flow) + "\n\n" + fence("sequenceDiagram\n Alice->>Bob: Hello\n Bob->>Charlie: Forward\n Charlie->>Diana: Forward\n Diana-->>Alice: Welcome"));
  const diagrams = page.getByRole("img", { name: "Mermaid diagram", exact: true });
  await expect(diagrams).toHaveCount(2);
  await expect.poll(() => diagrams.last().evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(360);
  const dark = await diagrams.first().getAttribute("src");
  await screenshot(page, "mermaid-mobile-dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(diagrams).toHaveCount(2);
  await expect(diagrams.first()).not.toHaveAttribute("src", dark!);
  await screenshot(page, "mermaid-mobile-light");
  await assertViewportLocked(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await screenshot(page, "mermaid-desktop-light");
  const light = await diagrams.first().getAttribute("src");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(diagrams).toHaveCount(2);
  await expect(diagrams.first()).not.toHaveAttribute("src", light!);
  await screenshot(page, "mermaid-desktop-dark");
});

test("diagram directives cannot enable HTML or executable links", async ({ page }) => {
  let dialogs = 0;
  page.on("dialog", async dialog => { dialogs++; await dialog.dismiss(); });
  await reply(page, fence('%%{init: {"securityLevel":"loose", "htmlLabels":true, "flowchart":{"htmlLabels":true}}}%%\nflowchart TD\n A[Safe] --> B[Text]\n click A "javascript:alert(1)"'));
  const diagram = page.getByRole("img", { name: "Mermaid diagram", exact: true });
  await expect(diagram).toBeVisible();
  const svg = decodeURIComponent((await diagram.getAttribute("src"))!.split(",").slice(1).join(","));
  expect(svg).not.toContain("<foreignObject");
  expect(svg).not.toContain("javascript:");
  await diagram.click();
  expect(dialogs).toBe(0);
});
