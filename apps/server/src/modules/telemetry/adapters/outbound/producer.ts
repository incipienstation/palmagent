import { randomUUID } from "node:crypto";
import { TELEMETRY_ENDPOINT, concurrencyBucket, type TelemetryPoint, type TelemetryResource } from "@palmagent/shared/telemetry";
import type { PerformanceMeasurements } from "../../../../kernel/performance.js";
import { MetricAggregate } from "../../domain/aggregate.js";
import { readTelemetryChoice } from "./preference.js";
import { metricPayload } from "./wire.js";

type Batch = { id: string; body: string; created: number; attempts: number };
export type ProducerOptions = {
  preferencePath: string; resource: TelemetryResource; available: boolean;
  concurrency: () => number; endpoint?: string; fetcher?: typeof fetch;
};
/** Best-effort, bounded diagnostics. No disk queue and no network awaited by application work. */
export class TelemetryProducer implements PerformanceMeasurements {
  private readonly aggregate = new MetricAggregate();
  private queue: Batch[] = [];
  private revision: string | undefined;
  private started = Date.now();
  private closed = false;
  private timer?: NodeJS.Timeout;
  private loopTimer?: NodeJS.Timeout;
  private cpu = process.cpuUsage();
  private sampled = performance.now();
  private nextSample = 0;
  private nextFlush = Date.now() + 60_000 + Math.random() * 15_000;
  private nextSend = 0;
  private request?: AbortController;
  private sending = false;
  constructor(private readonly options: ProducerOptions) {}
  get active(): boolean { return !!this.revision && !this.closed; }
  start(): void {
    if (this.timer || this.closed || !this.options.available) return;
    this.refresh();
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref();
  }
  /** Called synchronously after a settings write; other retained processes poll within one second. */
  refresh(): void {
    const choice = readTelemetryChoice(this.options.preferencePath);
    const revision = this.options.available && choice?.enabled ? choice.revision : undefined;
    if (revision === this.revision) return;
    this.revision = revision;
    this.aggregate.clear(); this.queue = []; this.request?.abort();
    this.started = Date.now(); this.cpu = process.cpuUsage(); this.sampled = performance.now();
    clearTimeout(this.loopTimer); this.loopTimer = undefined;
    if (this.active) this.watchLoop();
  }
  private watchLoop(): void {
    const due = performance.now() + 100;
    this.loopTimer = setTimeout(() => {
      if (!this.active) return;
      this.aggregate.observe("palmagent.runtime.event_loop.delay", Math.max(0, performance.now() - due) / 1000, {
        concurrency: concurrencyBucket(this.options.concurrency()),
      });
      this.watchLoop();
    }, 100);
    this.loopTimer.unref();
  }
  beginOperation(name: string, concurrency: number): (outcome: "success" | "error" | "timeout") => void {
    if (!this.active) return () => {};
    const revision = this.revision, started = performance.now();
    let finished = false;
    return outcome => {
      if (finished) return; finished = true;
      if (revision && revision === this.revision) this.operation(name, (performance.now() - started) / 1000, outcome, concurrency);
    };
  }
  operation(operation: string, seconds: number, outcome: "success" | "error" | "timeout", concurrency: number): void {
    if (this.active) this.aggregate.observe("palmagent.operation.duration", seconds, { operation, outcome, concurrency: concurrencyBucket(concurrency) });
  }
  busyRetries(count: number, concurrency: number): void {
    if (this.active && count > 0 && Number.isSafeInteger(count)) this.aggregate.observe("palmagent.storage.busy_retries", count, { concurrency: concurrencyBucket(concurrency) });
  }
  private tick(): void {
    try {
      this.refresh();
      if (!this.active) return;
      const now = Date.now();
      if (now >= this.nextSample) {
        const cpu = process.cpuUsage(), sampled = performance.now();
        const attrs = { concurrency: concurrencyBucket(this.options.concurrency()) };
        if (sampled > this.sampled) this.aggregate.observe("palmagent.process.cpu.utilization",
          (cpu.user + cpu.system - this.cpu.user - this.cpu.system) / ((sampled - this.sampled) * 1000), attrs);
        this.aggregate.observe("palmagent.process.memory.usage", process.memoryUsage.rss(), attrs);
        this.cpu = cpu; this.sampled = sampled; this.nextSample = now + 15_000;
      }
      if (now >= this.nextFlush) {
        this.flush(); this.nextFlush = now + 60_000 + Math.random() * 15_000;
      }
      if (now >= this.nextSend) void this.send();
    } catch { /* Optional diagnostics cannot crash the runtime. */ }
  }
  flush(): void {
    this.refresh();
    const end = Date.now(), start = this.started;
    const points = this.aggregate.drain(); this.started = end;
    if (this.active && end >= start && end - start <= 600_000) this.enqueue(this.options.resource, points, start, end);
  }
  enqueue(resource: TelemetryResource, points: TelemetryPoint[], start: number, end: number): void {
    if (!this.active) return;
    for (let i = 0; i < points.length && this.queue.length < 8; i += 32) {
      const body = JSON.stringify(metricPayload(resource, points.slice(i, i + 32), start, end));
      if (Buffer.byteLength(body) <= 65536) this.queue.push({ id: randomUUID(), body, created: Date.now(), attempts: 0 });
    }
  }
  async send(): Promise<void> {
    this.refresh();
    if (!this.active || this.sending || this.closed) return;
    while (this.queue[0] && Date.now() - this.queue[0].created > 600_000) this.queue.shift();
    const batch = this.queue[0];
    if (!batch) return;
    this.sending = true;
    const controller = new AbortController(); this.request = controller;
    const timeout = setTimeout(() => controller.abort(), 5000); timeout.unref();
    let retry = true;
    try {
      const response = await (this.options.fetcher ?? fetch)(this.options.endpoint ?? TELEMETRY_ENDPOINT, {
        method: "POST", redirect: "error", credentials: "omit", signal: controller.signal,
        headers: { "content-type": "application/json", "x-palmagent-batch-id": batch.id }, body: batch.body,
      });
      retry = response.status === 429 || response.status >= 500;
      await response.body?.cancel();
    } catch { /* A retry uses exactly the same batch UUID and body. */ }
    finally {
      clearTimeout(timeout);
      batch.attempts++;
      if (this.queue[0] === batch && (!retry || batch.attempts >= 3)) this.queue.shift();
      this.nextSend = Date.now() + (retry ? 30_000 * batch.attempts : 2000);
      this.sending = false; this.request = undefined;
    }
  }
  close(): void {
    this.closed = true; clearInterval(this.timer); clearTimeout(this.loopTimer);
    this.revision = undefined; this.aggregate.clear(); this.queue = []; this.request?.abort();
  }
}
