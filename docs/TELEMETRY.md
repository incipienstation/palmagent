# Performance sharing and migration measurements

Palmagent uses optional aggregate performance metrics to investigate regressions and evaluate
backend migration work. Sharing is selected by default. Collection and upload start only after
the signed-in installation owner acknowledges the disclosure. Closing the disclosure leaves
sharing pending. **Settings → Performance → Share performance metrics** changes the saved choice.

The choice lives in `telemetry.json` beside the shared user configuration (`PALMAGENT_HOME`,
normally `~/.palmagent`). It survives application updates and service reinstalls. A missing,
malformed, or unsupported file disables collection. It is separate from `config.json` so retained
older configuration writers cannot overwrite the choice. Processes refresh it within one second;
exporters also check immediately before upload. A settings change clears aggregates and queued
batches and aborts the current web uploader. Requests already received cannot be recalled.
Retained processes from releases that include this contract observe the same preference.
Older releases that predate instrumentation do not collect these metrics.

Development, unauthenticated web runs, and dirty/unidentified builds do not upload. The browser only manages preferences;
backend processes perform collection and HTTPS export. A local benchmark never uploads its report.

## Collected fields and retention

Only these resource dimensions are sent:

- Component: web, daemon, execution host, or terminal host.
- The actual emitting component's release and implementation (`node` or `rust`).
- OS, CPU architecture, and production/synthetic source.
- Fixed operation and outcome names; a coarse concurrency bucket.

No prompts, conversation contents, code, file paths, repository/task/session IDs, command lines,
raw errors, hostnames, source commits, or persistent installation identifiers are sent. The
receiver and its network provider can see connection metadata such as IP addresses; this is
not a claim of complete anonymity. The public collector retains aggregate data for seven days.
Received aggregates cannot be attributed to an installation for retrospective deletion.

`packages/shared/src/telemetry-contract.json` owns cross-language histogram boundaries, operation
names, and buckets. TypeScript and Rust consume the same artifact. Histograms use seconds, bytes,
or CPU cores (1 = one fully utilized core); monotonic counters and histograms are exported as
deltas. Unknown dimensions are rejected by the receiver. A random batch UUID supports bounded
retry deduplication and is never exported into metrics.

## Measurement boundaries

| Metric / operation | Measured boundary | Interpretation |
| --- | --- | --- |
| `http.*` | Hono request handling to response creation, including awaited work | API groups, not individual URLs; excludes SSE lifetimes and response network transfer |
| `event.deliver` | Event callback enqueue through completion of its SSE write | Server queue/write latency, not browser render time; concurrency is queued frames |
| `storage.queue` | Execution persistence submission to the serial write attempt | Local queue delay; one serial writer |
| `storage.write` | Each execution SQLite write attempt | Successful and failed attempts remain separate; retry wait is not write execution time |
| `execution.start` | Synchronous provider runner start call | Host dispatch cost, not model time or provider readiness |
| `terminal.start` | Terminal host initialization through shell readiness | Excludes time before this host begins initialization |
| `daemon.*` | Native request dispatch through completion, including lifecycle waits | Native daemon work; status/telemetry polling excluded |
| Process CPU | CPU seconds / elapsed wall seconds, sampled every 15 seconds | Self process only; excludes model CLI and shell children |
| Process memory | Current resident set, sampled every 15 seconds | Self process only; not maximum RSS or whole installation memory |
| Node event-loop delay | Lateness of a 100 ms timer | Distribution of timer delays; not a Rust metric or a request latency |
| SQLite busy retries | Busy attempts in execution persistence | Scope does not include every SQLite operation in the web process |

For HTTP and web resources, concurrency is in-flight non-streaming HTTP requests. For Rust it is
open daemon control connections. Execution and terminal hosts each represent one invocation.
These load definitions differ by component: compare like components. Provider response time is
not labeled as Rust execution time. If an operation moves into Rust while the web caller remains
Node, its end-to-end web metric remains Node; add a native observation at the moved boundary.

The Rust daemon retains bounded cumulative snapshots locally. The web exporter establishes a
baseline on attachment and converts subsequent snapshots to deltas using the daemon's own
release. A web restart never replays retained counters. Missing telemetry on an older daemon
means unavailable native measurements, not zero use or inferred Node measurements.

## Compare migration stages

Generate the Grafana provisioning artifact with:

```sh
node scripts/generate-telemetry-dashboard.mjs > /tmp/palmagent-migration.json
```

The **Palmagent migration performance** dashboard requires the Prometheus data source UID
`palmagent-prometheus`. Select one component, operation, outcome, OS, architecture, and load
bucket. Then choose baseline/candidate releases and their actual implementations. Panels include
sample counts, p50/p95/p99, observed operation rate, errors, CPU, memory, and contention.
Quantile comparison panels require 30/100/1000 observations respectively. Empty panels mean
insufficient or unavailable observations, not zero latency.

Keep the logical measurement boundary and units unchanged when replacing an implementation.
Changing histogram boundaries or operation semantics needs a new metric/operation name and
coordinated receiver support. Never merge incompatible histograms into the same series.
Retained releases can coexist: use the producer's version rather than the current web version.
Native daemon status adds optional telemetry metadata without changing existing commands or
required response fields. Old clients ignore it and new collectors tolerate its absence.

Production comparisons are observational. Hardware models, payload size, provider behavior,
sampling, and installation mix can still differ within a cohort. A difference between today's
Node web and Rust supervisor measures different work and is not evidence of a Rust speedup.
Use production trends to locate candidate improvements, then repeat a controlled workload.

## Repeatable local comparison

Use two clean identified builds in isolated loopback validation installations on the same machine,
with the same immutable fixture data and resource limits. Disable sharing in the validation
installation; these local reports remain separate from production metrics. For authenticated
fixtures, supply the session cookie through `PALMAGENT_BENCH_COOKIE`; it is never saved in reports.

```sh
node scripts/benchmark-performance.mjs --url http://localhost:4000 \
  --fixture tasks-v1 --scenario tasks --requests 1000 --concurrency 4 --rounds 5 \
  --out /tmp/baseline.json
# Switch the isolated validation server to the candidate build, retaining the same fixture.
node scripts/benchmark-performance.mjs --url http://localhost:4000 \
  --fixture tasks-v1 --scenario tasks --requests 1000 --concurrency 4 --rounds 5 \
  --out /tmp/candidate.json
node scripts/benchmark-performance.mjs --baseline /tmp/baseline.json --candidate /tmp/candidate.json
```

`health` is also available as a minimal request scenario. The task scenario reads the task-list
endpoint; it does not call an AI provider or mutate tasks. Reports capture the build, workload
revision, fixture revision/count, concurrency, machine class, client Node version, per-round
latencies, throughput, and response size. No response content is saved. A failed request,
changing fixture count, or changed server build aborts the run. Comparison rejects different
machine/workload contexts and reports median per-round deltas. Lower latency and higher throughput
are desirable; these deltas are not a significance test. Repeat A/B/A runs without other workloads.
Fixture content equality and identical resource limits remain the operator's responsibility.

## Failure and overhead limits

Collection does not wait for the network. Each Node process retains at most 128 aggregate streams
and eight upload batches of at most 32 points / 64 KiB each. Overflow drops optional samples.
Hosts also attempt a non-blocking upload after startup so short invocations need not wait for the periodic batch. Very short invocations can still exit before delivery; use the local benchmark to check this sampling bias.
Regular uploads run about once per minute with jitter; requests time out after five seconds,
do not follow redirects, and retry at most three times with the same UUID/body. Queued data
expires after ten minutes. There is no disk spool and shutdown does not wait to upload.
The daemon retains at most 32 native streams and resets its epoch every ten minutes.
Receiver outages and process restarts can lose measurements. Monitor collector rejection and
capacity panels before interpreting a change in observed sample volume as a product change.
