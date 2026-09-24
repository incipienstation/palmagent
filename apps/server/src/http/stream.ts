import { deferActivityEventDetails } from "@palmagent/shared";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { StreamQuerySchema } from "@palmagent/shared/requests";
import type { EventRow } from "../db.js";
import type { z } from "zod";
import type { HttpDependencies } from "./types.js";

// Bound pending live output while a client is reading slowly.
// Disconnecting is recoverable: the client catches up through REST on reconnect.
const MAX_PENDING_BYTES = 64 * 1024 * 1024;
const MAX_PENDING_FRAMES = 1024;

export function sessionStream(c: Context, { db, hub, service, config, shutdown, build }: HttpDependencies, query: z.output<typeof StreamQuerySchema>) {
  const taskId = query.task || undefined;
  if (taskId) service.getTask(taskId);
  const snapshotsOnly = query.snapshots === "1";
  const idOf = (row: EventRow) => taskId ? row.seq : row.id;
  const frame = (row: EventRow) => {
    const compact = taskId && query.details === "summary" ? deferActivityEventDetails(row.event) : undefined;
    return `id: ${idOf(row)}\ndata: ${JSON.stringify({ type: "event", event: compact?.event ?? row.event, ...(compact?.detailsDeferred ? { detailsDeferred: true } : {}) })}\n\n`;
  };
  const snapshot = (historyThrough?: number) => `data: ${JSON.stringify({ type: "tasks", tasks: service.listTasks(), historyThrough, version: build?.version })}\n\n`;

  const response = streamSSE(c, async (stream) => {
    // Capture a durable boundary and subscribe synchronously BEFORE the first
    // asynchronous write. Persisted events through this fence come from REST;
    // only events produced after subscription are published on this stream.
    const boundary = db.eventCursor(taskId);
    const firstSnapshot = snapshot(taskId ? boundary : undefined);
    let pendingBytes = 0;
    const queue: string[] = [];
    let wake: (() => void) | undefined;
    let closed = false;
    const enqueue = (value: string) => {
      if (closed) return;
      pendingBytes += Buffer.byteLength(value);
      if (queue.length >= MAX_PENDING_FRAMES || pendingBytes > MAX_PENDING_BYTES) { stream.abort(); return; }
      queue.push(value);
      wake?.();
    };
    const offEvent = snapshotsOnly ? () => {} : hub.onEvent((row) => {
      if ((!taskId || row.event.taskId === taskId) && idOf(row) > boundary) enqueue(frame(row));
    });
    const offUpdates = taskId ? () => {} : hub.onUpdates(() => enqueue('data: {"type":"updates"}\n\n'));
    const offTasks = hub.onTasks(() => enqueue(snapshot()));
    const keepAlive = setInterval(() => enqueue(":keep-alive\n\n"), config.keepAliveMs);
    const abort = () => stream.abort();
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(keepAlive);
      offEvent(); offTasks(); offUpdates();
      shutdown?.removeEventListener("abort", abort);
      c.req.raw.signal.removeEventListener("abort", abort);
      queue.length = 0;
      wake?.();
    };
    stream.onAbort(close);
    shutdown?.addEventListener("abort", abort, { once: true });
    c.req.raw.signal.addEventListener("abort", abort, { once: true });
    if (shutdown?.aborted || c.req.raw.signal.aborted) stream.abort();
    try {
      if (closed) return;
      await stream.write(": connected\n\n" + firstSnapshot);
      while (!closed) {
        if (!queue.length) { await new Promise<void>((resolve) => { wake = resolve; }); wake = undefined; }
        while (!closed && queue.length) {
          const value = queue.shift()!;
          await stream.write(value);
          pendingBytes -= Buffer.byteLength(value);
        }
      }
    } finally { close(); }
  });
  response.headers.set("cache-control", "no-cache, no-transform");
  response.headers.set("x-accel-buffering", "no");
  return response;
}
