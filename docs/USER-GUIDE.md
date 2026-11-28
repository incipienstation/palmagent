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

## Spaces

On a phone, open **Tasks** and choose **Status** or **Space** below the list.
Both views show **Pinned** first in your saved pin order. Each task appears once.
Status groups the remaining tasks by state, starting with **Needs input** and
**Needs approval**. Each row shows the task title and Space. Space view groups
the remaining tasks by folder and puts requests you can answer first in each group.
Pinned and Space rows show a badge on the right when a task needs your response.
Open the row menu to view its pull requests.
Switching views keeps your search and filters. The app remembers your last view.

All groups start expanded. Select a heading to collapse or expand its tasks. The app
remembers your choice on this device. Search temporarily expands matching groups.

On desktop, **Needs you** and **Pinned** appear above the Space groups. Each Space heading stays in
view as you scroll its tasks. Use its folder or plus button to open the Space or start a
task there. Open **Spaces** to search by name or folder, enter a Space, or connect
another folder with **Add Space**.
Spaces with the same name show a short folder qualifier. Full folder paths and
**Terminals** are available in each Space's details.

A Space includes all of its Worktree tasks. Use **Filters** inside the Space to
narrow the list to a Worktree or status. Filtering changes the list, not the
execution folder for a new task. Back restores the previous list's search and
reading position.

Pull down on Tasks or Spaces to refresh their data in place. Search, filters, and
the current screen stay available; a failed refresh keeps the existing list.

## Start a chat

Open **New task**, check the **Space** above the composer, and send your first
message. Starting inside a Space selects it. From the global New task button, the last-used Space
is shown; without one, choose a Space explicitly. Use the same picker to add a
Space. Model, effort, permission, and optional Git worktree isolation are in the
composer settings.

Drafts are saved separately for each Space. Changing the target carries your text
and attachments; if that Space has a draft, choose which to keep. Skills stay saved
with their original Space, with a reminder to select Skills for the new target.

Your message appears immediately in the conversation, with **Stop** available while
creation finishes. If creation cannot be confirmed, use **Check status** or **Retry**
beside the message. Retry reconnects to the same creation attempt without starting a
duplicate chat. A rejected message offers **Edit message**, preserving its text and
attachments. Name the conversation afterward through its **⋮** menu.

Use **+ → Files** to attach documents, source files, or other files up to 256 MiB
each. A message can contain up to eight attachments within the shared upload limit.
Filenames appear in your draft and conversation; sent files can be downloaded later.
Claude and Codex receive the original files at local paths during the turn and use
their available tools to read them. File format support depends on those tools.

The total encoded attachment request must fit within 500 MiB. Base64 encoding
adds roughly one third to the original file size, leaving room for slightly less
than 375 MiB of original attachments per message. Larger batches need separate
messages. Existing reverse proxies must allow request bodies of
at least 524288000 bytes; a lower proxy limit can still reject an upload.

Use **+ → Videos** to attach an MP4, WebM, or MOV video up to 20 MiB. The browser
must be able to decode it. The original stays available for playback, and the agent
receives up to eight timestamped frames for visual analysis. Audio is not sent.

Conversations open with the latest messages and Trace activity summaries. Scroll
up to read older pages; your reading position stays in place as they arrive.
Expand an activity to see its steps, then open a step to read its input and output.
**Load more steps** loads another page; **Expand loaded steps** opens only the steps
already listed. New events and completion preserve your disclosure choices.
While work is active, the latest progress message wraps across lines beneath the
collapsed activity. That temporary preview disappears when the turn finishes; its
content remains available in the steps. An active Trace replaces the separate
**Working…** indicator. Individual tool failures stay on their steps.
When the provider identifies progress before the first text arrives, it streams
directly into Trace. Replies and text without an initial classification stay in
the conversation, even if later metadata calls them progress. Existing histories
use the same rule after their display records are rebuilt on upgrade; the original
execution records remain intact.
Very large messages and images offer a separate load button for their full content.

Select a file link in a reply to read the current working copy in the conversation.
References such as `src/app.ts:42` or `src/app.ts#L42` highlight the specified line.
The viewer opens UTF-8 text files up to 1 MiB inside the task’s working directory.
Close it to return to the link.

The chat uses one display style. Older Compact/Verbose preferences no longer change
it. Use **Task actions → Execution records** to inspect recorded events, including
lifecycle metadata that does not appear in the conversation. Records load in pages,
with large record bodies loaded in chunks. Closing the panel keeps your draft and
conversation position.

### Side questions in Codex

Choose **Task actions → Side chat**, or send `/btw your question`, to ask a
question using a separate copy of the current conversation. The main task keeps
running. Side chat opens beside the conversation on desktop and fills the view
on mobile. It uses a read-only workspace and does not continue the main task's goal.

**Back to main chat** hides the panel while keeping its conversation and draft.
Use **Resume side chat** in Task actions to return; a **New reply** indicator
appears when a response finishes while the panel is hidden. **Stop side response**
only stops the side response. **Add to draft** appends an answer to your main
draft for review and manual sending.

Use **Side chat actions → End side chat** to end the temporary conversation.
Side chats also end when the server restarts, their task closes, or they are left
unattended for 30 minutes. If a connection is lost, the open view retains its
received messages and offers a new side chat. Side chats are not saved in the
main conversation or the task list. They require a Codex version supporting
ephemeral thread forks.

## Space base branches

When registering a Git Space, leave **Base branch** blank to detect the remote's
current default branch. Palmagent prefers `origin`, or the sole remote if it has
another name. If that lookup is unavailable, it uses the cached remote default,
then the current checkout. Detection uses locally available commits; it does not
fetch branches. An explicit value overrides detection.

Open a Git Space and choose **Space details (…) → Base branch** to change its
starting point. You can also edit it under **Settings → Space settings**.
Enter a locally available branch or Git ref, such as `develop` or
`origin/develop`. The saved choice is preserved across restarts and registration.
Changes apply to future isolated tasks and routine runs. Existing tasks and the
original checkout stay unchanged. Regular chats without isolation run in the
original directory; plain folders have no base branch.

## Removing a Space

Open the Space, choose **Space details (…) → Remove Space**, and confirm.
Removal deletes its archived task history and routines and keeps the connected
folder on disk. Archive its tasks, close its terminals, and stop any running
scripts before removing it.

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
one running script; the installation runs up to four scripts at once. Busy scheduled runs
are recorded as skipped. Use **Stop script** in the app or ask the plugin to stop a run.
On native daemon installations, running scripts survive web restarts and application updates.
The independent application service also keeps script scheduling and result recording active
while the web is down. Source and legacy local runners stop scripts with the server;
updates wait for those scripts to finish. Scripts are not automatically rerun, and missed
schedules during scheduler downtime do not catch up. See the
[runtime lifecycle](DAEMON.md#updates-and-migration) for backend and migration details.
All schedules use the server timezone; the plugin checks it when interpreting natural-language times.

## Plugin skills

In the PWA, type `/` or tap the skill button to select an available skill for a message.
Palmagent plugin skills have a small Palmagent logo; other installed skills use the same
picker. See [selecting skills](SKILLS.md). Ask the plugin to manage routines, settings,
session handoff, updates, or installation; users do not need to run its CLI directly.

## Pin chats

Choose **Pin** from a chat's **⋮** menu in the task list or conversation. Pinned
chats appear above **Recent tasks** in navigation and first within each status
group in the task list. Search and Space filters still apply to the task list.

Drag a pinned chat to a new position in navigation, or open its **⋮** menu and
choose **Move up** or **Move down**. These menu actions also work with touch and
the keyboard.

Pins and their order are saved on the server and shared across devices. Their
order stays fixed as new messages arrive. Choose **Unpin** to return a chat to recent-activity
ordering; archiving a chat also removes its pin. Pinning does not start or stop
agent work.

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

The Tasks screen groups sessions by Space. Open a Space and use **Filters → Worktree**
to narrow its tasks to a working directory. Each Space remembers its own filters.

Open a task's **Resume in shell** panel after its turn finishes. **Release to shell**
pauses Palmagent control and provides a quoted native `codex resume` or `claude --resume`
command with the session ID, directory, provider home, instance binding, and selected model/effort.
Run it on the same host under the service account. The native CLI controls its own
interactive permission prompts. Open only one local writer for a session.

To connect a local session to Palmagent, use the **dispatch** plugin skill. A Codex
session whose app-server exposes a local control socket connects to the same native
session. Keep the local app open: its messages and execution state appear in Palmagent,
and **Send now** reaches the active turn. **Queue** waits for the turn to finish.
Only dispatched sessions are connected. Existing dispatched previews connect automatically
when their original server is available.

For connected sessions, **Show terminal command** opens another client on that same
server without releasing Palmagent control. Model and permission settings remain managed
by Codex. If the connection drops, Palmagent preserves the conversation and draft and
reconnects. An unconfirmed input is not automatically resent. **Stop** interrupts the
current turn while leaving the native server and other clients running.

Standalone Codex and Claude Code sessions without a shared connection retain saved-message
preview. Follow-up becomes available after their local writer exits and the final transcript
synchronizes. These transfers retain the native session ID and working directory, and require
Linux, a shared local provider home, and a native JSONL transcript. Transcript size
does not limit session synchronization; records are read incrementally.
Preview waits for unfinished records to be saved. Missing, rewritten, or identity-mismatched
transcripts leave the transfer pending with an error. No turn starts automatically when a
connection or transfer completes. Palmagent never copies credentials or rewrites the provider's
transcript. Raw resume commands can still open an independent writer; use the connected
session's terminal command to join its server.

Codex environment updates are retained as execution records and hidden from conversation
messages. Dispatched Codex sessions can display local raster images from their own generated-image
directory as well as the task directory. Image previews and original-image links require sign-in;
other sessions' generated images and unrelated provider files remain inaccessible.

Structured tool image outputs stay inside Trace. Expand a step to inspect its images.
PNG, JPEG, WebP, and GIF data are supported (up to 5 MiB each, four images per event).
Unsupported formats remain a text notice. Arbitrary filesystem paths in tool output are not served.

Run `palmagent compatibility` to see supported agent CLI ranges. `palmagent doctor`
reports installed versions outside those ranges.

## Agents and usage

Open **Agents** to see Codex and Claude Code installed on the Palmagent host. Each
agent has the same sections: installed and latest release versions, account
limits, and activity recorded by Palmagent. Existing Usage bookmarks still work.

Packaged Palmagent runs new Claude task turns through its bundled
[Claude Agent ACP adapter](https://github.com/agentclientprotocol/claude-agent-acp)
using ACP v1. It uses the host's installed `claude` executable, the task's selected
Claude account, and its working directory. The **Don't ask** permission mode, manual
context compaction, and legacy runner sockets use the native Claude integration.
Set `PALMAGENT_CLAUDE_TRANSPORT=native` on the execution host to use that integration
for subsequent turns. Source runs select ACP when `claude-agent-acp` is on the host's
`PATH`.

Packaged Palmagent uses its bundled Codex ACP bridge for ordinary Codex task turns.
It starts the installed `codex` in the selected account and workspace. The task's
sandbox applies with approval set to `never`. Shell-connected shared sessions,
Side Chat, manual compaction, slash commands and older workspace-with-network tasks
use the native integration. Set `PALMAGENT_CODEX_TRANSPORT=native` on the execution
host to select it for subsequent turns. Source runs use the workspace's pinned
`codex-acp` executable when it is on `PATH`.

**Update** runs the native CLI updater after confirmation and verifies the
installed version afterward. It requires Palmagent sign-in and a recognized
native installation. Package-manager and custom installations are updated on the
host with their own installer. Refreshing the screen only reads status. Updates
share the host operation lock with Palmagent updates; the last result survives a
server restart. An interrupted update is reported as unverified and is never
replayed automatically.

The latest published release may differ from the version selected by the CLI's
configured channel. Palmagent flags versions outside its tested adapter range.
CLI updates do not change Palmagent's own release channel or update preferences.

Account limits show remaining allowance and reset times for the host account,
shared with its other sessions. Task details show the account used by that task
using the same presentation. Reports refresh every five minutes; a passed reset
time or unavailable report does not imply a full allowance.

Palmagent activity covers its recorded tasks, not every native CLI session or an
account bill. Both agents use the same metric order; a dash means the CLI did not
report that metric, while an actual reported zero stays zero. Input totals include
cached input; cached input and reasoning output are subsets, not additional usage.

## Updates

Ask **“Check for Palmagent updates”** to see the target version and which plugins
need changing. Ask **“Update Palmagent”** to apply that plan. The CLI, server, web
app, native daemon, and execution hosts ship together. Older compatible operator
plugins update through their native managers, even when the app is already current.

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

The first upgrade from a legacy runner installation waits for active work to finish.
Source installations retain their idle guard.

After the server changes version, the app prepares the new screen and switches
at a quiet moment automatically. Drafts, attachments, open forms, and conversation
position are preserved per tab. An in-flight submission or text composition delays
the switch. **Update** also completes without a second refresh click, even with
automatic installation disabled. If saving the screen fails, the existing page
stays open with a retry option. An older tab can still start a Task or send a message when the
message protocol matches. With compatible turn controls it can also stop the expected run or
answer a pending question.
Refresh when the app asks before making other changes. Switching the browser version preserves
the installed package and database.

Channel and update preferences are shared by the CLI and both operator plugins.
Changing them requires a signed-in session and a package installation whose owner
has non-interactive service-management access. Source builds show update status
without offering host update controls.
