# Changelog

Notable changes for users and installation operators are documented here.
See the [changelog writing rules](.harness/skills/release/references/policy.md#changelog-writing-rules).
An entry does not mean a version has been published.

## Unreleased

### Added

- Select an available agent skill with `/` or the skill button in a message. Choices
  stay with drafts, queued messages and conversation history; Palmagent plugin skills
  carry a small Palmagent logo.

## 0.1.0-alpha.54

### Changed

- The operator plugins now own host-aware reverse proxy and HTTPS setup. The CLI manages
  application services only and reports its connection contract as JSON. Existing proxy
  files, certificates and renewal jobs survive updates and uninstall, including purge.
  Use the plugin to coordinate domain/port changes and ingress cleanup; see
  [migration guidance](docs/HOST-INGRESS.md).
- Runtime diagnosis and public HTTPS checks are separate. First-device enrollment is
  issued after the plugin verifies HTTPS; direct CLI users run `palmagent passkey` afterward.

### Security

- Authentication POST requests have an application-wide rate backstop in addition to
  the host ingress's per-client limits.

## 0.1.0-alpha.53

### Changed

- Terminals enable input automatically when available and show **Type here** only when needed. A compact status line and actions menu leave more room for shell output on mobile; read-only mode and reconnects preserve other screens' input.

## 0.1.0-alpha.52

### Added

- Open Mermaid diagrams in a fullscreen viewer with pan, pinch zoom, and keyboard controls.
  The expand button now opens fullscreen; a separate reset icon fits the diagram to its viewer.

## 0.1.0-alpha.51

### Added

- Mermaid diagrams support dragging to pan and pinching to zoom, with zoom and fit controls,
  keyboard navigation, and Ctrl/Command + wheel zoom. Diagrams initially fit their viewer.

## 0.1.0-alpha.50

### Fixed

- `palmagent doctor` now checks an execution service template with a valid instance name,
  avoiding a false unavailable-service report on healthy Linux installations.


## 0.1.0-alpha.49

### Added

- `palmagent terminal diagnose` and `palmagent doctor` verify a disposable shell through
  public HTTPS, including WebSocket input/output and restored screen state. Staging
  deployments require this check for packages that support it.

### Fixed

- Shells become ready only after their PTY and connection endpoint are initialized.
  Startup has a 30-second deadline with a clear failure reason; uncertain processes
  retain their reservation until termination is confirmed.

## 0.1.0-alpha.48

### Added

- Mermaid code blocks in messages now render as diagrams, adapt to light and dark themes,
  and keep their source available. Incomplete or invalid diagrams display their source.


## 0.1.0-alpha.47

### Fixed

- Application updates now provision host services and terminal WebSocket routing from the
  incoming package. Missing terminal services show a repair instruction instead of leaving
  shells indefinitely at “Starting”; existing requests recover after setup is repaired.
- Staging deployments recognize retained application releases and activate exact published
  versions without overwriting the package used by running shells or agent executions.

## 0.1.0-alpha.46

### Added

- Open persistent shells from a Task or Space in the web app, or use
  `palmagent terminal` to create, attach, rename, and terminate them. Linux package
  installations include the terminal runtime; no separate terminal server is needed.
- Shells survive browser disconnects and application updates, restore their screen
  on reconnect, and accept input from one controller at a time. Task worktrees remain
  available until their shells finish.

## 0.1.0-alpha.45

### Fixed

- Cmd/Ctrl + Enter now submits new tasks and messages, including the selected queue
  action or queued-message edit. Choose Enter to send in Settings on each device;
  Shift + Enter adds a new line, and IME composition does not submit a draft.

## 0.1.0-alpha.44

### Changed

- API routes that do not accept images now have a 1 MiB request body limit. Task creation,
  message submission and editing, follow-up, and steering retain their 48 MB limit.

## 0.1.0-alpha.43

### Changed

- Preferences, routine switches, session names, search paths, and queue edits respond
  immediately. Rapid preference changes are combined; failures restore confirmed state
  with a toast. Pending changes survive closing and reopening their screens.
- Messages and new tasks, routines, and repositories show progress as soon as submitted.
  Failed messages retain their drafts; queue conflicts reconcile with the server.
  Deletions disappear immediately while processing and return if they fail.

### Fixed

- Prevent duplicate actions while requests are pending and explain progress for task
  controls, shell handoff, and updates. A failed sign-out keeps the screen open with
  an error instead of reloading as though it succeeded.

## 0.1.0-alpha.42

### Changed

- Product maintenance update. See the [source changes](https://github.com/incipienstation/palmagent/compare/24d1ffc875dce72cfafc7ad4856788607158fd6f...5f3d7ea9c8c8a8290325dfd71e5cada6a347815b) for details.

## 0.1.0-alpha.41

### Changed

- After the first browser permission prompt, notification switches respond immediately
  to each click. Rapid changes are combined, the last selection wins, and failed
  changes restore the subscription state with a toast, even after Settings closes.

## 0.1.0-alpha.40

### Changed

- Push notifications switch on immediately after permission is granted, with an
  enabling indicator until registration finishes and recovery guidance if it fails.

## 0.1.0-alpha.39

### Fixed

- Keep repeated tool failures inside expandable Activity details in Compact and
  Default views. Run errors appear once per run, with earlier errors clearly
  marked after a follow-up and the full diagnostic record still available.

## 0.1.0-alpha.38

### Added

- Render images in agent replies with previews that fit the screen and open larger when tapped.
  Markdown supports web URLs and local PNG, JPEG, GIF, or WebP files up to 5 MB inside the task's
  working directory; unavailable images show a readable fallback and retry control.

## 0.1.0-alpha.37

### Changed

- Conversation history starts loading several screens before you reach older
  messages, reducing pauses while scrolling on slower connections. The loading
  distance adapts to viewport and keyboard size while keeping your place.

## 0.1.0-alpha.36

### Changed

- Toasts use compact, text-sized pills above bottom controls, with one message at
  a time and touch-following swipe dismissal. Longer errors wrap within the screen.

## 0.1.0-alpha.35

### Fixed

- Returning to recently visited conversations reuses loaded messages and fetches
  only missed events. Repeated repository, routine, and usage reads share a bounded
  memory cache that expires after changes, reconnection, or authentication changes.
- Authentication and API responses no longer fall back to persisted offline data
  from an earlier session. The app shell remains available offline.

## 0.1.0-alpha.34

### Fixed

- Keep input questions visible until answer delivery is confirmed, including after
  reconnecting, and show Codex questions with selectable or written answers.

### Changed

- Settings groups device preferences separately from installation controls, with visible
  appearance and output choices, dedicated Spaces and Updates screens, and fixed Back
  and Close actions. Folder drafts are preserved while moving between screens.

## 0.1.0-alpha.33

### Changed

- Palm Teal is now the primary brand color across actions, selection states, links,
  app icons, and browser chrome, with coordinated light and dark palettes.


## 0.1.0-alpha.32

### Changed

- Product maintenance update. See the [source changes](https://github.com/incipienstation/palmagent/compare/b088a735f0646e0aa31fb58989cb92a0f2c7a836...95c336c00a15a9bd9e2ed15dd00b780c08c9c574) for details.


## 0.1.0-alpha.31

### Fixed

- Local session dispatch now distinguishes invalid requests, conflicts, and maintenance
  failures; unexpected errors are logged without exposing internal details to the CLI.
- Preserve response headers supplied by HTTP middleware, including retry instructions.

## 0.1.0-alpha.30

### Changed

- Earlier conversation messages load automatically as you scroll up, including
  when compact mode hides a page's events. Your reading position stays in place;
  a retry button appears only if loading fails.

## 0.1.0-alpha.29


### Fixed

- Codex effort choices now follow the selected model, including Extra High, Max,
  and Ultra where supported. Unsupported saved efforts fall back to default in
  new tasks, follow-ups, and routines.

### Removed

- Retired GPT-5.4 and GPT-5.4 mini options are removed from model selectors.
  Saved form selections for these models fall back to default; task history is preserved.

## 0.1.0-alpha.28

### Changed

- Account limits above the composer use a compact, tappable summary. Reset times
  and model-specific allowances are available in the detail sheet; low allowances
  keep their reset countdown visible.
- App icons and the palm logo use monochrome colors to match the neutral interface.

## 0.1.0-alpha.27

### Changed

- Mobile navigation moves into a drawer with recent tasks, Spaces, Routines,
  Usage, and Settings. Task rows lead with the title and keep state indicators compact.
- Neutral light and dark surfaces, softer message bubbles, and consistent composer
  and sheet styling keep conversations and the next action in focus.

### Fixed

- Keep the Send/Queue menu open when input focus changes during a mobile long
  press, including from the collapsed composer.

## 0.1.0-alpha.26

### Fixed

- Long streamed replies keep the composer responsive, and collapsing tool output
  keeps the conversation at the row being read.
- Task snapshots reuse unchanged rows. Returning from a task restores the inbox's
  search, collapsed groups, and scroll position for each Space and search.

## 0.1.0-alpha.25

### Changed

- Search tasks by title or prompt within a Space, hide empty status sections, and
  collapse completed tasks. Task rows keep secondary configuration in Session details.
- Settings separates General, Spaces, and Updates into tabs. Navigation, history,
  settings actions, and toast dismissal have larger touch targets.

### Fixed

- The inbox shows a loading state until its first task snapshot arrives, without
  displaying a false empty list or zero task count.
- Scrolling transcripts no longer cancels a long press on the fixed composer.
- Routine history and Usage show read failures with retry actions instead of
  presenting failed history requests as an empty result.

## 0.1.0-alpha.24

### Fixed

- Touch long-press menus preserve composer focus so opening Send/Queue or queued-message
  actions does not dismiss the keyboard and close the menu before an option can be selected.
  Closing the mode menu also preserves focus when typing resumes during its exit animation.

## 0.1.0-alpha.23

### Fixed

- On touchscreens, releasing a long press keeps the Send/Queue selector and
  queued-message actions open so an option can be selected without sending the draft.

## 0.1.0-alpha.22

### Changed

- Task screens keep the title and status in one compact header. Tap the title
  for session configuration, pull requests, and shell handoff. Account allowance
  and reset countdowns now use aligned columns above the composer.

## 0.1.0-alpha.21

### Added

- Manage Space search folders from Settings or `palmagent settings`. Search
  paths are shared across devices, survive restarts, and apply without restarting
  the server. Clear the list to stop automatic discovery or restore installation
  defaults; registered spaces stay available.

## 0.1.0-alpha.20

### Fixed

- Screen updates recover when a mobile tab misses service-worker activation.
  Version reconciliation clears stale update banners, and stalled transitions
  show a recoverable failure instead of waiting indefinitely. Drafts and running
  agent sessions remain preserved.

### Changed

- Switch task spaces from a searchable mobile sheet or desktop sidebar. Short
  names, readable paths, and task counts make locations easier to identify;
  worktrees collapse into their own section, and long paths stay within the screen.

## 0.1.0-alpha.19

### Changed

- Package installations give each agent invocation its own execution service and
  retain the package and Node runtime it started with. Compatible automatic
  updates replace the web application while running and waiting agents continue;
  output and pending input survive the reconnect without starting another agent.
- Automatic updates install eligible releases discovered on app access without
  an additional Update or Refresh click. Failed application activation attempts
  to restore the previous web release and pauses retries for review.
- The first upgrade from a legacy runner still waits for its work to finish;
  subsequent independent executions no longer block application updates. Source
  installations retain their idle guard, and unreachable configured runners fail
  closed instead of falling back to web-owned processes.

## 0.1.0-alpha.18

### Changed

- Start tasks and send follow-ups from a compact mobile composer that expands
  when focused. Add photos or use the camera from the + menu, and adjust the
  agent, model, effort, and permissions in a single Configure sheet. Drafts,
  per-agent preferences, image attachments, and queued-message editing remain
  preserved across updates.


## 0.1.0-alpha.17

### Fixed

- Android notification status-bar icons now use the Palmagent logo silhouette
  instead of appearing as a solid white square.

### Changed

- Use one Send button for both agents: hold it to select Send or Queue, with
  haptic feedback on supported browsers. Hold a queued prompt to edit it, send
  it now, or remove it. Editing preserves its place and the ordinary draft.
- Queued messages survive server restarts and run individually in order. Stop
  and failures pause the queue without deleting prompts; unconfirmed delivery
  is held for review instead of being automatically repeated. Codex now uses
  App Server for messages sent during an active run.

## 0.1.0-alpha.16

### Fixed

- Task PR lists now require a successful `gh pr create` command and its returned
  PR URL. Links in file contents, test fixtures, searches, and ordinary messages
  no longer appear as PRs opened by the task. On upgrade, existing lists are
  rebuilt from retained creation events; entries without that evidence are
  removed from the list while conversation history is preserved. Unsupported
  shell scripts and other PR creation tools are not inferred from printed links.

## 0.1.0-alpha.15

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
