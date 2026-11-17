# Direct Rust read experiment

This opt-in experiment changes the public request boundary for five existing GET routes.
The same browser origin routes these requests to Rust; all other requests still go directly
to the existing Node listener. There is no Node authentication callback or response parsing
on the selected path, and no Rust proxy in front of the remaining Node APIs.

| Route | Selection |
| --- | --- |
| `/api/usage` | GET |
| `/api/tasks/:id/history/details` | GET |
| `/api/tasks/:id/history/steps` | GET |
| `/api/tasks/:id/history` | GET with `format=transcript` |
| `/api/tasks/:id/history/changes` | GET with `format=transcript` |

Rust verifies the existing session cookie against committed SQLite sessions on every request,
including absolute login lifetime and revocation. Node remains the sole login, logout, event,
projection and schema writer. The normal event append/import paths already update the projection
in the same transaction. Startup repairs retained dirty projections before enabling direct reads.
A direct read that encounters a dirty or incompatible projection fails closed instead of serving
stale data or calling Node to repair it. Invalid-session cleanup remains with Node.

The native reader algorithms, page budgets, mutexes and two-request admission limits are unchanged.
The public boundary preserves request validation, task existence checks, JSON value semantics,
error codes and security/cache headers. Transport serialization can change key order or number
spelling; response JSON values remain equivalent. Operation details, content chunks, raw history,
SSE, WebSockets, writes, login, health and static files retain their Node routes.

## Enable in an isolated installation

1. Use a clean identified build containing `taskReadHttp: 1`, with the native application runtime.
   Disable telemetry sharing in the validation installation.
2. Set `NATIVE_READ_HTTP_PORT=4001` in the Node owner's environment, using a free port different
   from `PORT`. Rust binds only `127.0.0.1`. Startup sends the validated auth settings through the
   existing owner-only application socket; the public listener exposes no private control APIs.
3. Apply the [routing map](nginx-routing.conf) to the existing same-origin ingress, adapting only
   the two example upstream addresses. Its normal default continues directly to Node. Preserve
   the existing TLS, cookie forwarding, WebSocket and streaming settings. Do not add cross-origin
   browser requests or fall back to Node when the Rust route fails.
4. Check authenticated, unauthenticated, expired and revoked sessions; verify the selected routes
   hit Rust and an unchanged route such as `/api/health` still hits Node. The loopback listener is
   independently authenticated even when bypassing the ingress.

The flag starts the listener; it does not rewrite host ingress configuration. Normal installations
remain unchanged until both steps are applied. Browser-facing HTTP/SSE/WebSocket contracts and
operator CLI/plugin compatibility are unchanged. The listener closes with the Node owner during
an orderly shutdown. After a crash it can continue serving committed reads until owner recovery;
the next startup reapplies configuration. Native process exit closes it as well.

To roll back routing, point all ingress requests back to Node. Then unset `NATIVE_READ_HTTP_PORT`
and restart the owner; startup disables any retained direct listener. No schema migration or data
conversion is required. Never expose the private application control socket through the ingress.

## Compare one change at a time

Keep the same Node process, optimized Rust binary, database, session, machine and ingress settings.
Change only the selected upstream map between the mediated Node-to-Rust path and the direct Rust
path. Alternate A/B/B/A/A/B after warmup. Keep fixture writes outside the timed warm-read workload;
measure an invalidated usage cache separately. Use one and four concurrent requests and record
503s as failures instead of dropping them from the report.

Compare HTTP p50/p95, successful requests per second, and combined Node plus Rust CPU. Keep health
on Node as a control. Response values and fixture revision must remain stable. Page reads after a
write should also be checked without first visiting the Node history endpoint, so the experiment
cannot accidentally depend on Node repairing a projection just before the measurement.

The direct listener currently contributes to native process resource observations; the existing
Node `http.request` metrics do not include its requests. Use the isolated end-to-end benchmark for
this experiment rather than comparing incomplete production request cohorts. Do not interpret a
transport-only result as evidence that the unchanged admission limit or read serialization is fixed.
