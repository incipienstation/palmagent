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
- `view.js` receives its private socket path and the eligible static directories, a minimal environment,
  and an IPC parent lease. It imports no Task/runtime/database composition and receives no
  provider credentials or daemon-readiness capability. Its Unix socket lives in a private
  temporary directory. It accepts file GETs only; it has no API or local control surface.
- The API owner normally serves the loopback port, authenticated API, SSE and terminal WebSockets.
  A compatible update temporarily shares the listener with the update gateway. Only non-API file GETs are forwarded to the child, without cookies or
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

The view serves the active shell and worker. After an activation it can also serve an
asset missing from the active release by its exact filename under the other retained release's
`web/assets/` directory. The activation receipt identifies that release within this installation.

### Full application updates

Compatible Linux daemon releases advertise `updateAdmission: 1` and the same `taskStorage`
generation. The updater stages the candidate and starts `update-gateway.js` on the existing
loopback address using Linux port sharing before entering maintenance. The gateway forwards
connections to the owner's private public-API socket. When that socket is unavailable, it
authenticates writes against a read-only session database and enforces the configured Origin.
SSE and terminal connections reconnect to the new owner. The PWA uses its existing history
cursor to fetch missed output. Executions, terminals and compatible routines keep their
original host processes and immutable releases.

The browser negotiates durable admission with `Prefer: respond-async` on Task creation and
message submission. A `202` with `Preference-Applied: respond-async` confirms that the original
request ID and payload are committed to the private `update-inbox.sqlite`. The client polls a
receipt for the execution decision. A duplicate ID with changed content returns a conflict.
The inbox admits up to 256 pending commands and 256 MiB of encoded payloads per installation.
A full inbox returns 507. Completed records discard the command body and keep the receipt for
seven days, with expiration collected on later admissions.

The API takes its process-lifetime lock before database recovery, advances the inbox owner
generation and drains pending commands in insertion order once maintenance ends. It checks
the generation before applying a command and when committing its result. The Task service
revalidates the target run and uses the original request IDs on recovery. Uncertain provider
delivery stays visible as `unknown`. Stop can carry an expected run ID and answers retain the
question request ID.

The updater records the selected immutable release pair, build identity and activation phase.
Re-running the update resumes that pair. A pending UI request can resume through its usual
activity wake after an interrupted handoff. An incompatible pair uses maintenance, and the
updater allows automatic restoration only when both storage generations agree. The first
upgrade from a release without the gateway uses maintenance. Other mutations may return a
temporary error during owner replacement.

## Verification

The real-process lifecycle contract stalls the view while a synthetic provider is active,
advances queued follow-ups, accepts another authenticated message, and checks the existing SSE
connection after view restart and automatic recovery. It also checks request deduplication,
wrong-Origin/missing-cookie rejection, singleton startup before Task recovery, maintenance
rejection, and child cleanup after an API crash. Existing execution/recovery tests remain the
baseline; no browser matrix duplicates their policy coverage.

Package verification checks the bundled worker and CLI against the installed tarball. Host
TLS/passkey enrollment, external ingress and systemd deployment remain separate acceptance boundaries. The [original experiment](performance/task-runtime/README.md)
records measurements of its own earlier snapshot, not performance guarantees for this implementation.
