# Standalone installation and migration

Palmagent's standalone distribution includes the application, exact Node runtime, native
addons, daemon and execution hosts. The operator plugin performs installation and updates.
The bootstrap script prepares a CLI only; it never installs services or changes ingress.

| Requirement | Supported |
| --- | --- |
| OS and architecture | Linux x64 or arm64 |
| libc | glibc 2.35 or later, with libstdc++6 |
| Bootstrap tools | curl, GNU tar/coreutils, jq, OpenSSL 3, awk, grep, sed, diff |
| Application services | systemd 254+, user manager, lingering, delegated cgroup v2 |
| Providers | git and an authenticated supported Claude Code or Codex CLI |

macOS, Windows, musl and 32-bit hosts are rejected. Platform archives are built on Ubuntu
22.04 and tested in a baseline container with no network, system Node, or npm. That test
covers runtime loading; service acceptance needs a host with the service prerequisites.

The HTTPS bootstrap entry point is `https://releases.palmagent.dev/install.sh`. It discovers the
saved channel, defaults a fresh installation to Stable, verifies signed metadata and
archive SHA-256, and retains the bundle under the user's Palmagent CLI directory. An
explicit `--prefix` isolates a temporary CLI and leaves the user's command link alone.
Preview requires an explicit choice. There is no fallback when a channel is unavailable.

## Updates

The shared `config.json` owns the channel. Installation metadata independently records
`npm` or `standalone`. Existing Stable npm installations stay on npm unless a migration is
requested. Selecting Preview on npm causes the next update to plan a standalone migration.
Changing the preference alone does not activate software. Standalone stays standalone when
switching channels. Version downgrades remain refused.

Plan schema v2 includes current/target distribution and `action` (`keep`, `update`, or
`migrate`), plus the signed manifest and archive hashes for standalone. Apply uses that
private plan file and revalidates it. Durable UI update requests retain the same selection;
a channel move cannot silently substitute another release. `--dry-run` stays offline.

The new contract starts at 0.2.x. A 0.1.x CLI cannot operate with a 0.2.x plugin, or vice
versa. The update plugin prepares an exact compatible standalone CLI in an isolated prefix,
verifies the participating new plugin manifests, and runs that candidate with forwarding
disabled for migration. Keep the existing data directory, account and service scope.
Automatic updates defer this compatibility-line transition for operator handling.

Candidates are verified before maintenance, then retained under the installation's releases
directory. Activation uses the existing maintenance lock, compatibility checks and health
verification. Independent executions keep their original release and Node paths. Legacy
installations must become idle before migration. Failed activation attempts restore the
previous application when possible and otherwise retain a recovery receipt. Neither a
failed update nor rollback restores a database. Old npm packages and retained artifacts are
not automatically deleted.

## Release trust

Channel and release documents are Ed25519-signed envelopes. Verification uses their exact
decoded payload bytes, followed by schema and identity checks. Official immutable GitHub
Release assets carry the per-platform archives. A signed channel journal records publication
with non-fast-forward overwrite protection; GitHub Pages activates the complete channel site
after the release assets have been verified. The initial trust root is the HTTPS bootstrap and its embedded
public keys. Publish a client trusting the replacement key before switching signing keys.
An empty trust store intentionally prevents any release from being installed or published.
