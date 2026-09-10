# Changelog

Notable changes for users and installation operators are documented here.
See the [changelog writing rules](docs/RELEASING.md#changelog-writing-rules).
An entry does not mean a version has been published.

## Unreleased

### Changed

- Prereleases publish to npm `next` after GitHub Release publication and automated validation,
  without a second approval. Stable releases retain the `npm-latest` reviewer gate. Existing
  tags keep their original publication checks; see the [release runbook](docs/RELEASING.md#protected-npm-publication).

## 0.1.0-alpha.2

### Added

- Self-hosted dispatcher, mobile-first PWA, public CLI and host installer,
  and Claude Code and Codex operator plugins.
- Show the latest reported task token usage and cost above the composer.
- Expand Codex model choices in task and routine forms.
- Deploy an exact npm version or verified package to staging, with checks of the running
  version and PWA, deployment records, and verified rollback to a retained package. Operators
  must assess database compatibility and backup or restore needs separately; package rollback
  does not restore the database. See the [staging runbook](docs/STAGING.md).

### Security

- Public origins are HTTPS-only, services bind to loopback, and the initial
  certificate bootstrap never proxies application traffic over plaintext.
- Installation refuses a root service identity, and persistent state, bearer
  sessions, runner sockets, and installer metadata are owner-only.

### Changed

- Require Node.js 22 or newer, up from Node.js 14 in the published name-reservation
  placeholder `0.0.1-alpha.0`. This is the first functional npm package. Host installation
  requires Linux with systemd, nginx, sudo, a public HTTPS domain, and an authenticated
  Claude Code or Codex CLI.
- Every management command consistently honors `--data-dir`.
- Runner artifacts are fingerprinted so setup and package updates restart the
  daemon only when its unit or executable content changed.
- Public self-update is package-only; source checkouts use the maintainer pnpm
  workflow instead of mutating Git from the installed CLI.
- Dry runs render to standard output without writing into the data directory.

### Fixed

- Preserve annotated release tags during candidate validation so the first functional npm
  package can be built. The earlier 0.1.0-alpha.1 candidate stopped before packaging.

## 0.1.0-alpha.1

This tagged candidate was not published; validation failed before a package or release draft
was created. Its intended features are carried forward into the next candidate.

### Added

- Self-hosted dispatcher, mobile-first PWA, public CLI and host installer,
  and Claude Code and Codex operator plugins.
- Show the latest reported task token usage and cost above the composer.
- Expand Codex model choices in task and routine forms.
- Deploy an exact npm version or verified package to staging, with checks of the running
  version and PWA, deployment records, and verified rollback to a retained package. Operators
  must assess database compatibility and backup or restore needs separately; package rollback
  does not restore the database. See the [staging runbook](docs/STAGING.md).

### Security

- Public origins are HTTPS-only, services bind to loopback, and the initial
  certificate bootstrap never proxies application traffic over plaintext.
- Installation refuses a root service identity, and persistent state, bearer
  sessions, runner sockets, and installer metadata are owner-only.

### Changed

- Require Node.js 22 or newer, up from Node.js 14 in the published name-reservation
  placeholder `0.0.1-alpha.0`. This is the first functional npm package. Host installation
  requires Linux with systemd, nginx, sudo, a public HTTPS domain, and an authenticated
  Claude Code or Codex CLI.
- Every management command consistently honors `--data-dir`.
- Runner artifacts are fingerprinted so setup and package updates restart the
  daemon only when its unit or executable content changed.
- Public self-update is package-only; source checkouts use the maintainer pnpm
  workflow instead of mutating Git from the installed CLI.
- Dry runs render to standard output without writing into the data directory.
