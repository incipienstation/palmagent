/** Recheck every delivered frame and close idle streams when their session expires.
 * This wraps all authenticated SSE responses, including future resource streams. */
export function guardSessionStream(response: Response, valid: () => boolean): Response {
  const reader = response.body!.getReader();
  let closed = false;
  let timer: ReturnType<typeof setInterval>;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setInterval(() => {
        if (closed) return;
        try {
          if (valid()) return;
          controller.close();
        } catch (error) {
          controller.error(error);
        }
        closed = true;
        clearInterval(timer);
        void reader.cancel().catch(() => {});
      }, 1000);
      timer.unref();
    },
    async pull(controller) {
      try {
        if (!valid()) {
          closed = true; clearInterval(timer); controller.close();
          await reader.cancel(); return;
        }
        const result = await reader.read();
        if (closed) return;
        if (result.done || !valid()) {
          closed = true; clearInterval(timer); controller.close();
          await reader.cancel(); return;
        }
        controller.enqueue(result.value);
      } catch (error) {
        if (!closed) { closed = true; clearInterval(timer); controller.error(error); }
        await reader.cancel().catch(() => {});
      }
    },
    async cancel(reason) {
      closed = true; clearInterval(timer);
      await reader.cancel(reason);
    },
  }, { highWaterMark: 0 });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
