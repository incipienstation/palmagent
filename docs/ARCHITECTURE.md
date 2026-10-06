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

## Design references

- [Ports and Adapters, Alistair Cockburn](https://alistair.cockburn.us/hexagonal-architecture)
- [Component + Strategy, Alistair Cockburn](https://alistaircockburn.com/Component%20plus%20strategy.pdf)
- [AWS project structure guidance](https://docs.aws.amazon.com/prescriptive-guidance/latest/hexagonal-architectures/best-practices.html)
- [Domain-Driven Hexagon: folder structure](https://github.com/Sairyss/domain-driven-hexagon#folder-and-file-structure)
- [Composition Root, Mark Seemann](https://blog.ploeh.dk/2011/07/28/CompositionRoot/)
