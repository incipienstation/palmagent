# Native runtime supervisor

New Linux package installations use the bundled Rust `palmagentd`. The web server,
provider adapters, execution journals, terminal hosts and update policy remain in
TypeScript. Nx runs the Rust build and checks alongside the existing projects.

## Ownership and platform boundary

`palmagentd` owns host reservations, process identity, launch, inspection, cleanup,
web recovery and update executor launch. Each execution, terminal, web process and
updater has an independent guardian from its retained release. Guardians own their
Node child, output pipes and bounded log files. Replacing or crashing the control
daemon does not replace those guardians or their provider input channels.

The Linux adapter implements PID/start-time/boot identity, pidfd signaling, private
Unix IPC, locking and delegated cgroup v2 isolation. Execution and terminal groups
have separate aggregate memory, CPU and task limits. Cancellation cleans up the
whole group, including descendants that create a new session. Process-group mode
exists for development tests and does not offer the same containment guarantee.
These are OS adapter boundaries; macOS and Windows implementations are not included.

Systemd is only the Linux boot/crash-recovery adapter for new installations. Its
single `palmagentd.service` launches a stable user-owned bootstrap, delegates CPU,
memory and PID controllers, and leaves host lifetimes to the daemon. It requires
systemd 254+ (`DelegateSubgroup=control`) and cgroup v2 with `cgroup.kill` support.
The control subgroup lets systemd restart the daemon while other groups remain
populated. Initial registration, migration and removal require sudo; ordinary
execution, terminal control, settings and application updates do not.

## Updates and migration

Automatic update discovery, Stable/Preview selection, compatibility checks, receipts
and retry holds retain their existing behavior. The daemon starts an independent
updater, which stages an immutable package and pinned Node runtime. Activation
verifies daemon protocol and artifact hashes, writes private configuration,
replaces the daemon with `exec` (preserving its bootstrap PID), verifies the new
build identity, and replaces the web process. Existing hosts keep their original
release. Routine scripts currently belong to the web process, so activation waits
for them to finish and retains the pending update request.

Failed activation attempts restore the previous runtime configuration and check
its health. Both releases and the activation receipt remain available; database
changes are not rolled back. An interrupted updater leaves its retry hold for
explicit recovery. A full machine reboot ends active processes.

Existing systemd execution installations keep their backend during package updates.
`palmagent setup` migrates them only during verified idle maintenance: executions,
terminals and routine scripts must finish first. It retains previous configuration,
registers the bootstrap, starts and checks the daemon, and removes the obsolete
service helpers after success. Source installations retain their current backend.

## Diagnostics and verification

`palmagent doctor` checks the selected supervisor. For daemon installations, inspect
`systemctl status palmagentd.service` and `journalctl -u palmagentd.service` for
bootstrap failures. Host output lives in `<data-dir>/daemon/logs/`; private host
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

It uses fixture providers, a unique temporary service and isolated state. It checks
original provider PIDs and pending input, terminal screen continuity, daemon crash
recovery, web activation and detached descendant cleanup while blocking runtime
sudo/systemctl calls. It removes only its own service and confirmed-empty fixture.
