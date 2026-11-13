# Recovering a request after a Codex context switch

Some Codex context-window resets replace the model-visible conversation with only
repository and runtime instructions. If task recovery then fails, the agent can
acknowledge those instructions and finish without answering the user's request.
The native turn still reports a normal completion; it does not certify that the
user's task was completed.

`scripts/codex-context-continuity.mjs` is an optional host-side safeguard for this
specific failure. It uses Codex's synchronous lifecycle hooks, so it works with
native Codex sessions as well as sessions connected through Palmagent. It does not
change Palmagent's session ownership or automatically submit another turn.

## Behavior

- A `SessionStart` hook with source `compact` recognizes an empty replacement
  containing only setup instructions. It restores recent user and visible
  assistant messages before the next model request.
- Short follow-ups retain their preceding conversation. A private local ledger
  contains earlier user/visible assistant messages and shell/file action evidence.
  Recovery explicitly requires checking current state before repeating actions.
  Truncated user records must be read in full; required attachments must be
  recovered from the original task because the text ledger does not copy them.
- Normal summaries, preserved requests, unknown replacement formats, later user
  messages, subsequent turns, and interruptions are not recovery triggers.
- A `Stop` hook provides at most one continuation for an affected native turn if
  no restoration was recorded. A durable receipt prevents duplicate attempts
  after reconnecting. An unconfirmed attempt produces an explicit warning.
- Palmagent retains an explicit hook stop as an incomplete turn, even when Codex
  subsequently reports normal completion. It shows the reason and pauses queued
  work; reconnecting does not erase an already observed stop.
- Recovery does not evaluate arbitrary task success. It cannot repair a provider
  outage, guarantee model behavior, or prove that an external action succeeded.

The hooks read the session transcript and write only under
`$CODEX_HOME/palmagent-continuity/` (default `~/.codex/palmagent-continuity/`).
Each session keeps one replaceable conversation ledger and small recovery receipts;
directories use mode `0700` and files use `0600`. These files contain private
conversation data. Keep them outside repositories. Remove that session's directory
when retiring the session; do not delete receipts while recovery is active.

## Setup

This safeguard was tested with Codex 0.169.0. The transcript format is not a stable
public interface: rerun the native compatibility check when changing Codex versions.
Node.js 22 or later is required. Copy the script to a durable private location before
removing a development checkout. Prefer an immutable filename containing its SHA-256
so each script update changes the hook command and requires a new review.

Merge the following entries into the `hooks` object in `$CODEX_HOME/hooks.json`,
preserving existing hooks. Replace both example paths with the actual absolute Node
and script paths. Do not add `additionalContextLimit` to the `Stop` hook.

```json
{
  "hooks": {
    "SessionStart": [{
      "matcher": "^compact$",
      "hooks": [{
        "type": "command",
        "command": "'/absolute/path/to/node' '/absolute/path/to/continuity-SHA256.mjs'",
        "timeout": 10,
        "additionalContextLimit": 0
      }]
    }],
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "'/absolute/path/to/node' '/absolute/path/to/continuity-SHA256.mjs'",
        "timeout": 10
      }]
    }]
  }
}
```

Review and trust these two hooks in Codex's `/hooks` interface. Existing hooks and
managed restrictions still apply. Start or resume a session with the updated
configuration and confirm both hooks are enabled and trusted. For an app-server
integration, `hooks/list` exposes that state; configuration reload and trust updates
must target the actual server and provider home serving the session.

Installation does not establish protection for an already running turn. Palmagent
normally starts a separate stdio app-server for each run; listing hooks on Codex's
shared daemon does not verify those processes. Finish or explicitly stop existing
work before restarting it. Verify the installed script and trusted hooks from a
fresh process with the same provider home and working directory. Shared sessions
require verification against their owning server and loaded thread instead.

To disable the safeguard, disable or remove just these two hook entries. Existing
transcripts remain intact, and there is no database migration to undo.

## Validation

The ordinary regression suite uses synthetic transcripts, including cancellation,
duplicate attempts, missing restoration, long requests, and setup-only replacements:

```sh
node --test scripts/tests/codex-context-continuity.test.mjs
```

The native test starts the installed Codex with an isolated provider home and a
loopback model fixture. It makes no external model calls and uses no credentials.
It verifies restoration before the next model request after explicit and automatic
context resets, bounded Stop recovery, and an explicit recovery failure:

```sh
PALMAGENT_CODEX_BINARY="$(command -v codex)" \
  node --test scripts/tests/codex-context-continuity-native.test.mjs
```

See the official [Codex hooks reference](https://learn.chatgpt.com/docs/hooks) for
hook ordering, trust, interruption behavior, and supported output fields.
