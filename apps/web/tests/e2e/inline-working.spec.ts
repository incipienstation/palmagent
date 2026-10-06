import { test, expect } from "@playwright/test";
import { tasks } from "../fixtures.mjs";
import { installScopedStream, open, send } from "./_scoped-stream";
import { assertViewportLocked, captureForReview } from "./_helpers";
import type { MessageQueue } from "@palmagent/shared";

test.use({ serviceWorkers: "block" });

for (const width of [360, 1280]) for (const echoFirst of [true, false]) {
  test(`inline send reconciles by ID, ${width}px, echo first: ${echoFirst}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 780 });
    await installScopedStream(page);
    const task = { ...tasks.find(task => task.taskId === "t-run")!, status: "idle", prompt: "",
      messageQueue: { revision: 1, runId: null, paused: false, messages: [] } as MessageQueue };
    await page.route("**/api/tasks/t-run", route => route.fulfill({ json: { task } }));
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    let request: { clientMessageId: string; text: string };
    await page.route("**/api/tasks/t-run/messages", async route => {
      request = route.request().postDataJSON();
      await wait;
      await route.fulfill({ json: { ...task.messageQueue, revision: 2, messages: [{
        id: request.clientMessageId, text: request.text, version: 1, mode: "send", status: "sending",
      }] } });
    });
    await open(page, "t-run");
    await send(page, "t-run", { type: "tasks", tasks: [task], historyThrough: 0 });
    const text = "Write a short story";
    await page.getByRole("textbox").fill(text);
    await page.getByRole("button", { name: "Send now", exact: true }).click();
    await expect.poll(() => request?.clientMessageId).toBeTruthy();
    const transcript = page.getByLabel("Session transcript");
    const bubble = transcript.getByRole("group", { name: "Your message" }).filter({ hasText: text });
    const working = transcript.getByText("Working…", { exact: true });
    await expect(bubble).toHaveCount(1);
    await expect(working).toHaveCount(1);
    await expect(page.getByRole("textbox")).toHaveValue("");
    const stop = page.getByRole("button", { name: "Stop", exact: true });
    await expect(stop).toBeEnabled();
    await expect(stop.locator(".animate-spin")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Send now", exact: true })).toHaveCount(0);
    await expect(page.getByRole("textbox")).not.toBeFocused();
    await expect(page.getByRole("group", { name: "Message composer", exact: true })).toHaveAttribute("data-expanded", "false");
    await expect(page.getByText(/Sending/)).toHaveCount(0);
    expect((await working.boundingBox())!.y).toBeGreaterThan((await bubble.boundingBox())!.y);
    await expect(working).toHaveCSS("animation-name", "tw-shimmer");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(working).toHaveCSS("animation-name", "none");
    await expect(working).not.toHaveCSS("-webkit-text-fill-color", "rgba(0, 0, 0, 0)");
    if (width === 360 && echoFirst) await expect(page).toHaveScreenshot("optimistic-working.png");
    const emit = (seq: number, kind: string, payload: unknown) => send(page, "t-run", {
      type: "event", event: { taskId: "t-run", agent: "codex", ts: seq, kind, payload },
    }, seq);
    const echo = () => emit(1, "status", { subtype: "followup", messageId: request.clientMessageId, text });
    if (echoFirst) await echo();
    release();
    await expect(page.getByRole("textbox")).toBeEnabled();
    if (!echoFirst) await echo();
    await expect(bubble).toHaveCount(1);
    await expect(page.getByText(text, { exact: true })).toHaveCount(1);
    task.status = "running";
    task.messageQueue = { ...task.messageQueue, revision: 3, messages: [] };
    await send(page, "t-run", { type: "tasks", tasks: [task] });
    await emit(2, "status", { subtype: "turn_started" });
    await emit(3, "tool_call", { id: "check", name: "bash", command: "echo checked" });
    await expect(working).toHaveCount(1);
    const activity = transcript.getByRole("button", { name: /1 tool/ });
    await expect(activity).toContainText("Activity · 1 tool");
    expect((await working.boundingBox())!.y).toBeGreaterThan((await activity.boundingBox())!.y);
    await activity.click();
    await expect(activity).toHaveAttribute("aria-expanded", "true");
    await expect(transcript.getByText(/1 tool/, { exact: false })).toBeVisible();
    await activity.click();
    // A different ID with the same text is a separate intentional message.
    await emit(4, "status", { subtype: "steer", messageId: "another-message", text });
    await expect(bubble).toHaveCount(2);
    await emit(5, "assistant_text", { text: "Once upon a time.", phase: "final" });
    await expect(working).toHaveCount(0);
    await emit(6, "status", { subtype: "usage", usage: {} });
    await expect(working).toHaveCount(0);
    await emit(7, "result", {});
    task.status = "idle";
    await send(page, "t-run", { type: "tasks", tasks: [task] });
    await expect(working).toHaveCount(0);
    await expect(stop).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Send now", exact: true })).toBeVisible();
    await expect(transcript.getByText("Once upon a time.")).toBeVisible();
    await assertViewportLocked(page);
  });
}

test("a rejected echoed message keeps recovery beside its single bubble", async ({ page }) => {
  await installScopedStream(page);
  const message = { id: "rejected-send", text: "Continue the work", mode: "send", status: "rejected", version: 1 };
  const task = { ...tasks.find(task => task.taskId === "t-run")!, status: "idle",
    messageQueue: { revision: 2, runId: null, paused: true, messages: [message] } };
  await page.route("**/api/tasks/t-run", route => route.fulfill({ json: { task } }));
  await open(page, "t-run");
  await send(page, "t-run", { type: "tasks", tasks: [task], historyThrough: 0 });
  await send(page, "t-run", { type: "event", event: { taskId: "t-run", agent: "codex", ts: 1,
    kind: "status", payload: { subtype: "steer", messageId: message.id, text: message.text },
  } }, 1);
  const transcript = page.getByLabel("Session transcript");
  await expect(page.getByText(message.text, { exact: true })).toHaveCount(1);
  await expect(transcript.getByRole("alert")).toContainText("Not sent");
  await expect(transcript.getByRole("button", { name: "Dismiss delivery notice" })).toBeVisible();
  await expect(transcript.getByText("Working…", { exact: true })).toHaveCount(0);
});

for (const mode of ["compact", "verbose"] as const) for (const width of [360, 1280]) {
  test(`working follows semantic activity at the transcript end, ${mode}, ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 780 });
    await page.addInitScript(mode => localStorage.setItem("pref:output-mode", mode), mode);
    await installScopedStream(page);
    const task = { ...tasks.find(task => task.taskId === "t-run")!, status: "running", prompt: "" };
    await page.route("**/api/tasks/t-run", route => route.fulfill({ json: { task } }));
    await open(page, "t-run");
    await send(page, "t-run", { type: "tasks", tasks: [task], historyThrough: 0 });
    let seq = 0;
    const emit = (kind: string, payload: unknown) => send(page, "t-run", { type: "event", event: {
      taskId: "t-run", agent: "codex", ts: seq, kind, payload,
    } }, ++seq);
    const transcript = page.getByLabel("Session transcript");
    const working = transcript.getByText("Working…", { exact: true });
    await emit("status", { subtype: "turn_started" });
    await expect(working).toHaveCount(1);
    await emit("assistant_text", { text: "An explanation is streaming.", messageId: "m1" });
    await expect(transcript.getByText("An explanation is streaming.", { exact: true })).toBeVisible();
    await expect(working).toHaveCount(0);
    await emit("status", { subtype: "usage" });
    await expect(working).toHaveCount(0);
    await emit("status", { subtype: "assistant_message", messageId: "m1", phase: "progress" });
    await expect(working).toHaveCount(0);
    await emit("tool_call", { id: "tool-1", name: "bash", command: "echo checked" });
    await expect(working).toHaveCount(1);
    if (mode === "compact") {
      const activity = transcript.getByRole("button", { name: "Activity · 1 tool", exact: true });
      await expect(activity).toBeVisible();
      expect((await working.boundingBox())!.y).toBeGreaterThan((await activity.boundingBox())!.y);
      await activity.click();
      await expect(activity).toHaveAttribute("aria-expanded", "true");
      await expect(working).toHaveCount(1);
      await activity.click();
    }
    await captureForReview(page, `working-${mode}-${width}.png`);
    await emit("tool_result", { tool_use_id: "tool-1", output: "checked" });
    await emit("assistant_text", { text: "The answer is arriving.", messageId: "m2", phase: "final" });
    await expect(transcript.getByText("The answer is arriving.", { exact: true })).toBeVisible();
    await expect(working).toHaveCount(0);
    await emit("status", { subtype: "assistant_message", messageId: "m2", phase: "final" });
    await emit("status", { subtype: "usage" });
    await expect(working).toHaveCount(0);
    await captureForReview(page, `output-${mode}-${width}.png`);
    await emit("result", {});
    await emit("status", { subtype: "usage" });
    // The running snapshot can lag behind terminal events.
    await expect(working).toHaveCount(0);
    await emit("status", { subtype: "followup", text: "Continue", messageId: "next" });
    await expect(working).toHaveCount(1);
    const bubble = transcript.getByRole("group", { name: "Your message" }).filter({ hasText: "Continue" });
    expect((await working.boundingBox())!.y).toBeGreaterThan((await bubble.boundingBox())!.y);
    await emit("question", { requestId: "q1", questions: [{ question: "Which option?", header: "Option", options: [] }] });
    await emit("status", { subtype: "usage" });
    await expect(working).toHaveCount(0);
    await emit("status", { subtype: "answer", requestId: "q1", answers: {} });
    await expect(working).toHaveCount(1);
    await emit("approval_request", { requestId: "a1", tool: "bash" });
    await expect(working).toHaveCount(0);
    await emit("status", { subtype: "approval", decision: "allow" });
    await expect(working).toHaveCount(1);
    await emit("status", { subtype: "stop" });
    await emit("status", { subtype: "usage" });
    await expect(working).toHaveCount(0);
    await assertViewportLocked(page);
  });
}
