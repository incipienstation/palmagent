import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { StreamQuerySchema } from "@palmagent/shared/requests";
import type { EventRow } from "../db.js";
import { HttpError } from "../service.js";
import { parse } from "./input.js";
import type { HttpDependencies } from "./types.js";

// Bound pending live output while a client is replaying or reading slowly.
// Disconnecting is recoverable: the client resumes from its last received ID.
const MAX_PENDING_BYTES = 64 * 1024 * 1024;
const MAX_PENDING_FRAMES = 1024;

export function sessionStream(c: Context, { db, hub, service, config, shutdown }: HttpDependencies) {
  const query = parse(StreamQuerySchema, c.req.query());
  const taskId = query.task || undefined;
  if (taskId) service.getTask(taskId);
  const cursor = Number(c.req.header("last-event-id") ?? query.lastEventId ?? 0);
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new HttpError(400, "invalid event cursor");
  const idOf = (row: EventRow) => taskId ? row.seq : row.id;
  const frame = (row: EventRow) => `id: ${idOf(row)}\ndata: ${JSON.stringify({ type: "event", event: row.event })}\n\n`;
  const snapshot = () => `data: ${JSON.stringify({ type: "tasks", tasks: service.listTasks() })}\n\n`;

  const response = streamSSE(c, async (stream) => {
    // Capture a durable boundary and subscribe synchronously BEFORE the first
    // asynchronous write. New events queue behind replay; no gap or duplicate.
    const boundary = db.eventCursor(taskId);
    const firstSnapshot = snapshot();
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
    const offEvent = hub.onEvent((row) => {
      if ((!taskId || row.event.taskId === taskId) && idOf(row) > Math.max(boundary, cursor)) enqueue(frame(row));
    });
    const offTasks = hub.onTasks(() => enqueue(snapshot()));
    const keepAlive = setInterval(() => enqueue(":keep-alive\n\n"), config.keepAliveMs);
    const abort = () => stream.abort();
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(keepAlive);
      offEvent(); offTasks();
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
      let after = cursor;
      while (!closed && after < boundary) {
        const rows = (taskId ? db.eventsAfterSeq(taskId, after, 16) : db.eventsAfterGlobal(after, 16)).filter((row) => idOf(row) <= boundary);
        if (!rows.length) break;
        for (const row of rows) {
          if (closed || idOf(row) > boundary) break;
          await stream.write(frame(row));
          after = idOf(row);
        }
      }
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
