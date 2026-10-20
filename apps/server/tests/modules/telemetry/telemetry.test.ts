import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { TELEMETRY, type TelemetryResource } from "@palmagent/shared/telemetry";
import { MetricAggregate } from "../../../src/modules/telemetry/domain/aggregate.js";
import { TelemetryProducer } from "../../../src/modules/telemetry/adapters/outbound/producer.js";
import { readTelemetryChoice, telemetrySettings } from "../../../src/modules/telemetry/adapters/outbound/preference.js";
import { DaemonMetricReader } from "../../../src/modules/telemetry/adapters/outbound/daemon-metrics.js";
import { metricPayload } from "../../../src/modules/telemetry/adapters/outbound/wire.js";
import { telemetryRoutes } from "../../../src/modules/telemetry/adapters/inbound/http.js";
import { requestMeasurements, requestOperation } from "../../../src/platform/http/performance.js";
import { handleError } from "../../../src/platform/http/errors.js";

const resource: TelemetryResource = { service: "palmagent.web", version: "0.1.0-alpha.1",
  implementation: "node", os: "linux", arch: "amd64", source: "synthetic" };
function fixture(t: test.TestContext, fetcher?: typeof fetch) {
  const dir = mkdtempSync(join(tmpdir(), "palmagent-metrics-"));
  const path = join(dir, "telemetry.json");
  const producer = new TelemetryProducer({ preferencePath: path, resource, available: true, concurrency: () => 1, fetcher });
  const settings = telemetrySettings(path, () => producer.refresh(), true);
  t.after(() => { producer.close(); rmSync(dir, { recursive: true, force: true }); });
  return { producer, settings, path };
}
test("aggregation preserves histogram counts, limits cardinality, and discards content labels", () => {
  const aggregate = new MetricAggregate(1);
  for (const seconds of [0, .001, .006, 90]) aggregate.observe("palmagent.operation.duration", seconds, {
    concurrency: "1", operation: "storage.write", outcome: "success", ...{ path: "/private/marker" },
  });
  aggregate.observe("palmagent.operation.duration", 1, { concurrency: "1", operation: "/private/marker", outcome: "success" });
  aggregate.observe("palmagent.process.memory.usage", 10, { concurrency: "1" });
  const points = aggregate.drain();
  assert.equal(points.length, 1);
  assert.equal(points[0].count, 4);
  assert.equal(points[0].buckets.reduce((a, b) => a + b), 4);
  assert.equal(points[0].buckets[0], 2);
  assert.equal(points[0].buckets.at(-1), 1);
  const body = JSON.stringify(metricPayload(resource, points, 100, 101));
  assert(!body.includes("private"));
  assert(body.includes('"aggregationTemporality":1'));
  assert.deepEqual(aggregate.drain(), []);
});
test("no samples before disclosure; retries preserve identity; opt-out clears retained producers and queues", async t => {
  const requests: { id: string; body: string }[] = [];
  const f = fixture(t, (async (_url, init) => {
    requests.push({ id: (init!.headers as Record<string, string>)["x-palmagent-batch-id"], body: String(init!.body) });
    return new Response(null, { status: requests.length === 1 ? 503 : 200 });
  }) as typeof fetch);
  const retained = new TelemetryProducer({ preferencePath: f.path, resource, available: true, concurrency: () => 1,
    fetcher: (async () => { assert.fail("disabled retained producer uploaded"); }) as typeof fetch });
  t.after(() => retained.close());
  f.producer.start();
  f.producer.operation("http.tasks.read", .02, "success", 1);
  f.producer.flush(); await f.producer.send();
  assert.equal(requests.length, 0);
  assert.equal(f.settings.status().pendingDisclosure, true);
  f.settings.change(true); retained.refresh();
  assert.equal(readTelemetryChoice(f.path)?.enabled, true);
  f.producer.operation("http.tasks.read", .02, "success", 1);
  f.producer.flush(); await f.producer.send(); await f.producer.send();
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(JSON.parse(requests[0].body).resourceMetrics[0].scopeMetrics[0].metrics[0].histogram.dataPoints[0].count, 1);
  retained.operation("storage.write", .01, "success", 1); retained.flush();
  const finish = f.producer.beginOperation("http.tasks.write", 1);
  f.settings.change(false);
  await retained.send();
  assert.equal(retained.active, false);
  f.settings.change(true); finish("success");
  f.producer.flush(); await f.producer.send();
  assert.equal(requests.length, 2, "an operation spanning a preference change must be dropped");
  writeFileSync(f.path, '{"enabled":true}');
  f.producer.refresh();
  assert.equal(f.producer.active, false);
});
test("opt-out aborts an in-flight upload; unavailable builds never collect", async t => {
  let signal: AbortSignal | undefined;
  const f = fixture(t, (async (_url, init) => {
    signal = init?.signal as AbortSignal;
    return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  }) as typeof fetch);
  f.settings.change(true);
  f.producer.operation("storage.write", .1, "success", 1); f.producer.flush();
  const pending = f.producer.send();
  assert(signal);
  f.settings.change(false);
  await pending;
  assert.equal(signal.aborted, true);
  const disabled = new TelemetryProducer({ preferencePath: f.path, resource, available: false, concurrency: () => 0 });
  f.settings.change(true); disabled.refresh();
  assert.equal(disabled.active, false); disabled.close();
});
test("daemon deltas handle restart, reset, duplicate snapshots, and reject arbitrary attributes", () => {
  const reader = new DaemonMetricReader(), now = Date.now();
  const revision = "00000000-0000-4000-8000-000000000001";
  const aggregate = new MetricAggregate();
  aggregate.observe("palmagent.operation.duration", .002, { concurrency: "1", operation: "daemon.list", outcome: "success" });
  const [point] = aggregate.drain();
  const snapshot = (n: number, epoch = 1, instance = "local-only-instance") => ({ version: "0.1.0-alpha.2", instance,
    telemetry: { schemaVersion: 1, revision, epoch, startedAt: now - 10000, sampledAt: now - 1000 + n,
      points: [{ ...point, count: n, sum: point.sum * n, buckets: point.buckets.map(value => value * n) }] } });
  assert.equal(reader.read(snapshot(1), revision, now), undefined);
  const delta = reader.read(snapshot(3), revision, now)!;
  assert.equal(delta.version, "0.1.0-alpha.2");
  assert.equal(delta.points[0].count, 2);
  assert.equal(reader.read(snapshot(3), revision, now), undefined);
  assert.equal(reader.read(snapshot(4, 2), revision, now)!.points[0].count, 4);
  assert.equal(reader.read(snapshot(5, 2, "new-instance"), revision, now), undefined);
  const unsafe = snapshot(6, 2, "new-instance");
  Object.assign(unsafe.telemetry.points[0].attributes, { path: "/private/marker" });
  assert.equal(reader.read(unsafe, revision, now), undefined);
  assert.equal(reader.read(snapshot(7), "different-revision", now), undefined);
});
test("HTTP metrics separate operations, omit streaming lifetimes, and count handled errors", async t => {
  const sent: string[] = [];
  const f = fixture(t, (async (_url, init) => { sent.push(String(init!.body)); return new Response(null); }) as typeof fetch);
  f.settings.change(true);
  const load = { active: 0 }, app = new Hono();
  app.use("*", requestMeasurements(f.producer, load));
  app.get("/api/tasks/:id", c => c.json({ error: "private-marker" }, 404));
  app.get("/api/stream", c => c.text("stream"));
  await app.request("/api/tasks/private-id");
  await app.request("/api/stream");
  assert.equal(load.active, 0);
  f.producer.flush(); await f.producer.send();
  assert.equal(sent.length, 1);
  assert(!sent[0].includes("private"));
  const attrs = JSON.parse(sent[0]).resourceMetrics[0].scopeMetrics[0].metrics[0].histogram.dataPoints[0].attributes;
  assert(attrs.some((a: { key: string; value: { stringValue: string } }) => a.key === "outcome" && a.value.stringValue === "error"));
  assert.equal(requestOperation("/api/stream", "GET"), undefined);
  assert(TELEMETRY.operations.includes(requestOperation("/api/tasks", "POST")!));
});
test("settings require enabled auth, validate inputs, persist choice, and retain the default until disclosure", async t => {
  const f = fixture(t);
  const request = (body: unknown) => ({ method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const unauthenticated = telemetryRoutes(f.settings, false); unauthenticated.onError(handleError);
  assert.equal((await unauthenticated.request("/", request({ enabled: true }))).status, 403);
  const app = telemetryRoutes(f.settings, true); app.onError(handleError);
  assert.equal((await app.request("/", request({ enabled: true, extra: "private" }))).status, 400);
  assert.equal((await app.request("/", request({ enabled: true }))).status, 400);
  assert.equal((await app.request("/", request({ enabled: true, retentionDays: 7 }))).status, 400);
  assert.equal((await app.request("/", request({ enabled: true, retentionDays: 180 }))).status, 200);
  assert.equal((await app.request("/", request({ enabled: false }))).status, 200);
  assert.equal(JSON.parse(readFileSync(f.path, "utf8")).enabled, false);
  assert.deepEqual(await (await app.request("/")).json(), { enabled: false, pendingDisclosure: false, available: true });
});

test("legacy opt-out survives; legacy opt-in waits for the longer policy and new uploads use v2", async t => {
  const urls: string[] = [];
  const f = fixture(t, (async url => { urls.push(String(url)); return new Response(null); }) as typeof fetch);
  const legacy = { schemaVersion: 1, enabled: false, disclosed: true, revision: "00000000-0000-4000-8000-000000000001" };
  writeFileSync(f.path, JSON.stringify(legacy));
  assert.deepEqual(f.settings.status(), { available: true, enabled: false, pendingDisclosure: false });
  f.producer.refresh(); assert.equal(f.producer.active, false);
  writeFileSync(f.path, JSON.stringify({ ...legacy, enabled: true }));
  assert.equal(f.settings.status().pendingDisclosure, true);
  f.producer.refresh(); assert.equal(f.producer.active, false);
  f.producer.operation("storage.write", .1, "success", 1); f.producer.flush(); await f.producer.send();
  assert.deepEqual(urls, []);
  f.settings.change(true);
  assert.equal(JSON.parse(readFileSync(f.path, "utf8")).schemaVersion, 2);
  f.producer.operation("storage.write", .1, "success", 1); f.producer.flush(); await f.producer.send();
  assert.deepEqual(urls, ["https://telemetry.palmagent.dev/v2/metrics"]);
});
