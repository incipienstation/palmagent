import type { Page } from "@playwright/test";

type ResourceStream = { onmessage?: (event: MessageEvent) => void; onerror?: (event: Event) => void; onopen?: (event: Event) => void };
type Streams = { readStreams: Map<string, ResourceStream> };
export async function installReadStreams(page: Page) {
  await page.addInitScript(() => {
    const Native = window.EventSource;
    const streams = new Map<string, ResourceStream>();
    Object.assign(window, { readStreams: streams });
    class Stream {
      onmessage?: (event: MessageEvent) => void;
      onerror?: (event: Event) => void;
      onopen?: (event: Event) => void;
      constructor(readonly url: string) {
        if (!url.endsWith("/stream") || !/\/api\/(agents|tasks)\//.test(url)) return new Native(url) as unknown as Stream;
        streams.set(url, this);
        queueMicrotask(() => {
          this.onopen?.(new Event("open"));
          this.onmessage?.(new MessageEvent("message", { data: '{"type":"read-change"}' }));
        });
      }
      close() { if (streams.get(this.url) === this) streams.delete(this.url); }
    }
    window.EventSource = Stream as unknown as typeof EventSource;
  });
}
export async function changeRead(page: Page, url: string, reconnect = false) {
  await page.evaluate(({ url, reconnect }) => {
    const stream = (window as unknown as Streams).readStreams.get(url);
    if (!stream) throw new Error(`No resource subscription for ${url}`);
    if (reconnect) { stream.onerror?.(new Event("error")); stream.onopen?.(new Event("open")); }
    stream.onmessage?.(new MessageEvent("message", { data: '{"type":"read-change"}' }));
  }, { url, reconnect });
}
