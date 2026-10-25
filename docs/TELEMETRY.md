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
raw errors, hostnames, source commits, or persistent installation identifiers are included in
metrics. The public collector retains aggregate metrics for up to 180 days. Capacity limits
can shorten the available history. Version 2 of the preference records acceptance of
this policy and sends to `/v2/metrics`; enabling through the API requires
`retentionDays: 180`. A cached client cannot accept it with the old request format.

An existing opt-out remains off. An existing seven-day opt-in requires the new notice
before this version collects or uploads. Older retained processes can keep using the
seven-day policy until a new choice is saved; saving either choice makes those older
producers stop. Native metrics resume when the daemon supports the new preference.
The legacy `/v1/metrics` endpoint and its separate store retain their seven-day limit;
previously collected data is never copied to the longer-lived store.
Received aggregates cannot be attributed to an installation for retrospective deletion.

### Connection metadata

The collection service processes source IP addresses for network access and request limits.
Its ingress keeps rate-limit state in bounded memory; it does not write client IP addresses
to its access logs or performance metrics. Only the ingestion protocol's required request
headers are forwarded to the internal collector. IP, location, cookie, authorization, and
arbitrary custom headers are not forwarded.

Cloudflare fronts the public endpoint and also processes connection metadata, including IP
addresses, under its [privacy policy](https://www.cloudflare.com/privacypolicy/).
The 180-day aggregate-metric retention is not a retention promise for Cloudflare's logs
or security processing. This service does not provide complete anonymity.

Operators must verify the relevant Cloudflare account and zone settings before making a
specific provider-retention claim. Review Logpush exports and their destination retention,
Logpull retention where available, Logs Engine storage, and security-event retention separately.
An unavailable API or missing permission means unverified, not disabled.
[Logpull's retention flag](https://developers.cloudflare.com/logs/logpull/enabling-log-retention/)
only controls Logpull; disabling it does not establish that Cloudflare keeps no other logs.
Keep account details and verification receipts outside this public repository.

Preserve ingress IP-based abuse limits when changing header handling. Cloudflare's
[Remove visitor IP headers transform](https://developers.cloudflare.com/rules/transform/managed-transforms/reference/#remove-visitor-ip-headers)
changes headers sent to the origin; it does not remove IP processing at Cloudflare.
Changing it can also alter origin rate limiting and affect other hostnames in the zone.

### Metric format

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
| `routine.create/update/remove/run/stop/read` | Native serialized command handling after dequeue through result creation | Excludes queue wait, HTTP transport and retained invocation duration; stop is a request attempt, including reconciliation retries |
| `routine.queue` | Native command submission through owner dequeue (or immediate admission rejection) | Excludes health and pending-state probes; accepted work remains measured after caller disconnect |
| `routine.poll` | One native scheduling/reconciliation pass, including persistence attempts | A successful pass means it returned; individual persistence failures remain in `routine.storage.write` |
| `routine.storage.write` | Each native routine repository write or complete transaction attempt | Includes SQLite busy timeout, admission and result persistence; excludes retained script execution |
| Process CPU | CPU seconds / elapsed wall seconds, sampled every 15 seconds | Self process only; excludes model CLI and shell children |
| Process memory | Current resident set, sampled every 15 seconds | Self process only; not maximum RSS or whole installation memory |
| Node event-loop delay | Lateness of a 100 ms timer | Distribution of timer delays; not a Rust metric or a request latency |
| SQLite busy retries | Busy attempts in execution persistence | Scope does not include every SQLite operation in the web process |

For HTTP and web resources, concurrency is in-flight non-streaming HTTP requests. For the Rust daemon it is
open control connections; for the application runtime it is active admitted script routines
(sampled before a command/pass, with at most four slots). Execution and terminal hosts each represent one invocation.
These load definitions differ by component: compare like components. Provider response time is
not labeled as Rust execution time. If an operation moves into Rust while the web caller remains
Node, its end-to-end web metric remains Node; add a native observation at the moved boundary.

Both Rust processes retain bounded cumulative snapshots locally. The web exporter establishes a
baseline on attachment and converts subsequent snapshots to deltas using each native owner's own
release. A web restart never replays retained counters. Missing telemetry on an older native owner
means unavailable native measurements, not zero use or inferred Node measurements.

## Compare migration stages

Generate the Grafana provisioning artifact with:

```sh
node scripts/generate-telemetry-dashboard.mjs > /tmp/palmagent-migration.json
```

The **Palmagent migration performance** dashboard requires the Prometheus data source UID
`palmagent-prometheus` for the 180-day store. The **Retention store** selector can
also use the separate legacy seven-day data source (`palmagent-prometheus-legacy`).
History starts when each store first receives data; enabling longer retention does
not create earlier observations. Narrow the component/release/time selection if a
long-range query exceeds the collector's bounded query budget. Select one component, operation, outcome, OS, architecture, and load
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
The daemon retains at most 32 native streams and the application runtime at most 128; both
reset their epochs every ten minutes. Web attachment establishes separate baselines for each
owner, so a web outage or restart can lose samples and never replays retained history.
Receiver outages and process restarts can lose measurements. Monitor collector rejection and
capacity panels before interpreting a change in observed sample volume as a product change.

### Script-runtime migration boundary

The first native application slice moves script routines while retaining the public Node
HTTP adapter and Node invocation hosts. Existing HTTP metrics remain end-to-end web
measurements and retain their Node label. The application service exports its own CPU, resident memory, command, queue, polling and
SQLite write observations as `service.name=palmagent.application`, `runtime.implementation=rust`.
The web transports these bounded snapshots using the existing consent and upload controls.
It polls a dedicated private `/telemetry` endpoint every 15 seconds; ordinary application
health checks do not serialize histograms. Consent and resource sampling run independently
of the serialized routine owner.
Local collection continues while the web is down; network export requires the web exporter.
Daemon metrics remain limited to the daemon process.
Compare the same routine workload across releases, and measure the total participating
processes when assessing resource savings. Do not infer a Rust speedup from daemon graphs.

The loopback benchmark also accepts `--scenario routines` and checks the routine count
throughout each run. Routine lists retain their SQLite read projection in the web; native ownership applies
to writes, scheduling and completion persistence. This is a useful regression measure
for the retained read path, but it does not measure
provider execution or prove that script commands themselves became faster.

### Receiver compatibility

Deploy the additive `palmagent.application` service and `routine.*` operation allowlist from
`packages/shared/src/telemetry-contract.json` to the receiver before rolling out an instrumented
application. Histogram boundaries, units, consent and retention are unchanged. Keep existing
service/operation entries so retained releases remain accepted. Update the generated dashboard's
component selector as well. Verify a synthetic native batch separately from production observations;
receiver acceptance does not prove the new application version is installed or actively exporting.
