# Shell access

Open **Terminals** from navigation, choose a Space, and press **New terminal**.
Within a Task, choose **Open terminal** from Task actions. A Task shell starts in
its worktree; a Space shell starts in the repository directory.

Desktop shows the conversation and terminal together. Mobile switches between
them and provides Ctrl+C, Tab, Esc, and arrow keys above the safe area.
Choose **Control here** to type. Other attachments remain viewers; claiming control
in another browser or CLI immediately revokes the previous writer.

Returning to the conversation, closing a tab, losing connectivity, and updating
Palmagent leave the shell running. Reconnecting restores the current screen and
bounded scrollback, including an application's alternate screen. Reconnect begins
in view mode and never sends buffered keystrokes. **Terminate terminal** ends the
shell and its child processes.

The installation owner can also use:

```sh
palmagent terminal list
palmagent terminal create --repo <space-id>
palmagent terminal create --task <task-id> --title "Development"
palmagent terminal attach <terminal-id>
palmagent terminal rename <terminal-id> --title "Tests"
palmagent terminal terminate <terminal-id>
```

Use Ctrl+] to detach from the CLI. Attach requires a TTY and claims input control.
Add `--data-dir <directory>` for a non-default installation. Creation accepts a
`--request-id <uuid>` for retries that must return the same shell.

## Installation and scope

The public npm package remains **palmagent**. Its package dependencies supply
node-pty and the terminal emulators; no tmux, ttyd, separate terminal daemon package,
or extra user-managed process is required. The Linux package installer provisions
the host services and private IPC. Normal Node/npm and host setup prerequisites
still apply, including native-module build tools on targets without prebuilt binaries.

The first supported platform is Linux with systemd and an unprivileged installation
owner. Run the normal Palmagent setup/update flow to install its terminal services.
Source-mode installations and other OSes report the feature as unavailable.
Browser shell access requires enabled sign-in. Commands run with the installation
owner's host permissions in the owner's login shell.

Shells survive application restarts, not machine reboots or termination of their
own service. Screen state is bounded in memory and is not an audit log.
Cancellation or archival of a Task defers worktree removal while a terminal that
started there remains active. Moving a shell into another directory does not
transfer that retention claim. Removing a Space or uninstalling Palmagent requires
its active shells to finish. Existing native agent-session handoff is unchanged;
this feature opens independent general-purpose shells.

## Architecture

```mermaid
flowchart LR
  Browser["PWA / xterm.js"] <-->|authenticated WebSocket| Gateway["Palmagent web service"]
  Gateway <-->|private IPC| Host["Terminal Host: one per shell"]
  CLI["palmagent terminal attach"] <-->|private IPC| Host
  Host <--> PTY["PTY and login shell"]
  Host --> Screen["Headless emulator / snapshot"]
  Gateway --> Registry["Private terminal registry"]
  Host --> Registry
```

- Shared schemas own REST, attach tickets, input epochs, frame sequence numbers,
  screen dimensions, and capability discovery. Clients do not branch on the host OS.
- `TerminalDriver`, `TerminalSupervisor`, `LocalTransport`, and `ShellResolver`
  isolate platform behavior. `terminalPlatform` is the selection boundary. Future
  macOS or Windows support supplies its own supervision, IPC, shell discovery, and
  installation integration while reusing the registry, host protocol, service, and UI.
  They are extension points, not claims of current support.
- Linux uses node-pty, systemd template services, and owner-only Unix sockets.
  Terminals belong to their own resource-limited slice and use full control-group
  termination. They have no restart or dependency coupling to the web service.
- Each terminal reserves an idempotent registry entry before launch, pins its
  immutable package and Node runtime, and claims a single host process. An uncertain
  launch retains its reservation; reconciliation never silently creates a new shell.
  Updates check the terminal protocol and retained artifacts before activation.
- The host serializes PTY output, resize, snapshots, and control changes. It alone
  answers terminal queries. A writer epoch fences input and resizing from old
  controllers. Slow clients disconnect and restore from a fresh snapshot; PTY parsing
  uses pause/resume flow control.
- Browser upgrades independently enforce exact Origin, a live login session, and a
  short-lived single-use ticket sent in the first frame. No ticket is placed in URLs.
  Session revocation is checked on traffic and heartbeats. Clipboard escape sequences
  are not passed through. CLI access relies on installation ownership and private IPC.
- Worktree cleanup and terminal reservation share a SQLite write lock. Only a
  supervisor-confirmed stopped service releases retention; unknown state stays pinned.
  Browser disconnect and application shutdown only detach clients.

The current limits are 16 active terminals per installation, 8 attachments per
terminal, 2,000 scrollback lines, and bounded frames, socket buffers, and input rates.
Retained package artifacts are not garbage-collected by this feature.
