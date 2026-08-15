# Changelog

All notable user-visible changes to Palmagent are documented here.

## Unreleased

### Added

- Public-source monorepo foundation with shared contracts, host runtime, PWA,
  and Claude Code and Codex operator plugins.
- Public CLI package assembly, host installer, deterministic release checks,
  and a non-publishing release-candidate workflow.

### Security

- Public origins are HTTPS-only, services bind to loopback, and the initial
  certificate bootstrap never proxies application traffic over plaintext.
- Installation refuses a root service identity, and persistent state, bearer
  sessions, runner sockets, and installer metadata are owner-only.
- Source and assembled-package leak scans support a private fail-closed denylist.

### Changed

- Every management command consistently honors `--data-dir`.
- Runner artifacts are fingerprinted so setup and package updates restart the
  daemon only when its unit or executable content changed.
- Public self-update is package-only; source checkouts use the maintainer pnpm
  workflow instead of mutating Git from the installed CLI.
- Dry runs render to standard output without writing into the data directory.

No version listed here has been published merely because it appears in source.
See [the release policy](docs/RELEASING.md).
