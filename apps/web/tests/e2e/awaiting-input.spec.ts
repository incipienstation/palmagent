import { test, expect } from "@playwright/test";
import { assertViewportLocked } from "./_helpers";
import { tasks } from "../fixtures.mjs";
import { installScopedStream, open, send } from "./_scoped-stream";

test("Codex answers carry question identities and preserve input after delivery failure", async ({ page }) => {
  await installScopedStream(page);
  await open(page, "t-input");
  const task = { ...structuredClone(tasks.find(t => t.taskId === "t-input")!), agent: "codex" as const,
    pendingInput: { requestId: "17", questions: [
      { id: "first", question: "Choose", options: [{ label: "Yes" }] },
      { id: "second", question: "Choose", options: [] },
    ] } };
  await send(page, task.taskId, { type: "tasks", tasks: [task], replayThrough: 0 });
  await page.getByRole("button", { name: "Yes", exact: true }).click();
  await page.getByRole("button", { name: "Go to question 2", exact: true }).click();
  await page.getByPlaceholder("Or type a custom answer…").nth(1).fill("Custom answer");
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/tasks/t-input/answer", async route => {
    await gate;
    await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "Answer delivery could not be confirmed." }) });
  });
  const request = page.waitForRequest(r => r.url().endsWith("/api/tasks/t-input/answer"));
  await page.getByRole("button", { name: "Send answer", exact: true }).click();
  const body = (await request).postDataJSON();
  expect(body.answers).toEqual([
    { questionId: "first", question: "Choose", selected: ["Yes"] },
    { questionId: "second", question: "Choose", selected: [], notes: "Custom answer" },
  ]);
  await expect(page.getByRole("button", { name: "Send answer", exact: true })).toBeDisabled();
  await expect(page.getByText("The agent needs your input")).toBeVisible();
  release();
  await expect(page.getByText("Answer delivery could not be confirmed.", { exact: true })).toBeVisible();
  await expect(page.getByPlaceholder("Or type a custom answer…").nth(1)).toHaveValue("Custom answer");
  await expect(page.getByRole("button", { name: "Send answer", exact: true })).toBeEnabled();
  await send(page, task.taskId, { type: "tasks", tasks: [{ ...task,
    pendingInput: { requestId: "18", questions: [{ id: "next", question: "Next question", options: [] }] },
  }] });
  await expect(page.getByPlaceholder("Or type a custom answer…")).toHaveCount(1);
  await expect(page.getByPlaceholder("Or type a custom answer…")).toHaveValue("");
});

test("approval request keeps full details accessible beside explicit decisions", async ({ page }) => {
  await page.goto("/#/task/t-await");
  await expect(page.locator("[data-approval-card]")).toContainText("Permission needed");
  await expect(page.locator("[data-approval-card] pre").filter({ hasText: "DROP TABLE legacy_events" })).toBeVisible();
  const details = page.getByRole("button", { name: "Request details", exact: true });
  await details.focus();
  await page.keyboard.press("Enter");
  await expect(details).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("pre").filter({ hasText: '"reason":"destructive schema change"' })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Deny", exact: true })).toBeEnabled();
  await assertViewportLocked(page);
});

// The AskUserQuestion flow: a task paused on a question (awaiting_input) renders
// the tap-to-answer QuestionCard, and answering posts to /api/tasks/:id/answer.
test.describe("awaiting input (AskUserQuestion)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/#/task/t-input");
    await expect(page.getByRole("heading", { name: "Scaffold a new settings screen" })).toBeVisible();
    await expect(page.getByText("The agent needs your input")).toBeVisible();
  });

  test("viewport is locked (no document scroll, no horizontal overflow)", async ({ page }) => {
    await assertViewportLocked(page);
  });

  // The regression this guards: a tall QuestionCard (many questions) used to stack
  // them into one vertical column that grew up and buried the session output above,
  // and could clip the Skip/Send actions off-screen (the document never scrolls).
  // Multiple questions now page HORIZONTALLY — one per swipeable slide — so the
  // panel tracks a single question, and the actions stay reachable. Q2's options
  // sit off to the RIGHT at the same vertical band as Q1, not stacked below it.
  test("multiple questions page horizontally; actions stay on-screen", async ({ page }) => {
    const { width: vw, height: vh } = page.viewportSize()!;
    const q1 = await page.getByRole("button", { name: /Tailwind utilities/ }).boundingBox();
    const q2 = await page.getByRole("button", { name: /Notifications/ }).boundingBox();
    expect(q1, "Q1 option is laid out").not.toBeNull();
    expect(q2, "Q2 option is laid out").not.toBeNull();
    // Paged a full slide to the right (horizontal) at the same vertical band — NOT
    // stacked hundreds of px below (the vertical-overflow regression this guards).
    expect(q2!.x - q1!.x, "Q2 is a slide to the right of Q1").toBeGreaterThan(200);
    expect(q2!.x, "Q2 starts in the off-screen right half").toBeGreaterThan(vw / 2);
    expect(Math.abs(q2!.y - q1!.y), "Q2 shares Q1's vertical band").toBeLessThan(150);
    // The dot pager's "1 / 2" counter is shown.
    await expect(page.getByText("1 / 2", { exact: true })).toBeVisible();
    // Skip / Send sit below the slides and must remain fully on-screen.
    for (const name of ["Skip", "Send answer"]) {
      const box = await page.getByRole("button", { name }).boundingBox();
      expect(box, `${name} button is laid out`).not.toBeNull();
      expect(box!.y + box!.height, `${name} button is within the viewport`).toBeLessThanOrEqual(vh + 1);
    }
  });

  // Tapping a pager dot jumps to that question (the counter follows the scroll).
  test("dot pager navigates between questions", async ({ page }) => {
    await expect(page.getByText("1 / 2", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /Go to question 2/ }).click();
    await expect(page.getByText("2 / 2", { exact: true })).toBeVisible();
    const vw = page.viewportSize()!.width;
    const q2 = await page.getByRole("button", { name: /Notifications/ }).boundingBox();
    expect(q2!.x, "Q2 scrolled into view").toBeLessThan(vw);
  });

  test("renders both questions with their options", async ({ page }) => {
    // The question text appears twice (live answer card + transcript record); the
    // tappable option buttons are unique to the card.
    await expect(page.getByText("Which styling approach should the new settings screen use?").first()).toBeVisible();
    await expect(page.getByText("Which sections should it include?").first()).toBeVisible();
    await expect(page.getByRole("button", { name: /Tailwind utilities/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Notifications/ })).toBeVisible();
    // Send is disabled until something is picked.
    await expect(page.getByRole("button", { name: "Send answer" })).toBeDisabled();
  });

  test("picking an option enables Send and POSTs the answer", async ({ page }) => {
    await page.getByRole("button", { name: /Tailwind utilities/ }).click();
    await expect(page.getByRole("button", { name: /Tailwind utilities/ })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("status").filter({ hasText: "1 of 2 answered" })).toBeVisible();
    const send = page.getByRole("button", { name: "Send answer" });
    await expect(send).toBeEnabled();
    const [req] = await Promise.all([
      page.waitForRequest((r) => r.url().includes("/api/tasks/t-input/answer") && r.method() === "POST"),
      send.click(),
    ]);
    const body = req.postDataJSON();
    expect(body.requestId).toBe("req-ask-1");
    expect(body.answers[0].selected).toContain("Tailwind utilities");
  });

  test("numbered navigation preserves multiple choices and notes without submitting", async ({ page }) => {
    let submissions = 0;
    page.on("request", request => { if (request.url().endsWith("/answer")) submissions++; });
    await page.getByRole("button", { name: /Tailwind utilities/ }).click();
    await page.getByRole("button", { name: "Next question", exact: true }).click();
    await page.getByRole("button", { name: /Notifications/ }).click();
    await page.getByRole("button", { name: /Appearance/ }).click();
    await page.getByPlaceholder("Or type a custom answer…").nth(1).fill("Keep my theme preference");
    await page.getByRole("button", { name: "Previous question", exact: true }).click();
    await expect(page.getByRole("button", { name: /Tailwind utilities/ })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Next question", exact: true }).click();
    await expect(page.getByRole("button", { name: /Notifications/ })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: /Appearance/ })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByPlaceholder("Or type a custom answer…").nth(1)).toHaveValue("Keep my theme preference");
    await expect(page.getByRole("status").filter({ hasText: "2 of 2 answered" })).toBeVisible();
    expect(submissions).toBe(0);
  });

  test("matches the visual baseline", async ({ page }) => {
    // The question form comes from the task snapshot before its transcript and
    // account report finish loading. Capture the fully populated screen.
    const transcript = page.locator('[aria-label="Session transcript"]');
    await expect(transcript.getByText("Which sections should it include?", { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Account limits" }).getByText("72%", { exact: true })).toBeVisible();
    await expect.poll(() => transcript.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThanOrEqual(2);
    await expect(page).toHaveScreenshot("awaiting-input.png");
  });
});
