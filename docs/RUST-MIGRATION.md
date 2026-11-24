# Rust backend migration

Rust is the target for incremental native backend migration. Each change moves a working
behavior through the same feature, application, domain and adapter boundaries used by the
TypeScript backend. The PWA and cross-tier contracts remain TypeScript. Language choice
alone does not establish a performance improvement.

## Current ownership

| Behavior | Authoritative owner | Boundary that remains |
| --- | --- | --- |
| Host supervision, retained processes and activation | Rust daemon | Existing installation and update protocols |
| Agent and script routine definitions, cadence, admission and history on daemon installations | Rust application runtime | The ready API coordinator delivers agent runs through Tasks and serves the committed read projection |
| Retained script execution and completion | Rust routine host | Older releases may still use the packaged Node host |
| Task usage aggregation on daemon-backed installations | Rust Task read use case | TypeScript authentication and HTTP response |
| Historical Task activity-detail expansion on daemon-backed installations | Rust Task activity read use case | TypeScript authentication, task/range validation and public response; legacy/source setups keep their local reader |
| Transcript pages and incremental changes on daemon-backed installations | Rust Task transcript read use case | TypeScript schema bootstrap, repair, authentication and public response |
| Transcript activity operation lists on daemon-backed installations | Rust Task transcript read use case | TypeScript authentication, shared display contract and public response |
| Task message transitions, retained dispatch and restart recovery on daemon installations | Rust Tasks worker under the API coordinator lease | TypeScript HTTP, provider adapters, source and legacy configurations |
| Task creation, control actions, provider events and projection writes on daemon installations | Rust Tasks worker | Provider handles, compatibility rendering and schema bootstrap in the API |
| Legacy history, execution records and expanded conversation content on daemon installations | Rust Tasks SQLite reader | Shared display serialization, UTF-16 content boundaries and public response |
| Space catalog writes and discovery matches, attachment index and push subscriptions on daemon installations | Rust worker | Space registration and removal preflight, catalog listing and path validation, file operations and network delivery in their existing adapters |
| Standalone release selection, file preparation and activation on capable installations | Rust update worker | CLI admission and host lock, shared wire schemas, plugin managers, daemon operations and update gateway |
| Remaining Space, authentication, terminal and installation use cases | TypeScript backend | Feature-specific ports and adapters |

This is an ownership inventory, not a claim that the backend is fully migrated. The first
harness change strengthens native architecture checks, gives routine commands an
application-owned inbound contract and public API, and moves HTTP error mapping out of
the core contract. Task usage is the first migrated Task use case: the native runtime reads
committed event totals through a read-only SQLite adapter, with snapshot-consistent revision
caching. The Tasks worker uses the existing product schema. Native startup requires the `taskUsage: 1` health capability,
and native read failures return an unavailable response rather than changing readers.
Rolling back to the prior release resumes its local reader against the unchanged schema.

Activity-detail expansion is also a native read use case. The retained
`GET /api/tasks/:id/history/details` route selects a read-only adapter through an application
port after authentication and task/range validation. The native reader captures the task cursor
and the inclusive tool-event range in one committed SQLite snapshot, preserves sequence ordering,
and clamps the response's `through` to that cursor. It does not paginate or truncate the requested
activity. Provider payloads remain opaque JSON until the TypeScript wire boundary, preserving
historical primitive payloads, duplicate keys, numeric overflow and escaped Unicode.

Startup requires the additive `taskActivityDetails: 1` health capability. Native read failures
return 503 without falling back to the local implementation. This includes corrupt persisted JSON,
which the local reader also rejects. The activity reader explicitly permits responses above the
private control transport's default 16 MiB cap because this public endpoint already returns full
activity payloads; other transport callers retain the cap. Two admitted native workers bound read
and serialization concurrency. This slice introduces no writer, schema, queue or execution change;
rollback resumes local reads. Expanded details and content use the Task record source and the shared display serializer.

Transcript page and change reads now select the native reader after the API owner commits any
pending projection refresh. That preparation remains a TypeScript write use case: it repairs
`conversation_rows` and `conversation_state` from dirty events and retains sole authority over
projection migrations. The Tasks worker commits ordinary projection writes. The read-only transcript repository
captures projection version, head and candidate rows in one transaction; domain policy applies
the existing 30-item/256 KiB budgets, ordering, exclusive page cursor, inclusive change horizon,
tombstones and `(revision, key)` continuation. The repository supplies the byte costs of the
canonical JSON produced by the retained writer.

Startup requires `taskTranscript: 1`. Native reads also reject incompatible projection versions;
capability, version or read failures do not select a local fallback. Source and legacy configurations
retain their local reads, and rollback needs no schema or data conversion. Existing
`format=transcript` routes remain authenticated, validated and `no-store`; SSE still invalidates
history through the durable event cursor. A write arriving after refresh may leave the last committed
projection visible until the next read refreshes it, as with the existing local read path. This slice
moves selection, paging and serialization to Rust, while projection computation, JSON parsing and
public response encoding remain in TypeScript. It makes no performance claim.

Activity operation lists (`GET /api/tasks/:id/history/steps`) also use the native transcript port.
The owner refreshes the projection before reading. Rust reads the parent record and its revision
from one committed snapshot, strips the internal `members` field in its adapter, then applies the
existing key ordering, exclusive `after` cursor and 50-step page limit in domain code. Summary
fields remain opaque JSON through the native boundary, including escaped Unicode and additive
projection fields. Non-activity records have no steps; absent or tombstoned parents preserve the
existing 404 error. Incompatible projections, corrupt records and unavailable native reads fail
closed with 503. Startup requires `taskTranscriptSteps: 1`; no schema or writer changes are involved.
The Task record reader supplies operation details, content and execution records to the API serializer.

## Direct public read experiment

An opt-in same-origin ingress split sends the five migrated GET routes directly to a separate
Rust loopback listener. Rust owns cookie-session verification, public validation, task existence
checks and final response encoding for those requests. Node serves the default route and
owns authentication ceremonies and schema migrations. Production event
batches already publish events and projection updates atomically; startup repairs retained dirty
projections before enabling the direct listener. Direct reads reject dirty projections and never
call back to Node. Reader algorithms and admission limits are retained for controlled comparisons.

This listener advertises `taskReadHttp: 1` on the private runtime health boundary and is configured
through the private `/v1/task-reads/http` endpoint. `NATIVE_READ_HTTP_PORT` is disabled by default;
ingress routing is a separate explicit step. See the [experiment and rollback instructions](performance/direct-task-reads/README.md).
This adds a session-validation reader, not a second session or Task writer. An API-owner crash
can leave direct committed reads available; ordinary owner shutdown disables the listener.

The same listener can admit routine definition creation, updates and deletion with the separate
`NATIVE_ROUTINE_WRITES=1` opt-in and `routineWriteHttp: 1` capability. Ingress selects by method
and path. The public adapter sends the validated command directly to the existing Rust routine
owner. The API revision poll publishes changes to SSE clients. Manual run/stop and agent Task
delivery continue through Node. Reverting ingress selects the mediated path against the same owner.

## Gates for every slice

1. **Name the behavior and authority.** Identify the existing use case, observable contract,
   persisted records, transaction boundary and single writer. State exactly what remains
   in TypeScript. Do not run competing schedulers or writers during a transition.
2. **Keep the core portable.** Put policy and state transitions in domain code; put use cases
   and inbound/outbound contracts in application code. Inject time, identity, persistence,
   process execution and external APIs through ports. Keep HTTP, SQLite, filesystem and
   provider mechanics in adapters, with explicit startup and shutdown in composition.
3. **Preserve the boundary contract.** Reuse `packages/shared` wire definitions as the source
   of truth; verify native projections against representative existing contract vectors.
   Preserve invalid-input behavior, ordering, cancellation and ambiguous-delivery semantics.
   Extend existing tests where they already exercise the boundary.
4. **Transfer ownership with recovery.** Preserve atomic updates, durable admission and
   execution identity. Exercise interrupted startup, owner restart and pending completion
   where relevant. Rollback must select one compatible owner without replaying accepted
   work; incompatible retained state must fail closed. Product database migrations remain
   in the current bootstrap until their ownership is explicitly transferred.
5. **Pass the harness.** Run `pnpm architecture:check` and the scope selected by
   `node scripts/verify-local.mjs` with the pinned Node version. Native checks include format,
   Clippy and workspace tests; real-process contracts cover the native/TypeScript boundary.
   Architecture fixtures must demonstrate rejection of any newly supported bypass mechanism.
6. **Record the result.** Update this inventory when ownership changes. Distinguish local
   evidence, current-head CI, merge, publication and installed behavior. Compare performance
   only under matched workloads and settings using the existing telemetry dimensions.

## Tasks ownership

The installed Rust worker owns durable task state, message queue progression, retained
execution coordination, recovery, event batches and conversation projection writes. The public HTTP, SSE and local session contracts continue to use
the shared TypeScript definitions. The API and CLI can adapt those requests to the new
owner. Provider invocation, Space and worktree management, attachment files, and push
delivery are ports called by Tasks.

On daemon-backed installations the API coordinator passes its locked file description to
a release-matched Rust worker. The worker validates the lock inode before opening the
product database. Startup prepares the complete attachment list. The execution adapter
installs those handles synchronously, then Rust commits recovery before callbacks run.
Source and legacy configurations use their local implementation.

New retained turns persist the journal UUID in the queue before reserving the execution.
A journal from another turn fails attachment. Older queues use their existing retained
lookup. The worker owns queue transitions, dispatch admission, callback fencing and
metadata writes including shared-session control, pending input, approvals and pins.
Task creation can stage attachment rows and files under one native transaction. The same recovered
worker commits Space registration, base-branch changes and removal. The API resolves Git and
filesystem paths and looks up known paths before branch discovery or worker dispatch. The selected writer reuses
the first matching path (creation time, then row ID) or inserts the candidate under one SQLite
write transaction. Only an insertion publishes a registration change. The path index also
supports older catalogs with duplicate paths. Space discovery sends the scanned paths to the
worker in a single read, matching the last registration in creation order for each path. Manual
validation uses the first registration at the resolved path. Filesystem facts are cached separately
from those database reads, so catalog updates are visible even while a scan is cached. Reads and
older releases use the existing catalog schema, so rollback requires no conversion. Space
removal deletes archived tasks, events, approvals and dependent routines atomically.
A provider line commits its event, derived images, task and queue effects, projection and
raw cursor together. Successful compaction commits the queue receipt and display event
before notifying subscribers. Shared-session imports preserve source identities, prefix
hashes and the intermediate display revision for supplemental results.

The API owns provider and filesystem calls, maintenance preflight, in-memory UI state,
push delivery and shared display rendering. It passes external observations to the worker
and publishes committed state. Existing source and legacy deployments keep their local
adapters. Opening or upgrading a database still runs the schema bootstrap and repairs
historical dirty projections before the worker takes over.

The dispatch transition commits running status, the raw replay cursor reset and the
queue's runtime-started marker together. The execution adapter can then start the
provider for that run. If the owner dies after the commit, recovery must use retained
execution identity and receipt evidence to determine delivery. A missing receipt
alone cannot authorize a second invocation.

At cutover, close admission, stop the previous Tasks owner, acquire the same
`runtime.lock`, reconnect retained execution identities, and commit recovery before
opening admission. Keep provider callbacks buffered during recovery so replay cannot
start another run or publish partial state. A failed recovery keeps admission closed.
Do not configure native and TypeScript Tasks writers in the same installation.

Exercise the full sequence in a packaged installation with a retained turn and queued
messages, including process loss before and after dispatch, reconnect, and rollback to
the retained release. Rollback must preserve committed queue receipts, event cursors and
execution identities against a compatible SQLite schema. Agent routines deliver through the selected Tasks owner.

## Agent routines

On daemon installations the application runtime stores agent definitions and admits manual and
scheduled runs. Admission commits the next cadence, history row and immutable Task request in
one SQLite transaction. The request carries an isolated-worktree flag and a stable Task creation
ID. The API delivers it through ordinary Task admission and returns the Task ID or dispatch
error to the routine owner. Restarting the API can retry an unacknowledged request with the same
identity. A manual run preserves cadence. Users stop the resulting Task from its Task controls.

Script scheduling continues without the web process. Agent scheduling advances on a heartbeat
from the ready Tasks coordinator. On the first heartbeat after either owner starts, Rust records missed agent schedules as skipped
and resumes delivery of already admitted requests. Routine lists and history use the shared
committed read projection. Source installations retain their local scheduler.

The additive nullable dispatch column is ignored by earlier releases. After rollback they can
read the original cadence and history and schedule future runs. An unacknowledged admission
keeps its pending note and resumes with its original identity if the native agent owner returns.

Keep the Node implementation that is required for older retained releases or rollback until
compatibility evidence permits its removal. Do not widen an exception in the architecture
checker to make a migration pass; change the dependency direction or document a narrowly
reviewed boundary instead.

## Standalone updates

An installed package advertising `standaloneUpdate: 1` uses its release-matched runtime
to select the signed release, prepare its files and drive the update through activation
and recovery. The CLI holds the installation lock and serves host operations to the
worker, including plugin management, provisioning, gateway lifetime and receipt writes.
The daemon retains the update host independently of the web process. Interrupted handoffs
keep the pinned release pair and request identity in the existing activation receipt.
A storage-incompatible target requires explicit recovery if activation fails.

A fresh release retains its signed-manifest-verified compressed archive alongside the
bundle. On retry the worker authenticates the archive again, compares files and modes
and rejects extra entries before running any candidate code. An older retained release
gains the archive after comparison with a fresh download. The cache belongs to the
release directory and follows the same retention lifecycle. Stage timings are emitted
in the update host log in milliseconds. Source, npm and previous releases retain their
existing paths. The first update from a previous package runs that package’s updater.
