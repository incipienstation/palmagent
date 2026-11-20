# Rust backend migration

Rust is the target for incremental native backend migration. Each change moves a working
behavior through the same feature, application, domain and adapter boundaries used by the
TypeScript backend. The PWA and cross-tier contracts remain TypeScript. Language choice
alone does not establish a performance improvement.

## Current ownership

| Behavior | Authoritative owner | Boundary that remains |
| --- | --- | --- |
| Host supervision, retained processes and activation | Rust daemon | Existing installation and update protocols |
| Script routine scheduling, admission and persistence | Rust application runtime | TypeScript API/read projection and product database bootstrap |
| Retained script execution and completion | Rust routine host | Older releases may still use the packaged Node host |
| Task usage aggregation on daemon-backed installations | Rust Task read use case | TypeScript authentication, HTTP response contract and event writes; legacy/source setups keep their local reader |
| Historical Task activity-detail expansion on daemon-backed installations | Rust Task activity read use case | TypeScript authentication, task/range validation and public response; legacy/source setups keep their local reader |
| Transcript pages and incremental changes on daemon-backed installations | Rust Task transcript read use case | TypeScript projection refresh and writes, authentication, task validation and public response |
| Transcript activity operation lists on daemon-backed installations | Rust Task transcript read use case | TypeScript projection refresh, authentication and public response; operation details and content remain local |
| Task message transitions, retained dispatch and restart recovery on daemon installations | Rust Tasks worker under the API coordinator lease | TypeScript HTTP, provider adapters, source and legacy configurations |
| Task creation, event persistence and conversation projection | TypeScript API owner | Retained execution hosts and native committed reads |
| Agent routines, spaces, auth, terminals and installation use cases | TypeScript backend | Feature-specific ports and adapters |

This is an ownership inventory, not a claim that the backend is fully migrated. The first
harness change strengthens native architecture checks, gives routine commands an
application-owned inbound contract and public API, and moves HTTP error mapping out of
the core contract. Task usage is the first migrated Task use case: the native runtime reads
committed event totals through a read-only SQLite adapter, with snapshot-consistent revision
caching. Task scheduling, execution and database write ownership remain in TypeScript;
there is no schema change. Native startup requires the `taskUsage: 1` health capability,
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
rollback resumes local reads. Step details and content-chunk APIs remain in TypeScript. Native
read/serialization moves out of the API owner, but JSON parsing and public response encoding remain there; this is not a measured performance improvement.

Transcript page and change reads now select the native reader after the API owner commits any
pending projection refresh. That preparation remains a TypeScript write use case: it repairs
`conversation_rows` and `conversation_state` from dirty events and retains sole authority over
projection migrations. Rust never refreshes or writes the projection. Its read-only repository
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
Operation-detail expansion, content chunks and execution-record reads remain in TypeScript.

## Direct public read experiment

An opt-in same-origin ingress split sends the five migrated GET routes directly to a separate
Rust loopback listener. Rust owns cookie-session verification, public validation, task existence
checks and final response encoding for those requests. Node still serves all other routes and
remains the sole authentication-ceremony, event, projection and schema writer. Production event
batches already publish events and projection updates atomically; startup repairs retained dirty
projections before enabling the direct listener. Direct reads reject dirty projections and never
call back to Node. Reader algorithms and admission limits are retained for controlled comparisons.

This listener advertises `taskReadHttp: 1` on the private runtime health boundary and is configured
through the private `/v1/task-reads/http` endpoint. `NATIVE_READ_HTTP_PORT` is disabled by default;
ingress routing is a separate explicit step. See the [experiment and rollback instructions](performance/direct-task-reads/README.md).
This adds a session-validation reader, not a second session or Task writer. An API-owner crash
can leave direct committed reads available; ordinary owner shutdown disables the listener.

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

## Following slices

The Tasks migration transfers the domain as a unit. Rust will own task state, message
admission and queue progression, execution coordination, recovery, event writes, and the
conversation projection. The public HTTP, SSE and local session contracts continue to use
the shared TypeScript definitions. The API and CLI can adapt those requests to the new
owner. Provider invocation, Space and worktree management, attachment files, and push
delivery are ports called by Tasks.

| Boundary | Before the ownership switch | Evidence required for the switch |
| --- | --- | --- |
| Task lifecycle and metadata | Port creation receipts, status transitions, task actions, settings and pin order. | Task creation retries return the same task. Status, activity timestamps and event order match across the existing HTTP and local session APIs. |
| Queue and execution | Port queue state and effects for admission, delivery, editing, approval, answers, stop and completion. Reuse the retained execution protocol. | A committed claim precedes execution. Stale callbacks cannot affect a newer run. Lost provider receipts remain unconfirmed through restart. |
| Session ownership | Port shared/local/native session transitions, import cursors and provider identity checks. | Shared and retained turns reconnect, and a missing or inconsistent identity fails closed. |
| Events and records | Transfer event batches, replay cursors, projection writes and the remaining detailed and legacy reads. | A reader sees a committed event batch and its projection together. History stays compatible across pagination, large output, replay and rollback. |
| Cross-domain routes | Route routine dispatch, Space removal, worktree cleanup, attachments, push and subscriptions through the selected owner. | Every write path uses that owner, including paths that do not originate from the browser. |

On daemon-backed installations the API coordinator passes its locked file description to
a release-matched Rust worker. The worker validates the lock inode before opening the
product database. Startup prepares the complete attachment list. The execution adapter
installs those handles synchronously, then Rust commits recovery before callbacks run.
Source and legacy configurations use their local implementation.

New retained turns persist the journal UUID in the queue before reserving the execution.
A journal from another turn fails attachment. Older queues use their existing retained
lookup. The worker owns queue transitions, dispatch admission, callback fencing and
metadata writes including shared-session control, pending input, approvals and pins.
When completion also writes a conversation event, the API commits the Rust queue
transition with that event in the existing SQLite transaction. Ordinary event batches, shared-session imports, display rows, raw cursors and activity
timestamps commit in a single native transaction. The coordinator renders the display
operations against the prior committed snapshot. Task insertion and the attachment index
share a native transaction while the file adapter stages blobs. The coordinator still
handles compound completion, projection repairs and detailed reads.

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
execution identities against a compatible SQLite schema. Agent routines depend on Task
admission and must use the selected owner.

Keep the Node implementation that is required for older retained releases or rollback until
compatibility evidence permits its removal. Do not widen an exception in the architecture
checker to make a migration pass; change the dependency direction or document a narrowly
reviewed boundary instead.
