# Task admission across a web restart

Retaining the TypeScript Task owner lets accepted follow-up messages advance while the view
is absent. Accepting new messages also requires an API route that stays available. Keeping
only provider execution hosts alive already preserves active work and reserved executions,
but does not preserve the Task message pump or HTTP admission.

This is a bounded process-boundary experiment, not an installed runtime migration. It adds
no product process, dependency, database migration, ingress configuration, or CLI contract.
The retained candidate runs the **whole existing API server**, not a minimal Task service.

## What was compared

All layouts run the same server source, real HTTP middleware, TaskService, SQLite repositories,
and independent execution hosts. Only the external Codex/Claude CLIs are deterministic fixtures.
A common fixture ingress exposes the same URL shape in every layout.

| Layout | Process stopped | Task owner during outage | API route during outage |
| --- | --- | --- | --- |
| Coupled | Existing API/view server | Absent | Unavailable |
| Retained, web-gated | Synthetic view proxy | Existing API server remains | Passes through the absent view |
| Retained, stable API | Synthetic view proxy | Existing API server remains | Goes directly to the retained API |

The synthetic view serves a placeholder and proxies HTTP. It is not the PWA, a new product
HTTP server, or a proposed production proxy. The common ingress belongs to the measurement
driver. This arrangement isolates ownership and routing without reimplementing Task policy.

Each sample uses a new temporary repository, database, session cookies, provider homes,
control directory, and process groups. Child environments are built from scratch. The fixture
launcher substitutes for systemd execution launch; it never calls the host's sudo or service
manager. No live provider account, transcript, installation, or application database is used.

## Workload and assertions

1. Start two held turns: Task A with Codex and Task B with Claude. Wait for both fixture
   readiness and persisted running state. Capacity is two.
2. Queue follow-up D on A. Create Task C, which reserves an independent execution and waits
   for capacity. Record RSS at this same workload point in each layout.
3. Kill the layout's view process group, verify that A and B's original provider processes
   survived, then release A. Keep the view absent for eight seconds.
4. Submit follow-up E through the common ingress during the outage. Observe when C and D
   start, and which turns finish while the view is absent.
5. Restart the view and submit the identical E request again. Check FIFO output, exactly one
   terminal result per turn, preserved A session identity, and the original B process still
   running. Finish B and verify recovered idle states.

Missing and expired cookies return 401; a write from a different Origin returns 403.
These checks run before and after each outage, and during the stable-API outage. Authentication
uses seeded synthetic sessions with the real middleware. It does not exercise TLS, browser
cookie policy, passkey enrollment, or a real login ceremony.

## Reproduce

Use Linux, the exact Node version in `.nvmrc`, and a frozen dependency installation. From the
repository root, choose a fresh output path:

```sh
pnpm install --frozen-lockfile
node --import tsx apps/server/tests/support/task-runtime/run.mjs \
  --rounds 3 --outage-ms 8000 --out /tmp/task-runtime-results.json
```

The [runner](../../../apps/server/tests/support/task-runtime/run.mjs) rotates layout order on
each round. It writes sanitized samples with source/tree identities, fixture hashes, Node and
platform metadata, load averages, timestamps, assertions, and measurement definitions. Existing
result files are never overwritten. Successful fixtures are removed; failures retain private
logs in a temporary directory and print its location. No private logs belong in a commit.

The runner is manual, outside the automatic `*.test.*` contract suite. Its assertions are the
behavioral check for this experiment; the ordinary repository verifier remains a separate gate.

## Measurements

Measured 2026-11-14 on `b319b403`, Node v24.21.0, Linux arm64, 4 logical CPUs. All nine samples passed every behavioral assertion.

These are measurements of the recorded snapshot. The delivery branch subsequently incorporated
API telemetry changes and a release-version bump; the table is not a new benchmark of that head.

| Layout | Reserved C completes while view absent | Queued D completes while view absent | New E admission / completion while absent |
| --- | --- | --- | --- |
| Coupled | 3/3 | 0/3 | 503 / 0/3 |
| Retained, web-gated | 3/3 | 3/3 | 503 / 0/3 |
| Retained, stable API | 3/3 | 3/3 | 202 / 3/3 |

All samples preserved the held Claude process and Codex session, replayed no duplicate turn,
kept D before E, and recovered idle states. The view returned 503 during every outage.
Missing/expired cookies and wrong-Origin writes remained rejected, including all three
stable-API outages.

Medians of three samples per layout (milliseconds; RSS in MiB):

| Layout | Initial ready | Restart ready | Reserved C start | Follow-up D start | Owner RSS | Extra view RSS | Execution RSS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| coupled | 2836.4 | 2641.0 | 1110.3 | 11564.1 | 139.8 | 0.0 | 273.2 |
| retained-web-gated | 2229.6 | 191.5 | 1116.0 | 2788.0 | 139.0 | 59.2 | 270.8 |
| retained-stable-api | 2389.1 | 159.8 | 1101.8 | 2311.3 | 140.1 | 57.8 | 270.3 |

All samples, in execution order:

| Round | Layout | Initial ms | Restart ms | C start ms | D start ms | RSS owner / view / execution MiB | Processes owner / view / execution | Load 1 / 5 / 15 min |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- | --- |
| 1 | coupled | 2836.4 | 2948.4 | 1324.3 | 12066 | 139.8 / 0 / 273.3 | 1 / 0 / 4 | 12.6 / 13.6 / 13 |
| 1 | retained-web-gated | 3063.8 | 133.6 | 1116 | 2788 | 140.2 / 59.2 / 270.5 | 1 / 1 / 4 | 13.9 / 13.8 / 13.1 |
| 1 | retained-stable-api | 1541.4 | 159.8 | 1101.8 | 2311.3 | 140.1 / 57.8 / 270.3 | 1 / 1 / 4 | 12.8 / 13.6 / 13 |
| 2 | retained-web-gated | 1915.3 | 191.5 | 992.4 | 2402.4 | 139 / 59.2 / 270.8 | 1 / 1 / 4 | 11.3 / 13.2 / 12.9 |
| 2 | retained-stable-api | 2517.2 | 162.3 | 930.3 | 1946.2 | 138.3 / 57.7 / 269.4 | 1 / 1 / 4 | 11.2 / 13.1 / 12.9 |
| 2 | coupled | 1661.4 | 2641 | 928.6 | 11564.1 | 142.7 / 0 / 273.2 | 1 / 0 / 4 | 10.3 / 12.8 / 12.8 |
| 3 | retained-stable-api | 2389.1 | 150.2 | 1581.8 | 3720.6 | 143.1 / 57.9 / 270.3 | 1 / 1 / 4 | 11.2 / 12.8 / 12.8 |
| 3 | coupled | 2910.7 | 2565.9 | 1110.3 | 11177.4 | 138.7 / 0 / 272.9 | 1 / 0 / 4 | 12.9 / 13.1 / 12.9 |
| 3 | retained-web-gated | 2229.6 | 344.9 | 1530.4 | 3479.9 | 138.9 / 59.3 / 272.2 | 1 / 1 / 4 | 11.2 / 12.7 / 12.8 |

The measurements used the following identities. The source commit precedes this report and
contains no product changes from the experiment. Fixture hashes identify the measured uncommitted
runner inputs; report edits do not change them.

- Server source tree: `38a7fb5df1c3cb97e0137f845f78c5b8a4c62139`.
- `apps/server/tests/support/task-runtime/run.mjs`: `51237b5af4bcf4436fe9e30cec214917e4b44c4ec15ff9c91f9c0e0fe294131c`.
- `apps/server/tests/support/task-runtime/proxy.mjs`: `00f11746b5e81f84f55de15060270ece6cab22550d50d180dad3f8442769c575`.
- `apps/server/tests/support/lifecycle-cli.cjs`: `970bdd4422ecaa52db0932df8440112b9bad2e6f6d70162973409f48d67e33a8`.

Times are observations at 25 ms polling intervals, not exact internal transition timestamps.
Follow-up delay is measured from release of A after the view is confirmed absent to D's provider
ready marker. It includes execution admission and provider-process startup. The coupled delay
also includes the forced eight-second outage. Restart time measures spawning the stopped process
to API health; retained layouts restart only the small synthetic proxy. These are source-mode
Node/tsx results, not packaged-server or PWA startup measurements.

RSS is the sum across each owned process group, including helper/provider descendants. Shared
pages can be counted multiple times. The common driver and ingress are excluded in every layout.
An extra view proxy adds a process; retaining the full API does not demonstrate a memory saving.
Startup helpers and garbage collection can change process counts and RSS between samples.
The host is shared, caches are warm after the pilot, and layout order rotates. The sample count
is small; these results establish the continuity distinction, not a production latency SLO or
an idle-host performance ratio. CPU, sustained throughput, disk use, and maintenance cost were
not benchmarked.

## Decision and follow-up boundary

Use **TypeScript for the first retained Task-owner implementation**, if uninterrupted follow-up
processing during view restarts is adopted as a product requirement. The measured benefit comes
from ownership and routing. This experiment supplies no evidence that Go or Rust is necessary.
The earlier [language experiment PR](https://github.com/incipienstation/palmagent/pull/595) used a
small model-catalog projection with different build profiles and JSON compatibility gaps; its
results do not establish an application-runtime migration benefit.

The next production slice should retain one owner for Task state, message receipts, queue
advancement, and execution recovery. A replaceable view should use a stable authenticated API
route to that owner. Reuse current TypeScript policy and adapters first. Do not create a second
TaskService cache/writer in the view, or let the view and runtime mutate the same Task state
independently. Existing execution hosts remain separately owned.

Before production implementation, specify and validate:

- Daemon ownership, singleton startup, readiness, failure recovery, and local endpoint access.
- Which API operations remain in the owner, including dependencies on repositories, attachments,
  input requests, events, and execution control. A minimal Task-only service is not measured here.
- Stable routing for HTTP, event streams and WebSockets; browser reconnect and deployment behavior.
- Compatibility between independently running view/owner versions and retained execution hosts;
  activation, rollback, schema changes, and old-owner retirement.
- The maintenance boundary: this probe kills only a view, without activating an update. Existing
  update maintenance may still reject admission even with a stable endpoint. Full application
  updates and owner restarts require their own continuity/recovery contract.
- Preservation of FIFO, edit locks, durable request-ID deduplication, and `unknown` provider
  delivery. HTTP submission retry must never become an automatic uncertain-provider resend.

Keep the current single-server topology until that bounded production design is agreed. There
is no measured operational frequency or user impact here that establishes urgency. Already
running work survives today; the incremental benefit is advancing follow-ups and admitting
new messages during a view outage. The extra ownership, compatibility, and deployment work
must be justified by that requirement rather than by a language preference.
