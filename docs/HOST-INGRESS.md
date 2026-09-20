# Host ingress and migration

Palmagent's operator plugins manage the connection from the public domain to the local
application. They inspect the existing proxy, hosting panel or container configuration
before choosing a setup. A new host can use a dedicated proxy; an existing host keeps
its current ingress owner. The application CLI manages its runtime, not nginx or TLS.

Prepare a domain pointing to the host. Ask the plugin to install or reconfigure Palmagent
with that domain. It resolves available permissions, DNS/routing and authentication
prerequisites, installs the runtime, configures ingress, and verifies HTTPS before providing
a passkey enrollment link. External firewalls and interactive provider login may still
require your action. Installation never means replacing unrelated sites.

## Existing installations

Upgrading preserves existing proxy configurations, certificates, and renewal jobs. Your
saved domain, port, HTTPS authentication origin, passkeys and data directory remain valid.
No proxy reload or certificate replacement is required for an unchanged, healthy route.
The plugin inventories and adopts the existing ingress before later changes. Keep the old
certificate renewal mechanism until any deliberate replacement is verified.

The CLI's install/setup/update commands no longer provision routing, and uninstall (even
with --purge) no longer removes it. Use the plugin for changes to the domain or internal
port, and for complete removal. Standalone CLI users must coordinate those changes with
their own ingress manager. Changing domains changes passkey identity and requires device
re-enrollment; changing a port requires updating the proxy upstream.

Application updates leave routing intact. Recovery to an older application cannot establish
that its public transport works: verify ingress separately. If an older CLI is explicitly
run, it may still manage nginx; do not use it as a proxy cleanup tool.

## Runtime and transport checks

`palmagent connection --data-dir <installation-data-dir>` prints a versioned JSON contract
containing the public HTTPS origin, RP ID, loopback upstream, and forwarding requirements.
It is read-only and contains no session tokens or private keys. The existing `--domain`
setting remains the input; there is no new required installation configuration.

`palmagent doctor` diagnoses the local application and providers without consulting nginx
or local certificate paths. Public health/version, TLS, streaming, and terminal WebSocket
checks are performed separately by the plugin. `palmagent terminal diagnose` remains an
explicit end-to-end check. Local requests to a public hostname are not proof of off-host
reachability. A first enrollment link is minted with `palmagent passkey` after HTTPS works.

Preserve Host, uncached APIs, unbuffered SSE and WebSocket upgrades. Follow the connection
contract's body and per-client rate/connection limits. An application-wide authentication
budget (20 POSTs/s with a burst of 40) provides a bounded backstop without trusting forwarded
IP headers; the ingress still provides per-client isolation. Stock Caddy needs a suitable
limiting facility or an existing protective edge to match that contract.

## Ownership and removal

The plugin keeps a private operation receipt outside both the application data directory
and plugin cache. It records created/adopted resources, fingerprints, recovery state and
certificate renewal ownership. Removal preserves shared resources and files modified since
adoption. Uninstalling the application never uninstalls the host's shared proxy or revokes
certificates. The plugin reports application removal and ingress cleanup separately.
