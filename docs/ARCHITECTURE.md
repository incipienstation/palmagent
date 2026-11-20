# Backend architecture

Palmagent organizes backend code by feature and uses ports and adapters at external
technology boundaries. Feature modules are code ownership boundaries, not separate
packages or deployment units. Their internal structure follows the same rules.

## Layout and ownership

```text
apps/server/src/
  modules/
    tasks/          # Task state, message queues, session ownership, history, attachments
    spaces/         # Space registration, discovery, validation and preferences
    routines/       # Scheduling policy and routine execution history
    terminals/      # Terminal admission, recovery and worktree retention
    auth/           # Authentication, enrollment and login sessions
    agents/         # Provider execution, recovery, models, skills, limits and voice
    telemetry/      # Optional performance sharing, preferences and bounded metric export
    installation/   # Installation, updates, compatibility and host settings
  platform/         # Reusable external technology support
  kernel/           # Small, technology-neutral contracts shared by features
  composition/      # Runtime assembly, implementation selection and resource ownership
  bootstrap/        # Executable entrypoints
```

A feature uses the following structure as needed:

```text
modules/<feature>/
  api.ts
  domain/
  application/
    ports/
      inbound/
      outbound/
    use-cases/
  adapters/
    inbound/
    outbound/
```

Do not create empty directories, one class per operation, or generic DDD base classes
to fill this template. A small use case can be an ordinary TypeScript function. Add
more files when the behavior warrants them. Messages and native session ownership
remain part of Tasks until there is evidence for a separate ownership boundary.

## Contracts and dependency direction

Inbound ports describe what the application provides. Inbound adapters translate
HTTP, CLI, local socket or scheduler input into calls to those ports. Use cases
implement the inbound contracts.

Outbound ports describe capabilities the application needs. Outbound adapters
implement those contracts using SQLite, files, provider processes or external APIs.
Both kinds of port belong to the application; neither imports an adapter class.

The source dependency direction is `adapters -> application -> domain`. Application
code uses outbound contracts rather than importing their implementations. Domain
code expresses state and product policy without performing I/O. Supply the facts
needed for a decision, including the current time when relevant, as values.
Deterministic utilities do not automatically belong to the domain: decoding a
provider's CLI output is adapter work even if the decoder performs no I/O.

Feature consumers use public contracts exported by `api.ts`, not another feature's
service, repository or adapter implementation. `api.ts` re-exports selected inbound
contracts and neutral types; it does not duplicate them or export every internal
file. Keep module dependencies acyclic. Compatible public APIs can be connected
directly; do not introduce a bus or adapter for every internal call.

`packages/shared` continues to own cross-tier models and wire contracts. Reuse
neutral models where appropriate without copying identical types. HTTP request
objects, cookies, SSE framing and database handles do not belong in core contracts.

## Common technology and composition

`platform` holds common HTTP parsing, database connections, migrations, private file
operations, process transport and IPC machinery. Feature-specific SQL and provider
behavior belong to their feature's outbound adapters. Sharing a SQLite connection
does not grant a feature unrestricted access to another feature's repository.

Composition selects implementations, connects features and owns resource lifetime.
Each executable assembles only the resources it needs. Server, CLI, execution hosts
and terminal hosts keep their distinct operational lifecycles. An optional
`modules/<feature>/composition.ts` may assemble that feature as a helper; it does
not start a second independent composition root. Core code and adapters never
import composition or retrieve services from a global container.

Bootstrap handles process arguments and signals and invokes runtime assembly.
Importing application modules must not start listeners, timers or subprocesses.
Construction, startup and shutdown are explicit. Keep packaged executable names
stable when changing source paths.

## Persistence and verification

Repository separation must preserve shared connection and transaction semantics.
Task, message, attachment and event changes that are atomic today remain atomic.
Recovery and PR association policy are explicit application/domain behavior;
persistence adapters preserve the resulting records and read projections.

Test core behavior with memory repositories and fake execution ports. Test concrete
adapters against their port contracts, including failures, ordering and atomicity.
Retain integration coverage for runtime assembly, HTTP, process ownership and
restart recovery. Keep tests under `tests/modules`, `tests/contracts`,
`tests/integration`, `tests/architecture` and `tests/support` as appropriate.

Architecture checks must cover layer dependencies, access to module internals and
cycles. Check type imports and re-exports as well as runtime imports. Unknown source
locations must not silently escape classification. Folder placement alone is not
evidence that a boundary is respected.

## Task execution and recovery

`MessagePolicy` owns queue and delivery decisions. `TaskExecution` owns execution admission,
reserved capacity, active handles, replay baselines, and terminal evidence. `TaskService` applies
persisted task effects and coordinates queue advancement after execution ownership is released.
A discarded reservation releases only its capacity; late callbacks cannot affect a newer turn
for the same task. View shutdown leaves retained executions and their durable receipts intact.

`recoverTaskExecutions` reattaches known executions before resetting orphaned tasks, then
reconciles message queues using the same retained-task set. Shared sessions keep their separate
connection recovery. Independent execution identity or connectivity uncertainty stops recovery
rather than resetting a task or resending a message. Recovery timestamps and queue scheduling use
the clock supplied by composition.

The daemon's historical `web` host now retains the API and Task owner. `server.js` holds a
process-lifetime lock before opening the database, owns API/SSE/WebSocket listeners and local
control, and launches `view.js` for PWA files only. The private view socket is never an API route;
static requests are streamed through the owner. View restart or recovery cannot instantiate a
second TaskService or stop admission. The child's IPC lease ends it when the owner exits.
During compatible full updates a temporary gateway can accept authenticated, idempotent Task
submissions into a separate SQLite inbox while the owner and view restart. The gateway has
read-only access to login sessions. Only the locked Task owner drains commands through existing
Task use cases and commits delivery decisions. Selected Rust read routes keep their read-only
boundary. See [Task owner and web view](TASK_RUNTIME.md) for lifecycle,
compatibility, verification and limits, and the [boundary experiment](performance/task-runtime/README.md)
for the original measurements.

## Design references

- [Ports and Adapters, Alistair Cockburn](https://alistair.cockburn.us/hexagonal-architecture)
- [Component + Strategy, Alistair Cockburn](https://alistaircockburn.com/Component%20plus%20strategy.pdf)
- [AWS project structure guidance](https://docs.aws.amazon.com/prescriptive-guidance/latest/hexagonal-architectures/best-practices.html)
- [Domain-Driven Hexagon: folder structure](https://github.com/Sairyss/domain-driven-hexagon#folder-and-file-structure)
- [Composition Root, Mark Seemann](https://blog.ploeh.dk/2011/07/28/CompositionRoot/)

## Native application modules

`apps/palmagent-runtime` follows the same dependency direction. Its initial routines module
uses `domain.rs` for pure policy and `application.rs` for use cases and outbound traits;
Axum HTTP, SQLite, local calendar conversion and retained-host adapters live under
`adapters/inbound` and `adapters/outbound`. `composition.rs` serializes admissions and
coordinates bounded adapter workers; `main.rs` owns startup and shutdown. Shared private
filesystem and process transport live in `platform.rs`. Native aggregate telemetry is shared
by the daemon and application through `packages/native-telemetry`; application adapters use
`platform/telemetry.rs`. Core routine policy does not import the collector or host timing APIs.

Retained script invocations use the same binary in `routine-host` mode. The
`application/retained.rs` use case owns one-shot admission and completion persistence policy;
its file adapter preserves the existing claim, stop, and result protocol. The platform process
adapter runs a native watchdog with a pipe lease and a separate process group. The host stays
independent of the scheduling process, and the daemon guardian retains cgroup cleanup ownership.
The retained release's `routineHost: 1` capability selects this host; releases without it keep
their Node host. The Node entrypoint remains packaged for older daemon compatibility.

`pnpm architecture:check` also runs the Rust syntax-tree boundary check, including imports,
qualified paths, unknown source placement and cycles. Rust has an explicit wire projection
of the TypeScript contracts; calendar vectors and real-process server contracts check parity
at that boundary. Product database migrations remain owned by the retained TypeScript API bootstrap.

### Rust feature boundaries

The native boundary checker classifies every source file, including `mod.rs`, by feature
and layer. New features use `modules/<feature>/{domain,application,adapters}` with Rust's
normal file or directory modules. A feature's optional `api.rs` only re-exports neutral
domain types and application contracts. Other features enter through that API; domain
code and platform utilities do not depend on another feature. Source and feature graphs
must both remain acyclic. Assembly `mod.rs` files only declare modules; executable wiring
belongs to composition. Application errors express outcomes; inbound adapters map those
outcomes to HTTP status codes.

The syntax-tree checks cover imports, re-exports, aliases at their import sites, qualified
paths, inline module scopes, and explicit paths in macro input. Alternate `#[path]` modules
and `include!` are rejected in production source. Direct Cargo dependencies (including
renamed crates) are checked against a small core allowlist, so new dependencies require
review before core code can use them. These checks are not Rust name resolution or macro
expansion: review generated code, macro implementations and newly introduced technology
dependencies explicitly. Existing native routine JSON projections remain a
compatibility boundary, not permission to introduce HTTP or database handles into core APIs.

Follow the [Rust migration gates](RUST-MIGRATION.md) for each ownership transfer.

The native Tasks module owns usage aggregation on daemon-backed installations. Its domain
folds normalized observations; its application owns the read port and revision cache; its
SQLite adapter decodes provider payloads and streams a single committed snapshot over a
read-only connection. The inbound adapter bounds admitted work before dispatching it to
blocking workers. Authentication and the public `/api/usage` route remain in TypeScript,
which selects the native reader during composition and awaits it through an outbound port.
Source and legacy configurations retain their local reader. No native Task writer or second
queue owner is introduced.

Historical activity expansion follows the same composition-selected read boundary. Its application
contract describes an ordered tool-event snapshot and inclusive range; the SQLite adapter reads
cursor and rows in one transaction on a separate read-only connection. The inbound adapter retains
opaque provider JSON while constructing the shared activity response. Bounded blocking workers
perform reads and serialization outside the async executor. TypeScript retains authentication,
task validation, JSON wire semantics and the public history-detail route; event writes remain
with the existing owner.

Transcript page and incremental-change reads use a separate application port. The Task owner first
refreshes the durable display projection through its existing persistence port, then invokes the
composition-selected native reader. The Rust domain applies page/byte limits and continuation policy;
its repository supplies one committed head-and-row snapshot, while adapters own SQL, canonical wire
byte accounting, and serialization. Projection schema upgrades, dirty-event repair and all writes
remain in TypeScript. Incompatible stored projection versions fail closed. Operation details, content reads
and execution recovery keep their current ownership.

The same native transcript port serves operation-list reads. Its SQLite adapter decodes only
operation summaries from the versioned parent projection and removes internal member references;
the domain orders and pages those summaries. The application distinguishes a missing parent from
an unavailable read, and HTTP adapters preserve the public 404/503 mapping. TypeScript still commits
projection refresh before invoking the reader and owns operation details, content and execution.

The opt-in direct-read experiment adds a Rust auth read use case with a read-only session adapter.
Its public HTTP middleware checks the same expiry and revocation state as the Node login owner.
The Tasks public adapter validates existing request contracts, checks task existence through a
read port, and uses the existing native readers without a Node callback. Composition owns the
separate loopback listener and its private configuration endpoint. The public listener never
mounts private application control routes. A strict projection repository rejects dirty snapshots;
Node repairs retained dirtiness before enabling it and continues publishing event batches and
projections in one transaction. The ingress sends all unselected routes directly to Node, preserving
the comparison boundary. See [direct-read experiment](performance/direct-task-reads/README.md).
