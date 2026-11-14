# Task owner and web view

The TypeScript API process owns Task state, message receipts, queue advancement and execution
recovery. It keeps the existing SQLite connection, service caches, authentication and endpoints.
A separate child process serves PWA files. Restarting or losing that child leaves accepted
messages advancing and new authenticated messages admissible through the same stable API route.

## Ownership and routing

- The native daemon continues supervising `server.js` under its historical `web` host identity.
  Its guardian, readiness deadline, crash backoff, retained release and process-group/cgroup
  ownership are unchanged. No second native service or database writer is introduced.
- Before database construction or recovery, the API acquires `runtime.lock` beside the database.
  The Linux `flock` lease lasts until resources close, or is released by process exit. It is
  separate from the installation's update lock. A duplicate owner cannot reset running Tasks.
- `view.js` receives only its private socket path and static directory, a minimal environment,
  and an IPC parent lease. It imports no Task/runtime/database composition and receives no
  provider credentials or daemon-readiness capability. Its Unix socket lives in a private
  temporary directory. It accepts file GETs only; it has no API or local control surface.
- The public loopback port, authentication, session controls, SSE and terminal WebSockets stay
  with the API owner. Only non-API file GETs are forwarded to the child, without cookies or
  authorization headers. Static caching, content security headers and file-boundary checks
  remain in effect. The external TLS proxy's upstream does not change.

## Lifecycle

`palmagent view status|restart --data-dir <path>` uses the existing owner-only control socket.
The control is not mounted on the public HTTP API. Status reports `protocol`, `ownerPid`,
`state`, `generation`, and the current view `pid` when present. `state` is `starting`, `ready`,
`unavailable`, or `stopped`. A successful child readiness handshake advances `generation`.
Concurrent restart requests share the current operation. Restart confirms old-child exit before
launching a new child; a stalled view is killed after a three-second graceful-stop deadline.
Startup requires a private IPC readiness handshake within ten seconds.

Unexpected view exit triggers exponential retry delay, from one second up to thirty seconds.
A stable child resets the backoff. Shutdown cancels recovery; the child also exits on IPC
lease loss if the API dies abruptly. A healthy API can still return 503 for static files while
the view recovers. Already loaded pages and their live API connections need no restart.

The view remains in the API host's resource containment. It isolates file-serving process
failure and controlled view replacement, not an entire cgroup failure or host resource outage.
The daemon recovers an API-owner failure through the existing durable Task/execution path.

## Compatibility and update boundary

The additive release capability is `viewControl: 1` in `runtime-contract.json`; such releases
must contain `view.js`. Older releases without the capability remain valid. The CLI reports
unsupported runtimes instead of silently performing a full restart. Operator plugins check
CLI command availability before using the new control. Product and plugin versions continue
following the existing coordinated release policy; daemon and message protocols are unchanged.

A view always uses its owner's immutable release. Independent view/API release selection is
not supported. Full updates, reconfiguration and rollback still restart the API host and
its child under existing maintenance rules. A view restart is rejected during maintenance.
No Task schema migration, old-history migration, provider retry, or new delivery protocol is
introduced. FIFO, edit locks and durable request-ID deduplication remain owned by the existing
Task policies; uncertain provider delivery (`unknown`) is never automatically resent.

## Verification

The real-process lifecycle contract stalls the view while a synthetic provider is active,
advances queued follow-ups, accepts another authenticated message, and checks the existing SSE
connection after view restart and automatic recovery. It also checks request deduplication,
wrong-Origin/missing-cookie rejection, singleton startup before Task recovery, maintenance
rejection, and child cleanup after an API crash. Existing execution/recovery tests remain the
baseline; no browser matrix duplicates their policy coverage.

Package verification checks the bundled worker and CLI against the installed tarball. Host
TLS/passkey enrollment, external ingress, systemd deployment and full-update continuity remain
separate acceptance boundaries. The [original experiment](performance/task-runtime/README.md)
records measurements of its own earlier snapshot, not performance guarantees for this implementation.
