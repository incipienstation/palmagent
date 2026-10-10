import type { Context } from "hono";
import { streamSSE } from "hono/streaming";

/** Invalidations coalesce while the reader is slow; reconnect always revalidates. */
export function readStream(c: Context, subscribe: (changed: () => void) => () => void,
  keepAliveMs: number, shutdown?: AbortSignal) {
  const response = streamSSE(c, async stream => {
    let closed = false, changed = false, heartbeat = false;
    let wake: (() => void) | undefined;
    let unsubscribe = () => {};
    const notify = () => { changed = true; wake?.(); };
    const abort = () => stream.abort();
    const timer = setInterval(() => { heartbeat = true; wake?.(); }, keepAliveMs);
    const close = () => {
      if (closed) return;
      closed = true; clearInterval(timer); unsubscribe(); wake?.();
      shutdown?.removeEventListener("abort", abort);
      c.req.raw.signal.removeEventListener("abort", abort);
    };
    stream.onAbort(close);
    shutdown?.addEventListener("abort", abort, { once: true });
    c.req.raw.signal.addEventListener("abort", abort, { once: true });
    try {
      if (shutdown?.aborted || c.req.raw.signal.aborted) { stream.abort(); return; }
      unsubscribe = subscribe(notify);
      notify();
      while (!closed) {
        if (!changed && !heartbeat) await new Promise<void>(resolve => { wake = resolve; });
        wake = undefined;
        if (closed) break;
        const frame = changed ? 'data: {"type":"read-change"}\n\n' : ":keep-alive\n\n";
        changed = false; heartbeat = false;
        await stream.write(frame);
      }
    } finally { close(); }
  });
  response.headers.set("cache-control", "no-store, no-transform");
  response.headers.set("x-accel-buffering", "no");
  return response;
}
