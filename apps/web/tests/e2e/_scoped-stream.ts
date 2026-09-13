import { expect, type Page } from "@playwright/test";

// Deliver scoped SSE frames across separate browser turns, including pauses and
// reconnects. The inbox and the rest of the app still use the mock HTTP server.
export async function installScopedStream(page: Page) {
  await page.addInitScript(() => {
    const NativeEventSource = window.EventSource;
    const streams = new Map<string, EventSource>();
    class ScopedStream extends EventTarget {
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      constructor(url: string | URL) {
        super();
        const parsed = new URL(url, location.href);
        const taskId = parsed.searchParams.get("task");
        if (!taskId) return new NativeEventSource(url) as unknown as ScopedStream;
        streams.set(taskId, this as unknown as EventSource);
        queueMicrotask(() => this.onopen?.(new Event("open")));
      }
      close() {}
    }
    window.EventSource = ScopedStream as unknown as typeof EventSource;
    Object.assign(window, {
      sendScopedFrame(taskId: string, frame: unknown, seq = 0) {
        streams.get(taskId)?.onmessage?.(new MessageEvent("message", {
          data: JSON.stringify(frame), lastEventId: String(seq),
        }));
      },
      hasScopedStream(taskId: string) { return streams.has(taskId); },
    });
  });
}

export type Harness = Window & {
  sendScopedFrame(taskId: string, frame: unknown, seq?: number): void;
  hasScopedStream(taskId: string): boolean;
};
export async function send(page: Page, taskId: string, frame: unknown, seq = 0) {
  await page.evaluate(({ taskId, frame, seq }) => {
    (window as unknown as Harness).sendScopedFrame(taskId, frame, seq);
  }, { taskId, frame, seq });
}
export async function event(page: Page, taskId: string, seq: number, text: string) {
  await send(page, taskId, { type: "event", event: {
    taskId, agent: "codex", ts: seq, kind: "assistant_text", payload: { text },
  } }, seq);
}
export async function open(page: Page, taskId: string) {
  await page.goto(`/#/task/${taskId}`);
  await expect.poll(() => page.evaluate((id) =>
    (window as unknown as Harness).hasScopedStream(id), taskId)).toBe(true);
}
