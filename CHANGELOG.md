# Changelog

Notable changes for users and installation operators are documented here.
See the [changelog writing rules](docs/RELEASING.md#changelog-writing-rules).
An entry does not mean a version has been published.

## Unreleased

## 0.1.0-alpha.1

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
