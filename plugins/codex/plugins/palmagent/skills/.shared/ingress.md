# Host ingress: owned by the operator plugin

Use this reference for installation, domain/port changes, ingress diagnosis, removal,
or adoption of an older CLI-managed installation. The CLI manages the application only:
it never installs, edits, validates, reloads, or removes a reverse proxy or certificates.
A successful CLI operation proves neither public HTTPS nor external reachability.

## Discover and choose

Inspect the actual listener on 80/443 (including IPv6), its process/service/container,
configuration source, includes, domain routing, certificate issuer/renewal owner, and
DNS A/AAAA records. A binary on PATH or an existing directory does not identify the
active ingress. Read configuration privately; do not echo credentials or full host inventories.
Reuse a hosting panel, Compose project, or other existing configuration owner rather than
editing its generated files. Preserve unrelated sites, default servers and authentication.

For a directly managed nginx host, add or adapt only the requested domain's site. For a
fresh host with free public ports, a dedicated Caddy service is a suitable default; use
current official documentation for its installation and supported configuration. An existing
Caddy, another proxy, a tunnel, or externally terminated TLS can be reused when its owner
and forwarding contract are understood. Do not replace a working ingress to standardize it.
If routing ownership is ambiguous, inspect further or ask only for the unresolved choice.
A container cannot claim a public IP/port already owned by another listener.

Carry the installation authorization through this work as described in [bootstrap](bootstrap.md).
Report the concrete changes before applying them. Do not request an extra blanket approval
for the already authorized installation. Replacing another site's route, changing shared
policy, or interrupting unrelated services is outside a domain-only installation request.
Cloud firewall, DNS, vendor sign-in, or unavailable sudo can require user action; do not
claim domain-only completion while those prerequisites remain unresolved.

## Application contract

After installing the runtime, read `<cli> connection --data-dir <installed-data-dir>`.
It returns JSON: `schemaVersion`, `ingressOwner`, `publicOrigin`, `rpId`, `upstream`,
`healthPath`, and `proxy` requirements. Check command availability in help when adopting
older releases; never guess that an old CLI supports it. Retain the existing `--domain`
input and derived HTTPS origin; this migration does not change passkey RP identity.

Forward to the reported loopback upstream, preserve the public Host, and serve the app
only through public HTTPS. Keep API responses uncached. Support unbuffered SSE at
`/api/stream` with a 3600-second read timeout, authenticated WebSocket upgrades at
`/api/terminals/:id/stream` with at least a 60-second idle timeout, and 48,000,000-byte
image bodies. Preserve the per-client limits from the contract (auth 5 requests/s,
burst 10; API 20 requests/s, burst 40; API/SSE 30 connections; terminal 16 connections).
Choose supported proxy facilities or an existing edge limiter; stock Caddy does not
by itself reproduce nginx's limit_req policy. Do not silently discard these protections.
The application's global auth backstop is additional protection, not per-client isolation.
Never trust arbitrary client-supplied forwarding headers as an authenticated client IP.
With multiple proxy hops, configure trust only for the verified preceding hop.

## Apply and keep an ownership record

Store host operation state outside the repository, plugin cache, and application data
(which `uninstall --purge` may delete). Use a private, operator-owned directory such as
`/var/lib/palmagent-ingress/<installation-id>/`, root-owned when privileged files are
managed. Reuse the installation's recorded ID; create a random ID only for a new record.
Do not treat a filename or generated comment alone as proof of ownership.

Before a mutation, write a private receipt with schema version, installation data directory,
public origin, upstream, configuration owner, certificate renewal owner, operation status,
and an inventory of each planned file/symlink/service change. For files record path,
previous existence, mode, owner, symlink target or backup, and SHA-256 of previous/candidate
content; track created versus adopted resources and the reload/validation commands.
Record progress after each successful step so another plugin session can resume or recover.
Do not store private keys in the receipt. Backups containing configuration stay private.

Start and verify the internal runtime before exposing it. Validate existing ingress first;
prepare candidates and check that pre-change fingerprints still match immediately before
application. Install owned candidates atomically, validate the entire effective config,
then gracefully reload the actual owner. Verify the route, not just a reload exit code.
No-op configurations need no reload. On failure, restore only this operation's changed
resources, and only if they still match what this operation wrote; otherwise preserve the
concurrent changes and report recovery required. Never restore an entire old host config
or restart unrelated services. Retain a receipt of success or incomplete recovery.

For directly managed nginx, the optional [renderer](render-nginx.mjs) emits JSON file
candidates without writing files or calling sudo. Feed a JSON object on stdin with
`instanceId` (8-32 lowercase alphanumeric characters), `domain`, `host`, `port`,
`certificate`, `privateKey`, and `acmeRoot`. Paths must be absolute and contain only
letters, digits, underscores, dots, slashes, or hyphens. Select paths from inspected
host state; the renderer does not discover includes, resolve site conflicts, or install.

```bash
node <plugin-skills>/.shared/render-nginx.mjs < <private-input.json> > <private-candidates.json>
```

Review candidates against the actual host. The optional bootstrap exposes only the
ACME challenge directory and returns 404 for app requests. For new certificates use
an isolated Certbot webroot/config/work/log directory and a dedicated renewal timer;
avoid `--nginx` edits across shared config. Keep the challenge route in the final HTTP
site, redirect other requests to HTTPS, and verify renewal plus its validated reload hook.
For Caddy, keep its certificate storage persistent and its admin endpoint private to
its dedicated service. Renewal must run without an active plugin session.

## Verify and finish

Check the internal health response and expected runtime version, then the public HTTPS
certificate/hostname, health/version, app shell, and authentication route. Use the CLI's
explicit `terminal diagnose` when supported to verify a disposable shell over public
HTTPS/WebSocket, and check SSE delivery. Do not weaken TLS verification to pass a check.
Host-local requests to the public hostname do not prove off-host reachability; distinguish
that result from an external probe or the user's successful browser connection.
Only after HTTPS succeeds, run `<cli> passkey` to mint the short-lived enrollment link.
A domain change changes passkey RP identity: preserve the old route until the new route is
verified, explain device re-enrollment, and prepare a fresh link for the new origin.

## Adopt existing installations and maintain them

Updating the CLI leaves old proxy files, certificates, and renewal jobs intact. Inspect
and record them as adopted/external resources before editing. Older CLI defaults included
`palmagent.conf`, `palmagent-ratelimit.conf`, an ACME bootstrap file, and certificates under
`/etc/letsencrypt/live/<domain>/`; names are discovery hints only. Resolve symlinks, shared
zone/cache uses, actual certificate consumers and renewal hooks. Do not issue a replacement
certificate or change renewal ownership solely because the CLI was updated. A healthy,
unchanged route needs no migration reload. Remove a stale bootstrap only with ownership
and routing evidence. Port/domain changes require coordinating the runtime and route,
recording both prior states for recovery; do not report success for a mismatched pair.

Normal application updates preserve ingress. After a plugin-driven update, compare the
new connection contract with the adopted route and change only what is required. Automatic
CLI updates cannot perform host routing migrations; report a required operator action if
a future feature needs a new route. A runtime rollback does not roll back ingress.

For removal, inspect the receipt and live state first. Honor active execution/terminal
refusals from the CLI before removing routes. After successful runtime removal, remove only
verified installation-owned routes and renewal jobs; preserve manually modified or shared
resources. For adopted resources, establish exclusive ownership before deletion. Do not
remove a shared nginx/Caddy package, revoke certificates, or delete shared certificate
storage as part of ordinary uninstall. Report retained resources and their reasons.
