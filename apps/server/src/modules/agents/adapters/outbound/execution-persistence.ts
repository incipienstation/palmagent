import { setTimeout as delay } from "node:timers/promises";

type Sample = { calls: number; busyRetries: number; maxAttemptMs: number; maxQueueMs: number };

/** Serializes durable host writes without blocking provider I/O during lock contention.
 * Only rolled-back SQLite operations belong here, never provider delivery itself.
 */
export class ExecutionPersistence {
  private tail: Promise<unknown> = Promise.resolve();
  private samples = new Map<string, Sample>();
  private timer: NodeJS.Timeout;
  constructor(private readonly report: (message: string) => void = console.error,
    private readonly retryWindowMs = 60_000) {
    this.timer = setInterval(() => this.flushMetrics(), 60_000);
    this.timer.unref();
  }
  run<T>(operation: string, write: () => T): Promise<T> {
    const queued = performance.now();
    const result = this.tail.then(async () => {
      const started = performance.now();
      let retries = 0;
      for (;;) {
        const sample = this.samples.get(operation) ?? { calls: 0, busyRetries: 0, maxAttemptMs: 0, maxQueueMs: 0 };
        this.samples.set(operation, sample);
        sample.maxQueueMs = Math.max(sample.maxQueueMs, Math.round(started - queued));
        const attempt = performance.now();
        try {
          const value = write();
          sample.calls++;
          if (retries) this.report(JSON.stringify({ event: "execution_store_recovered", operation, retries, elapsedMs: Math.round(performance.now() - started) }));
          return value;
        } catch (error) {
          const code = (error as { code?: string })?.code;
          if (code !== "SQLITE_BUSY" && !code?.startsWith("SQLITE_BUSY_")) throw error;
          sample.busyRetries++;
          if (performance.now() - started >= this.retryWindowMs) throw error;
          if (!retries) this.report(JSON.stringify({ event: "execution_store_busy", operation }));
          retries++;
        } finally {
          sample.maxAttemptMs = Math.max(sample.maxAttemptMs, Math.round(performance.now() - attempt));
        }
        // Yield to pipes and timers; jitter prevents independent hosts retrying in step.
        await delay(Math.min(250, 25 * 2 ** Math.min(retries - 1, 4)) + Math.random() * 25);
      }
    });
    // Keep the chain rejected on a permanent failure: later events must not
    // overtake a missing durable event. Callers own the terminal error handler.
    this.tail = result;
    return result;
  }
  close(): void { clearInterval(this.timer); this.flushMetrics(); }
  private flushMetrics(): void {
    if (!this.samples.size) return;
    this.report(JSON.stringify({ event: "execution_store_metrics", operations: Object.fromEntries(this.samples) }));
    this.samples.clear();
  }
}
