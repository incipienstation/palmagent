# Native runtime supervisor

New Linux package installations use the bundled Rust `palmagentd`. The web server,
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
user-owned bootstrap and delegates CPU, memory and PID controllers. It requires
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

## Updates and migration

Automatic update discovery, Stable/Preview selection, compatibility checks, receipts
and retry holds retain their existing behavior. The daemon starts an independent
updater, which stages an immutable package and pinned Node runtime. Activation
verifies daemon protocol and artifact hashes, writes private configuration,
replaces the daemon with `exec` (preserving its bootstrap PID), verifies the new
build identity, and replaces the web process. Existing hosts keep their original
release. Daemon-managed routine scripts also keep their original release and process. Scheduling,
admission and run history remain in TypeScript; the script host persists its result
independently and the replacement web process recovers it without rerunning the command.
Timeouts and explicit cancellation still clean up the script and its descendants.
Source and legacy installations keep web-owned scripts, so activation still waits
for those scripts to finish and retains the pending update request.

Failed activation attempts restore the previous runtime configuration and check
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
`pnpm daemon:build` builds both artifacts and their integrity manifest.

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
