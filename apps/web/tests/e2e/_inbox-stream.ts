import type { Page } from "@playwright/test";
import type { SseFrame } from "@palmagent/shared";
import { tasks } from "../fixtures.mjs";

export type InboxHarness = { inbox: { onopen?: (event: Event) => void; onerror?: (event: Event) => void; onmessage?: (event: MessageEvent) => void } };
export async function installInbox(page: Page) {
  await page.addInitScript(tasks => {
    class Stream {
      onopen?: (event: Event) => void;
      onerror?: (event: Event) => void;
      onmessage?: (event: MessageEvent) => void;
      constructor(url: string) {
        if (!url.startsWith("/api/stream")) return;
        Object.assign(window, { inbox: this });
        queueMicrotask(() => {
          this.onopen?.(new Event("open"));
          this.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ type: "tasks", tasks }) }));
        });
      }
      close() {}
    }
    window.EventSource = Stream as unknown as typeof EventSource;
  }, tasks);
}
export async function send(page: Page, frame: SseFrame) {
  await page.evaluate(frame => (window as unknown as InboxHarness).inbox.onmessage?.(
    new MessageEvent("message", { data: JSON.stringify(frame) }),
  ), frame);
}
