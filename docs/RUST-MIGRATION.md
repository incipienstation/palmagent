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
| Task API, queue, agent execution coordination and recovery | TypeScript API owner | Separate PWA view process; retained execution hosts |
| Agent routines, spaces, auth, terminals and installation use cases | TypeScript backend | Feature-specific ports and adapters |

This is an ownership inventory, not a claim that the backend is fully migrated. The first
harness change strengthens native architecture checks, gives routine commands an
application-owned inbound contract and public API, and moves HTTP error mapping out of
the core contract. It does not transfer Task ownership or change the storage schema.

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

Select the next slice from observed ownership and coupling, not file count. First define
Task inbound and outbound contracts that can preserve the existing API owner's queue,
transactions and recovery behavior. Migrate a complete bounded use case and validate it
through the retained API boundary before transferring Task scheduling or execution authority.
Agent routines depend on Task admission and must not gain an independent Task writer.
Move other feature use cases only after their persistence and recovery contracts are explicit.

Keep the Node implementation that is required for older retained releases or rollback until
compatibility evidence permits its removal. Do not widen an exception in the architecture
checker to make a migration pass; change the dependency direction or document a narrowly
reviewed boundary instead.
