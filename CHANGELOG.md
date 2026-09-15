# Changelog

Notable changes for users and installation operators are documented here.
See the [changelog writing rules](.harness/skills/release/references/policy.md#changelog-writing-rules).
An entry does not mean a version has been published.

## Unreleased

### Fixed

- Allow queued automatic updates to install their exact discovered version after
  active tasks and agent runs finish. The updater no longer rejects its own
  version pin as a manual override. Installations affected by this bug need one
  plugin-assisted update to receive the fix.

## 0.1.0-alpha.14

### Changed

- Finish web updates automatically without a separate Refresh step, preserving
  each tab's drafts, attachments, open forms, and conversation position. Screen
  changes wait for submissions and text composition to finish; a failed save
  keeps the current screen open. Running Codex and Claude sessions continue.

## 0.1.0-alpha.13

### Fixed

- Manual CLI updates now preserve running Codex and Claude sessions by checking
  task and runner activity before package replacement, service activation, or
  source-update `setup`.
  Active or unverifiable work blocks the update even with `--force`.

## 0.1.0-alpha.12

### Changed

- Product maintenance update. See the [source changes](https://github.com/incipienstation/palmagent/compare/356aadae5bdb3357cbbdbea15fdb02d19017f2c1...360b93128a5e76e46c1046046fe4a893e67f72ca) for details.

## 0.1.0-alpha.11

### Added

- Rename sessions from the task list or detail header, with names saved across devices
  without changing their activity order or interrupting ongoing work.

## 0.1.0-alpha.10

### Changed

- Check for updates when opening or returning to the app, with Check again and
  Update actions in Settings. Updates wait for active tasks to finish and then
  resume automatically. The six-hour timer is removed when this version is activated.
- When the server changes version, the app checks for its new screen code and asks
  you to refresh before submitting further changes.

## 0.1.0-alpha.9

### Changed

- Replace session token counters with remaining account allowance and reset
  countdowns. Claude and Codex show their own quota windows, with additional
  model limits and credits in Details. Limits refresh while sessions are idle too.
- Long sessions open with recent history and render only nearby messages. Scroll up
  to load earlier messages while retaining your reading position; live output is
  batched for smoother updates. The inbox no longer downloads unused event history.

## 0.1.0-alpha.8

### Changed

- Compact and Default keep session output focused with folded activity, short progress previews,
  and less metadata and usage clutter. Expand activity or session details to inspect the full
  record; questions, failures, final answers, and unclassified older messages remain visible.

## 0.1.0-alpha.7

### Added

- View saved messages from dispatched local sessions while the CLI stays open. Follow-up
  becomes available after the local CLI closes and the final transcript synchronizes.

### Fixed

- Show local sessions as read-only previews instead of completed tasks, with clear
  instructions for continuing in Palmagent and visible synchronization errors.

## 0.1.0-alpha.6

### Fixed

- Open sessions at the latest message without visibly scrolling through replayed history.
  Live updates still follow the bottom unless you scroll up to read earlier messages.


## 0.1.0-alpha.5

### Added

- See the running Palmagent version and manage automatic updates, release channel,
  and the last update result from Settings. Preferences stay shared with operator plugins.

### Fixed

- Preserve custom data and settings directories in the web service so UI and CLI
  update controls manage the same installation.

## 0.1.0-alpha.4

### Added

- Manage sessions by their working directory, with desktop navigation and a mobile directory picker.
- Release an idle session to a shell and copy its native Claude/Codex resume command.
  Use the dispatch plugin skill to return a local session; Palmagent waits for the
  local CLI to exit and synchronizes new messages before accepting follow-up.
- Render supported structured PNG, JPEG, WebP, and GIF outputs in the session log.
- Agent CLI version ranges are included in package and plugin compatibility metadata
  and reported by `palmagent compatibility` and doctor checks.

### Changed

- Migrate the browser API and local session-control HTTP to Hono, with shared
  request validation and graceful web-server shutdown that preserves daemon-owned turns.
- Malformed request fields now return a consistent JSON 400 response before mutation;
  unexpected server errors return a generic message while details remain in server logs.

### Fixed

- Replay the complete SSE backlog across reconnects, including histories longer than
  5,000 events, and bound pending output for slow clients.
- Count request body limits in bytes and return JSON 413 responses for oversized uploads.


- Use the N-API SQLite binding to avoid native statement-cleanup crashes with recent Node 24 builds.

- Operator plugins reuse authorized installation, reconfiguration, and repair requests
  and known settings across skill handoffs, asking only for missing inputs or new effects.

- Operator plugins share one CLI bootstrap guide with exact-version installation targets.
  Diagnostics can collect read-only evidence when CLI/plugin compatibility checks fail,
  without replacing the installed package or resetting preferences.

- Codex plugin installation and update instructions now register the nested marketplace
  from a checkout of the published tag. The previous Git sparse-checkout command could
  not find the marketplace catalog. Existing published tags work with the corrected path.

## 0.1.0-alpha.3

### Fixed

- Automatic update timers now load correctly in systemd. The updater uses its explicit
  installation paths without an unnecessary working-directory setting.

### Added

- Ask Palmagent to plan or apply an update across its package and operator plugins.
  Compatible plugins stay installed; required plugin changes are checked before
  the service package is replaced. Completion verifies the running version and health.
- Opt into automatic updates through plugin settings. Background checks follow the
  saved channel within the current compatibility line, defer during active work, and
  pause retries after an installation failure. Automatic updates are off by default.

- Palmagent plugins share persistent preferences in `~/.palmagent/config.json`. Ask the
  plugin to view settings or choose Stable/Preview; the choice survives conversations,
  plugin updates, and service reinstall. Existing installation channel preferences migrate
  without overriding a saved user choice. Invalid settings are preserved for diagnosis.

- Choose Stable (default) or opt into Preview for CLI updates. The choice is saved,
  exact release targets are supported, and updates refuse downgrades or prereleases
  on Stable. See the [channel guide](.harness/skills/release/references/channels-and-updates.md#npm-channels).
- Operator plugins check that the CLI shares their `x.x.x` version, including prereleases,
  before running host operations. Plugin installation uses each platform's native manager.

### Changed

- Prereleases publish to npm `next` after GitHub Release publication and automated validation,
  without a second approval. Stable releases retain the `npm-latest` reviewer gate. Existing
  tags keep their original publication checks; see the [release runbook](.harness/skills/release/references/automation.md#protected-npm-publication).

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
