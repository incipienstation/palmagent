# Authentication and access

Palmagent is a single-owner application. Each registered login method grants the same
access to conversations, agents, routines, and terminals. The terminal runs with
the installation owner's OS permissions. Keep the host and its backups private.

## Signing in

Passkeys require device PIN or biometric verification during registration and
sign-in. Devices or security keys without user verification cannot sign in. If an
older key stops working, use `palmagent passkey` on the installation host to create
a single-use enrollment link and register a compatible authenticator. Existing
passkeys with user verification continue to work.

The server checks the signature, challenge, RP ID and configured HTTPS origin.
Challenges expire after five minutes and cannot be reused. Successful sign-in
issues a random HttpOnly, Secure, SameSite=Lax cookie; the private passkey never
leaves the authenticator through this protocol.

Sessions expire at most 30 days after sign-in by default. Requests do not extend
that lifetime. `AUTH_SESSION_TTL_MS` sets the maximum lifetime, including for
sessions created by older versions. Expired sessions require a new login.
A successful login replaces the current browser's old session token.

## GitHub sign-in

Choose passkeys, GitHub, or both during installation. Each enabled method grants the
same owner access, including terminals. A GitHub-only installation can enroll its first
passkey later using host access. GitHub sign-in connects your installation directly
to GitHub and needs no Palmagent cloud service.

1. Run `palmagent auth status` on the installation host and copy its callback URL to
   a dedicated [GitHub OAuth App](https://github.com/settings/developers).
   Use the installation HTTPS origin for the homepage.
2. Save the client secret in a private file on the host. Run
   `palmagent auth github-prepare --client-id <id> --secret-file <private-file>`.
   Open the returned private setup link within 15 minutes and verify your account on GitHub.
3. Run `palmagent auth status`. Check the verified account handle and confirm its numeric
   ID with `palmagent auth github-confirm --owner-id <id>`. Sign in from a fresh browser.
   Repeat this flow to change the linked account or rotate the app credentials.
   Pass `--data-dir <directory>` for a custom installation.

The host stores the app secret in its private database. Browser verification alone grants
no access during setup. On login the server checks the browser-bound request, exchanges
the code using PKCE, and reads the authenticated user's stable GitHub ID. It requests no
additional scopes and discards provider tokens after checking identity. The browser gets
a normal Palmagent session. Signing out of GitHub does not end this local session.

Use `palmagent auth remove-github` to unlink GitHub, or `palmagent auth remove-passkeys`
to delete all registered passkeys. First verify the method you plan to keep. Removing
a method ends its sessions and invalidates pending authentication and enrollment links.
The host refuses to remove the last method. Use `palmagent auth logout-all` to end
all sessions on a GitHub-only installation. If GitHub is unavailable, use an enrolled
passkey or run `palmagent passkey` on the host to register one.

## Managing access

Open **Settings → Security** to create an enrollment link, remove a passkey, or
sign out all devices. Each action requires a fresh passkey verification. The
resulting authorization expires after five minutes, works only for the requested
action and original session, and can be used once.

Enrollment links grant account access once and expire after 15 minutes. Share
them only with a device you control. Browser-created links also stop working when
the issuing session ends. Enrollment authorization is checked again when the new
passkey is saved, including if logout occurred during the passkey prompt.
Upgrading from a version without issuer-bound links invalidates its unused
enrollment links. Create a new link after upgrading.

**Sign out all devices** ends every session and invalidates unused enrollment
links and pending authentication ceremonies. Registered passkeys remain valid.
To remove a lost passkey, verify with a different registered passkey. Removing a
passkey also ends every session and invalidates enrollment links. Running tasks
continue; session revocation does not stop agent processes or undo prior actions.

Existing event streams check authorization before delivering each frame and close
idle connections within one second of session expiry or revocation. Terminal
connections recheck authorization for input and output and on their heartbeat.

## HTTP boundary

With authentication enabled, all API writes, including login and enrollment,
require an `Origin` header exactly matching `AUTH_ORIGIN`. Browsers send it
normally. Direct HTTP clients must provide that configured origin as well as the
session cookie when required; an Origin header is a CSRF defense, not a credential.
Forwarded headers and request Host values do not select the trusted origin.

The application restricts scripts through Content Security Policy and prevents
framing. HTTPS termination and HSTS belong to the host ingress. Keep the runtime
bound to loopback and never expose a server configured with authentication disabled.

## Dependency vulnerability checks

The `security-audit` GitHub Actions workflow checks the default branch daily at
04:23 UTC, checks pull requests that change dependency manifests, lockfiles or
audit configuration, and supports **Run workflow** for an immediate check.
GitHub may delay scheduled runs during busy periods.

JavaScript checks cover production, development and optional dependencies directly
from the lockfile without installing or running dependency build scripts. The
production check fails on low or higher severity; the all-dependencies check fails
on moderate or higher severity. Its JSON report retains low-severity findings.
The Rust job runs the pinned `cargo-audit` version against `Cargo.lock` and the
current RustSec advisory database, failing on known vulnerabilities and reporting
informational warnings. Registry or database failures also fail the checks.
Reports are available in the workflow logs and retained as artifacts for 14 days,
including failed scans.

To repeat the checks locally, use the Node and Rust versions declared in `.nvmrc`
and `rust-toolchain.toml`:

```bash
node scripts/audit-javascript.mjs production low
node scripts/audit-javascript.mjs all moderate
cargo install cargo-audit --locked --version 0.22.2
cargo audit
```

Update affected direct dependencies and regenerate the lockfile first. If an
upstream package still pins a vulnerable dependency, use a narrowly scoped,
documented override and verify its consumers. Do not suppress an advisory or
treat a failed database lookup as a successful scan.

As of 2026-11-06, the development-only `deepmerge@4.3.1` dependency has one
low-severity [prototype-poisoning advisory](https://github.com/advisories/GHSA-gcqx-w48m-w2h4).
The registry audit suggests `4.3.2`, but no such release is published and the
advisory lists no patched version. It remains visible in the full report, without
an ignore entry. It is used by shadcn and Workbox's Rollup tooling; replace it with
a patched release when available and reverify those consumers.
