# Using Palmagent

This guide covers the web app and operator plugin after installation. For plugin setup
and the host access boundary, start with the [README](../README.md).

## Choose a release channel

Use the Palmagent plugin in Claude Code or Codex. The plugin handles its internal
CLI installation and commands; users do not need to install or run the CLI directly.

**Stable** is the default for a new user. Ask Palmagent to install the service or
show your settings, and it uses your saved preference on subsequent requests.

<details>
<summary>Try Preview</summary>

Tell the Palmagent plugin: **“Use Preview for Palmagent.”** It saves the preference
and keeps it for future updates. Preview is available to everyone and includes alpha,
beta, and release-candidate versions. Saving this choice does not deploy a release;
ask Palmagent to update when ready. Preview does not grant access to a staging host.

</details>

Both plugins share your saved channel preference. It survives new conversations,
plugin/package updates, and service reinstalls; the plugin manages the setting.

Ask Palmagent to return to Stable to change the saved preference. An update that would
downgrade is refused; returning to an older release requires a separately planned rollback.
A missing Stable release never falls back to Preview.

## Routines

Ask the Palmagent plugin, for example, “Run the report script every weekday at 9”
or “Create a daily Codex review for this space.” The `routine` skill creates the
same routines shown in the app. It also supports inspecting history, changing
schedules, pausing, deleting, and explicitly running a routine now.

Choose **Agent task** for reasoning or **Script** for code execution without an AI call.
Scripts run through `/bin/sh` as the server account. Git spaces use a fresh worktree
from the configured base ref; commit referenced scripts first, because untracked files
and installed dependencies are not copied. Plain folders run in place. Worktrees and
generated files are retained; their locations appear in execution history. Removing a
routine removes its history but leaves those files on disk.

Scripts have a configurable timeout (default five minutes, maximum one hour), capture
up to 64 KiB of combined output, and record their exit status. Each routine can have
one running script; the server runs up to four scripts at once. Busy scheduled runs
are recorded as skipped. Use **Stop script** in the app or ask the plugin to stop a run. Scripts stop when the server stops or updates, and are not
retried automatically. Missed schedules do not catch up after a restart. All schedules
use the server timezone; the plugin checks it when interpreting natural-language times.

## Plugin skills

In the PWA, type `/` or tap the skill button to select an available skill for a message.
Palmagent plugin skills have a small Palmagent logo; other installed skills use the same
picker. See [selecting skills](SKILLS.md). Ask the plugin to manage routines, settings,
session handoff, updates, or installation; users do not need to run its CLI directly.

## Space search paths

In **Settings → Space search paths**, add or remove folders where Palmagent
should find Git repositories. These are folders on the server, shared across
devices. Changes take effect on the next search without a restart.

The installation owner can manage the same setting locally:

```bash
palmagent settings get
palmagent settings get repo-roots --json
palmagent settings add repo-roots /srv/repos /mnt/projects
palmagent settings remove repo-roots /srv/repos
palmagent settings set repo-roots /mnt/projects --dry-run
palmagent settings set repo-roots
palmagent settings reset repo-roots
```

Use `--data-dir <path>` for the server's custom installation directory.
`set` replaces the complete list; with no paths it disables automatic discovery
without removing registered spaces. `reset` restores `REPO_ROOTS` from
`install.env`, or the server environment for a manual installation. An unset
default disables discovery. Saved settings take precedence over those defaults.
For a manually launched server, run the CLI with the same data directory and
`REPO_ROOTS` environment when inspecting or restoring defaults.

All write commands support `--dry-run`, and `--json` returns effective
`repoRoots`, `defaults`, and `source`. Added paths must be readable directories;
use absolute paths or quote `~/...` to expand the current server owner's home.
Changes are stored privately in `<data-dir>/settings.json`. Run the CLI as the
same user as the server. The web controls require sign-in; they do not change
service configuration or require service-management privileges.

Automatic discovery searches up to four directory levels below each root and
skips hidden folders and nested repositories. Manual Space registration can
still use other paths; folder browsing includes the server user's home and the
configured roots.

## Sessions and working directories

The Tasks screen has a working-directory sidebar on desktop and a directory picker
on mobile. Isolated task worktrees appear as separate directories; selecting a
folder filters every status group and is remembered on that browser.

Open a task's **Resume in shell** panel after its turn finishes. **Release to shell**
pauses Palmagent control and provides a quoted native `codex resume` or `claude --resume`
command with the session ID, directory, provider home, instance binding, and selected model/effort.
Run it on the same host under the service account. The native CLI controls its own
interactive permission prompts. Open only one local writer for a session.

To send an active local session to Palmagent, use the **dispatch** plugin skill.
It registers the exact native session and shows saved messages as a read-only preview
while the CLI stays open. Keep working locally, or close that CLI to continue in Palmagent.
The task remains unavailable for follow-up until that CLI exits and the final
transcript synchronizes. Both directions retain the native session ID and working directory;
Palmagent stores normalized display events and a checked synchronization cursor.
It never copies credentials or rewrites the provider's transcript. Returning tasks
keep their Palmagent permission/model choices; newly imported tasks use Palmagent's
provider defaults. Select the next turn's settings in the task composer.

Transfers currently require Linux, a shared local provider home, and a native JSONL
transcript of at most 64 MiB. Preview waits for unfinished records to be saved.
Missing, rewritten, identity-mismatched, or still-incomplete transcripts after CLI exit
leave the transfer pending with an error. No turn starts automatically
when a transfer completes. Raw native commands cannot prevent another independently
started CLI from opening the same session.

Structured tool image outputs render in both output modes when they contain PNG,
JPEG, WebP, or GIF data (up to 5 MiB each, four images per event). Unsupported formats
remain a text notice. Arbitrary filesystem paths in tool output are not served.

Run `palmagent compatibility` to see supported agent CLI ranges. `palmagent doctor`
reports installed versions outside those ranges.

## Updates

Ask **“Check for Palmagent updates”** to see the target version and which plugins
need changing. Ask **“Update Palmagent”** to apply that plan. The CLI, server, web
app, and runner ship together. Older compatible operator plugins update through
their native managers, even when the app is already current.

Ask **“Turn on automatic updates”** to install eligible updates discovered when
you open or return to the app. Automatic updates are off by default and follow
your saved Stable/Preview channel. They stay within the current `x.x.x` version
line and refresh installed compatible plugins. On independent-execution installations, running, queued,
or waiting tasks continue through application updates.
A new compatibility line waits for a plugin-assisted update.
With the current compatibility rule, a new Stable patch also needs that flow;
automatic advancement currently applies to prereleases within the same version line.

Ask **“Show my update settings”** to check the preference, pending request, and last result,
or **“Turn off automatic updates”** to stop future attempts. An update already
applying is allowed to finish. Failed installations pause automatic retries until
a successful manual recovery.

In the web app, open **Settings → Updates** to see the running server version,
choose Stable or Preview, toggle automatic updates, and inspect the last check.
The app checks on connection and foreground return, reusing checks made within
15 minutes. **Check again** checks immediately. With automatic updates enabled,
an eligible release installs and the screen switches automatically. Plugin updates
also run when the app is current; start a new agent session to load new skills.
Managed installations retain their policy and scope. A native-manager failure
pauses retries and reports recovery information instead of claiming success. When disabled,
**Update** schedules the displayed version. There is no recurring update timer. Existing timers are retired
when the updated package is activated.

During a package update, the browser may briefly reconnect while independent agent
executions continue. Local CLI sessions remain externally owned. See [session lifecycle](SESSION-LIFECYCLE.md)
for execution, migration, and recovery details.

Linux package installations also provide persistent Task and Space shells in the
web app and through `palmagent terminal`. Shells have independent service lifetimes,
restore their screen after reconnecting, and retain their starting worktree until
they finish. See [shell access](terminals.md) for controls and installation requirements.

The first upgrade from a legacy runner installation waits for active work to finish;
source installations retain their idle guard. See [session lifecycle](SESSION-LIFECYCLE.md)
for migration and activation requirements.

After the server changes version, the app prepares the new screen and switches
at a quiet moment automatically. Drafts, attachments, open forms, and conversation
position are preserved per tab. An in-flight submission or text composition delays
the switch. **Update** also completes without a second refresh click, even with
automatic installation disabled. If saving the screen fails, the existing page
stays open with a retry option. An outdated app cannot submit changes to a different
server version. This protects the browser transition; it does not roll back package
or database changes.

Channel and update preferences are shared by the CLI and both operator plugins.
Changing them requires a signed-in session and a package installation whose owner
has non-interactive service-management access. Source builds show update status
without offering host update controls.
