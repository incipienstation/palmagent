import { test, expect } from "@playwright/test";
import { installScopedStream, open, send, viewport, expectBottom } from "./_session-stream";

const taskId = "t-idle-rich";
function message(seq: number, paragraphs: number) {
  return { seq, event: { taskId, agent: "codex", ts: seq, kind: "assistant_text", payload: {
    messageId: `message-${seq}`,
    text: Array.from({ length: paragraphs }, (_, index) => `Message ${seq}, paragraph ${index}: A measured paragraph in the conversation history.`).join("\n\n"),
  } } };
}

for (const width of [360, 1280]) test.describe(`${width}px history`, () => {
  test.use({ viewport: { width, height: width === 360 ? 780 : 900 } });
  test("wheel reading survives a prepend estimated from a much taller message", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("pref:output-mode", "verbose"));
    await installScopedStream(page);
    let requested = 0;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    let releaseTail!: () => void;
    const tail = new Promise<void>(resolve => { releaseTail = resolve; });
    await page.route(new RegExp(`/api/tasks/${taskId}/history(?:\\?.*)?$`), async route => {
      const before = new URL(route.request().url()).searchParams.get("before");
      if (before === "901") { await tail; return route.fulfill({ json: { events: [], before: null, cursor: 1004 } }); }
      const earlier = before === "1001";
      if (earlier) { requested++; await pending; }
      return route.fulfill({ json: { events: earlier
        ? [message(901, 12), message(902, 1), message(903, 12)]
        : before ? [message(1001, 80), message(1002, 1), message(1003, 1)] : [message(1004, 24)],
      before: earlier ? 901 : before ? 1001 : 1004, cursor: 1004 } });
    });
    await open(page, taskId, { serverHistory: true });
    await send(page, taskId, { type: "tasks", tasks: [], historyThrough: 1004 });
    await expect(page.locator('[data-message-key="1001"]')).toHaveCount(1);
    await expectBottom(page);
    await viewport(page).hover();
    const capture = await viewport(page).evaluateHandle(pane => {
      const state = { active: true, frames: 0, blank: 0, backward: 0 };
      let previous = new Map<string, number>();
      const frame = () => {
        if (!state.active) return;
        const bounds = pane.getBoundingClientRect();
        const mounted = Array.from(pane.querySelectorAll<HTMLElement>("[data-row-key]")).map(row => ({
          key: row.dataset.rowKey!, rect: row.getBoundingClientRect(),
        }));
        const visible = mounted.filter(({ rect }) => rect.bottom > bounds.top && rect.top < bounds.bottom);
        state.frames++;
        state.blank += Number(!visible.length);
        // Keep a previously visible row in the comparison after it leaves the
        // viewport; otherwise a large jump can hide its own evidence.
        state.backward = Math.min(state.backward, ...mounted.flatMap(({ key, rect }) => previous.has(key) ? [rect.top - previous.get(key)!] : []));
        previous = new Map(visible.map(({ key, rect }) => [key, rect.top]));
        requestAnimationFrame(() => setTimeout(frame, 0));
      };
      requestAnimationFrame(() => setTimeout(frame, 0));
      return state;
    });
    const wheelDistance = width === 360 ? 240 : 120;
    for (let step = 0; step < 18; step++) {
      await page.mouse.wheel(0, -wheelDistance);
      if (step === 2) release();
      await page.waitForTimeout(40);
    }
    await expect(page.locator('[data-message-key="901"]')).toHaveCount(1);
    await page.waitForTimeout(500);
    const result = await capture.evaluate(state => { state.active = false; return state; });
    await capture.dispose();
    const distance = await viewport(page).evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop);
    releaseTail();
    console.log(JSON.stringify({ requested, distance, ...result }));
    expect(Math.abs(distance - 18 * wheelDistance), "Prepending must not skip content or cancel wheel movement").toBeLessThanOrEqual(2);
    expect(requested).toBe(1);
    expect(result.frames).toBeGreaterThan(5);
    expect(result.blank).toBe(0);
    expect(result.backward).toBeGreaterThanOrEqual(-2);
  });
});
