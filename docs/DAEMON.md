# Native runtime supervisor

New Linux package installations use the bundled Rust `palmagentd` and
`palmagent-runtime` application service. The web server,
provider adapters, execution journals, terminal hosts and update policy remain in
TypeScript. Nx runs the Rust build and checks alongside the existing projects.

## Ownership and platform boundary

`palmagentd` owns host reservations, process identity, launch, inspection, cleanup,
web recovery and update executor launch. Each execution, terminal, routine script, web process and
updater has an independent guardian from its retained release. Guardians own their
Node child, output pipes and bounded log files. Replacing or crashing the control
daemon does not replace those guardians or their provider input channels.

The Linux adapter implements PID/start-time/boot identity, pidfd signaling, private
Unix IPC, locking and delegated cgroup v2 isolation. Execution, terminal and routine groups
have separate aggregate memory, CPU and task limits. Cancellation cleans up the
whole group, including descendants that create a new session. Process-group mode
exists for development tests and does not offer the same containment guarantee.
These are OS adapter boundaries; macOS and Windows implementations are not included.

Systemd is only the Linux boot/crash-recovery adapter for new installations. A
user service named `palmagentd-<data-directory-hash>.service` launches a stable
user-owned `daemon/current` executable link and delegates CPU, memory and PID controllers. It requires
systemd 254+ (`DelegateSubgroup=control`), cgroup v2 with writable `cgroup.kill`,
and an accessible systemd user manager. The control subgroup lets systemd restart
the daemon while other groups remain populated. Account lingering keeps the user
manager running after logout and starts it at boot, without a login session.

Installation enables linger with `loginctl --no-ask-password enable-linger` when
needed, verifies the manager's version and unit search path, then exercises the
native isolation operations inside a disposable delegated user service. A denied
linger policy or unavailable delegation stops installation without falling back
to sudo or weaker isolation. A host administrator must resolve those prerequisites.
Registration, removal, execution, settings and updates need no sudo on this path.
Host packages, reverse proxies and TLS remain separate operator responsibilities.

`DAEMON_SCOPE=user` and `DAEMON_UNIT_DIR` persist the service selection in
`install.env`. Unit names derive from the absolute data directory; repeated installs
use setup for the existing installation. Commands always address the installation
owner's standard user-manager bus, even from a shell with a private session bus.
The CLI implements explicit checks and failure paths for a given package, inputs
and host state; external permissions and service availability can still make a
run fail. Uninstall preserves account lingering because other user services may
rely on it.

## Readiness and recovery

New packages advertise `hostReadiness: 1` in the daemon artifact manifest. Their Node
hosts publish a private readiness marker bound to PID, process start time and boot
identity. Web reports ready after its listeners start; terminal after PTY and local
transport initialization; execution after its command handler is installed; routine
after its script controller is installed; updater after reading its durable request.
The marker capability is removed from the environment before spawning descendants.
Older retained packages remain supported and report readiness as `unsupported`.
A running process alone is not proof that its service is ready.

The existing `state`/`alive` fields remain compatible. Additive `lifecycle` metadata
reports `starting`, `ready`, `running` (legacy readiness unknown), `stopping`, `exited`
or `unknown`, together with supervision state, timestamps and a failure reason.
Launch requests wait up to 15 seconds for readiness when supported; a timeout does
not replay or cancel user work. An automatically recovering web host that has not
become ready within 30 seconds is stopped. Explicit web transitions finish their
bounded lifecycle operation before automatic recovery resumes.

Web failures back off for 2, 4, 8, 16, 32, then at most 60 seconds. Failure count and
retry deadline survive daemon replacement/restart. Thirty seconds of continuously
ready operation resets the count; legacy hosts use guarded process liveness for
that stability check. An explicit web restart can bypass a pending retry delay.
This is startup readiness, not an ongoing HTTP responsiveness watchdog.

The daemon incrementally reconciles host records. It acquires the guardian's lock
and verifies its recorded process identity has ended before changing ownership.
For an orphaned host in its own delegated cgroup, it terminates remaining descendants,
confirms the group is empty and records `guardian_lost`. Only the web is automatically
replaced; executions, terminals, routines and updater invocations are never replayed.
Unconfirmed reservations with no recorded guardian remain reserved. Development
process-group mode reports live orphans without automatically signaling stale groups.

## Inventory and retention

`palmagent daemon status` includes web recovery state and an inventory summary.
`palmagent daemon hosts --data-dir <data-dir>` returns up to 32 host records and a
`next` cursor; pass it as `--after <cursor>` to continue. These are incremental,
eventually consistent observations: `checkedAt` identifies the last completed scan
and `scanning` indicates work in progress. Full retained release paths remain in the
individual native `inspect` response; inventory never includes host environments.
Older daemons without inventory support must be updated before using `daemon hosts`.
Doctor warns about orphaned or uncertain ownership, inspection failures, restart
backoff and protected logs exceeding the cleanup target.

Each output file still rotates around 4 MiB. Completed-host logs expire after seven
days, or earlier, oldest first, when the daemon log directory exceeds a 64 MiB cleanup
target. Ownership and exit are rechecked before deletion. Active, uncertain, unrecognized
and supervisor logs are protected from this cleanup; protected data can exceed the
target and is reported, never deleted just to satisfy the target.
After seven days, confirmed completed host records are compacted: environment and
process details are removed, while identity, release references, exit metadata and
the terminal reservation remain. Reservation files and their locks are retained
indefinitely to prevent the same host ID from being launched again. This policy does
not delete execution journals, task history, worktrees, retained packages or Node runtimes.

## Updates and migration

Automatic update discovery, Stable/Preview selection, compatibility checks, receipts
and retry holds retain their existing behavior. The daemon starts an independent
updater, which stages an immutable package and pinned Node runtime. Activation
verifies daemon protocol and artifact hashes, writes private configuration and atomically
selects the native executable through `daemon/current`,
replaces the daemon with `exec` (preserving its bootstrap PID), verifies the new
build identity, and replaces the web process. Existing hosts keep their original
release. Daemon-managed routine scripts also keep their original release and process. Script scheduling,
admission and run history belong to the independent application service; the script host persists its result
independently and the application service records it without rerunning the command.
Timeouts and explicit cancellation still clean up the script and its descendants.
Source and legacy installations keep web-owned scripts, so activation still waits
for those scripts to finish and retains the pending update request.

App and CLI control requests use the private daemon socket directly, with bounded frames,
protocol validation and no automatic resend after unknown delivery. The supervisor bounds
concurrent connections and uses absolute read/write deadlines. Host readiness and shutdown
are polled while lifecycle mutations remain serialized; status checks and web recovery
continue during slow requests and waits for other hosts. An accepted operation continues
even if its caller disconnects.

A confirmed guardian spawn failure is recorded as an exited reservation. The same host ID
cannot be relaunched; web recovery can select a new ID after the underlying fault is repaired.
A successfully spawned guardian whose outcome is unknown retains its reservation and is never
automatically replayed.

Control requests do not execute a launcher. Existing `daemon/launcher` paths become
compatibility links for retained older
hosts and existing service units; new installations do not create them. The selected
release supplies any compatibility commands, so an old copied command parser cannot
block a new request. The startup command reads the authoritative configuration before
executing the daemon, including during an interrupted executable-link update.

Failed activation attempts restore the previous runtime configuration and executable selection and check
its health. Both releases and the activation receipt remain available; database
changes are not rolled back. An interrupted updater leaves its retry hold for
explicit recovery. A full machine reboot ends active processes.

Existing systemd execution installations and native system-service installations
keep their backend and scope during package updates. An absent `DAEMON_SCOPE`
means the legacy system scope; an update never silently migrates it.
`palmagent setup` migrates them only during verified idle maintenance: executions,
terminals and routine scripts must finish first. It retains previous configuration,
checks user-service prerequisites before stopping the old runtime, registers the
bootstrap, starts and checks the daemon, and removes obsolete system services
after success. This one-time cleanup needs sudo. A failed candidate restores the
previous configuration and startup registration and verifies recovery. A retained
`daemon-migration.json` records interrupted work; rerunning setup retries old-service
cleanup when the user runtime is healthy. If neither runtime is healthy, inspect
the receipt and journals before recovery. Source installations retain their current backend.

## Diagnostics and verification

`palmagent doctor` checks the selected supervisor. For daemon installations, inspect
`systemctl --user status <service-name>` and
`journalctl --user -u <service-name>` for user-bootstrap failures. Doctor reports
the service name, enabled/active state and lingering. Legacy system scope uses
`systemctl status palmagentd.service` and `journalctl -u palmagentd.service`. Host output lives in `<data-dir>/daemon/logs/`; private host
records and configuration live beside it. Do not publish those files or delete
retained releases referenced by live hosts. Stopping the bootstrap alone stops
the control plane; use the CLI uninstall flow for verified idle shutdown.

Maintainers need rustup and the pinned `rust-toolchain.toml` toolchain. End users
receive Linux x64 and arm64 static native binaries in the existing npm package.
`pnpm daemon:check` runs formatting, Clippy and real-process lifecycle tests.
`pnpm daemon:build` builds both executables for Linux x64 and arm64 and their integrity
manifest. Bundled SQLite is cross-compiled with SHA-256-verified Zig 0.15.2, cached
under the builder's `.cache/palmagent-build`. Consumers need neither Rust nor Zig.

After building the package, run the delegated Linux acceptance on a test host:

```bash
pnpm exec tsx apps/server/scripts/daemon-systemd-smoke.ts
```

It installs and removes a unique user service with sudo blocked, using fixture
providers and isolated state. Pass the package path followed by `--system` to
exercise the legacy system bootstrap instead (requires non-interactive sudo). It checks
original provider PIDs and pending input, terminal screen continuity, routine PID/result continuity, daemon crash
recovery, web activation and detached descendant cleanup while blocking runtime
sudo/systemctl calls. It removes only its own service and confirmed-empty fixture.

## Independent application service

The first application migration moves script-routine definitions, scheduling, admission,
worktree preparation and completion persistence into `palmagent-runtime` (Tokio and Axum).
The retained Node script host still runs each command and writes its durable result.
Agent routines, Task/message orchestration and provider integrations remain in the Node
application. Source and legacy installations keep their existing local scheduler.

The web initializes product migrations, then asks the daemon to start the application
service for the selected release. A private Unix HTTP socket connects the web's routine
write adapter to the single native owner. Web reads reuse the existing SQLite projection,
avoiding a socket round trip and duplicate reads when combining script and agent rows.
Script and agent rows keep the existing SQLite schema;
the native repository only writes script rows. Admission and cadence changes commit in
one transaction before launching work. Unconfirmed launch requests are inspected, never
replayed. Completed results retain their admission slot until persistence and acknowledgement
succeed. The four-script limit and maintenance admission gate remain in force.

Web shutdown leaves script scheduling and result persistence running. A service crash
recovers retained invocations; missed schedules during application-service downtime are
skipped with the existing history reason. Ordinary web restarts preserve the application
service. Changing release stops the old service before the new web initializes its writer,
including rollback to releases without `applicationRuntime: 1`. Invocation hosts keep their
original release. Shutdown holds the ownership lock until in-flight adapter work settles.

`palmagent daemon status` exposes the optional `application` lifecycle and
`applicationRequired` selection state. Doctor checks readiness when the selected release
requires the service. Its private records live in `daemon/services`, outside the legacy
host inventory, so older clients can still inspect retained invocation records.
