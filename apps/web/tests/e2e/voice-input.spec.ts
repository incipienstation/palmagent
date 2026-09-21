import { test, expect, type Page } from "@playwright/test";
import { assertViewportLocked } from "./_helpers";

async function microphone(page: Page, mode = "ok") {
  await page.addInitScript(mode => {
    const state: any = (window as any).voiceTest = { speaking: false, stopped: 0, closed: 0, audioClosed: 0 };
    const stream = { getTracks: () => [{ stop: () => state.stopped++, onended: null }] };
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: () => {
      if (mode === "denied") return Promise.reject(new DOMException("denied", "NotAllowedError"));
      if (mode === "pending") return new Promise(resolve => { state.allow = () => resolve(stream); });
      return Promise.resolve(stream);
    } } });
    (window as any).AudioContext = class {
      resume() { return Promise.resolve(); }
      close() { state.audioClosed++; return Promise.resolve(); }
      createMediaStreamSource() { return { connect() {} }; }
      createAnalyser() { return { fftSize: 1024, getFloatTimeDomainData(array: Float32Array) { array.fill(state.speaking ? 0.04 : 0); } }; }
    };
    (window as any).RTCPeerConnection = class {
      connectionState = "new"; localDescription: any; onconnectionstatechange?: () => void;
      channel: any = { readyState: "connecting", close() { this.readyState = "closed"; this.onclose?.(); } };
      constructor() { state.peer = this; }
      addTrack() {}
      createDataChannel() { state.channel = this.channel; return this.channel; }
      createOffer() { return Promise.resolve({ type: "offer", sdp: "v=0\r\noffer" }); }
      setLocalDescription(value: any) { this.localDescription = value; return Promise.resolve(); }
      setRemoteDescription() {
        this.connectionState = "connected"; this.channel.readyState = "open";
        this.channel.onopen?.(); return Promise.resolve();
      }
      close() { state.closed++; this.connectionState = "closed"; this.onconnectionstatechange?.(); }
    };
    state.emit = (id: string, text: string) => state.channel.onmessage({ data: JSON.stringify({ type: "input_transcript.added", item: { id, text } }) });
  }, mode);
  let starts = 0, stops = 0;
  await page.route("**/api/voice", async route => { starts++; await route.fulfill({ json: { id: "11111111-1111-4111-8111-111111111111", sdp: "v=0\r\nanswer" } }); });
  await page.route("**/api/voice/*", async route => { stops++; await route.fulfill({ json: { ok: true } }); });
  return { starts: () => starts, stops: () => stops };
}

for (const width of [360, 1280]) test(`Codex alone shows microphone beside Send at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 780 });
  await page.goto("/#/task/t-idle-rich");
  await expect(page.getByRole("button", { name: "Start voice input" })).toHaveCount(0);
  await page.goto("/#/task/t-idle-interrupted");
  const mic = page.getByRole("button", { name: "Start voice input" });
  await expect(mic).toBeInViewport({ ratio: 1 });
  const a = await mic.boundingBox(), b = await page.getByRole("button", { name: "Send now", exact: true }).boundingBox();
  expect(a!.width).toBeGreaterThanOrEqual(44);
  expect(b!.x - a!.x - a!.width).toBeLessThanOrEqual(8);
  expect(Math.abs(a!.y - b!.y)).toBeLessThanOrEqual(1);
  await assertViewportLocked(page);
});

test("speech waits for silence, preserves edits, deduplicates and never submits", async ({ page }) => {
  const calls = await microphone(page); let submissions = 0;
  page.on("request", r => { if (r.method() === "POST" && r.url().endsWith("/messages")) submissions++; });
  await page.goto("/#/task/t-idle-interrupted");
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  await input.fill("Original draft");
  await page.getByRole("button", { name: "Start voice input" }).click();
  await expect(page.getByText("Listening… tap the microphone to finish.")).toBeVisible();
  await page.evaluate(() => { const v = (window as any).voiceTest; v.speaking = true; v.emit("one", " Hello"); v.emit("one", " Hello"); });
  await input.fill("Edited while listening");
  await page.waitForTimeout(1100);
  await expect(input).toHaveValue("Edited while listening");
  await input.press("Control+Enter"); expect(submissions).toBe(0);
  await page.evaluate(() => { const v = (window as any).voiceTest; v.emit("two", " world."); v.speaking = false; });
  await expect(input).toHaveValue("Edited while listening Hello world.");
  await expect(page.getByRole("button", { name: "Send now", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Stop voice input" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).voiceTest.stopped)).toBeGreaterThan(0);
  // Late words after releasing the microphone remain part of this draft.
  await page.evaluate(() => (window as any).voiceTest.emit("three", " One more."));
  await expect(page.getByRole("button", { name: "Start voice input" })).toBeVisible();
  await expect(input).toHaveValue("Edited while listening Hello world. One more.");
  await expect(page.getByRole("button", { name: "Send now", exact: true })).toBeEnabled();
  expect(calls.starts()).toBe(1); await expect.poll(calls.stops).toBe(1); expect(submissions).toBe(0);
});

test("permission rejection preserves the draft and returns the microphone to idle", async ({ page }) => {
  const calls = await microphone(page, "denied");
  await page.goto("/#/task/t-idle-interrupted");
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Keep me");
  await page.getByRole("button", { name: "Start voice input" }).click();
  await expect(page.getByRole("alert")).toContainText("Microphone access was denied");
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("Keep me");
  await expect(page.getByRole("button", { name: "Start voice input" })).toBeEnabled();
  expect(calls.starts()).toBe(0);
});

test("cancelling while permission is pending releases a later microphone grant", async ({ page }) => {
  const calls = await microphone(page, "pending");
  await page.goto("/#/task/t-idle-interrupted");
  await page.getByRole("button", { name: "Start voice input" }).click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).voiceTest.allow)).toBe("function");
  await page.getByRole("button", { name: "Stop voice input" }).click();
  await page.evaluate(() => (window as any).voiceTest.allow());
  await expect.poll(() => page.evaluate(() => (window as any).voiceTest.stopped)).toBeGreaterThan(0);
  expect(calls.starts()).toBe(0);
});

test("changing runtime closes dictation and ignores late words", async ({ page }) => {
  const calls = await microphone(page);
  await page.goto("/#/new");
  const configure = page.getByRole("button", { name: "Configure model and effort" });
  await configure.click(); await page.getByRole("radio", { name: "codex", exact: true }).click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("textbox", { name: "Prompt", exact: true }).fill("Keep my draft");
  await page.getByRole("button", { name: "Start voice input" }).click();
  await expect(page.getByText("Listening… tap the microphone to finish.")).toBeVisible();
  await configure.click(); await page.getByRole("radio", { name: "claude", exact: true }).click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect.poll(calls.stops).toBe(1);
  await page.evaluate(() => (window as any).voiceTest.emit("late", "Do not append"));
  await expect(page.getByRole("button", { name: "Start voice input" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Prompt", exact: true })).toHaveValue("Keep my draft");
});
