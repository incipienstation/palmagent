---
name: dispatch
description: Connect a local Codex shared session to Palmagent, preview a standalone Codex or Claude Code session, or return a session previously handed off to a shell. Use when the user asks to continue this conversation in Palmagent.
---

# Continue this session in Palmagent

Use the installed `palmagent session dispatch` command on the Palmagent host under
its service account. For a session owned by a Codex app-server with a local control socket,
Palmagent connects to the same execution: the terminal can stay open and both clients
can send input. Standalone Codex and Claude Code sessions use saved-message preview
until their native writer exits. The user's dispatch request authorizes connecting
the identified session. Do not end or kill the current CLI automatically.

1. Read the [shared CLI bootstrap guidance](../.shared/bootstrap.md) for finding the
   matching installed CLI. Check `palmagent compatibility` for standalone execution
   ranges; shared-server capabilities are negotiated by dispatch itself.
   This skill needs an existing instance; do not install, update, or reconfigure one
   merely to make dispatch available.
2. Identify the current provider, exact native session ID, and original working
   directory. Codex exposes `CODEX_THREAD_ID`; Claude skill expansion supplies
   `${CLAUDE_SESSION_ID}`. Pass the ID explicitly when available. Never choose the
   newest transcript or another session by its title. If identity is unavailable,
   ask for the native session ID rather than guessing or scanning conversation text.
3. Run the applicable command, preserving the session's provider-home environment:

   ```bash
   palmagent session dispatch --agent codex --session-id "$CODEX_THREAD_ID" --cwd "<session-directory>"
   palmagent session dispatch --agent claude --session-id "${CLAUDE_SESSION_ID}" --cwd "<session-directory>"
   ```

   The CLI detects the native parent process through shell wrappers. Use `--wait-pid`
   only when the exact active native CLI PID is known. For a non-default instance,
   pass `--data-dir "<instance-state-directory>"` using its known installation binding.
   Local and service provider homes must match; do not copy credentials to fix a mismatch.
4. Report the returned task ID and connection result. When the command reports
   `Session connected`, follow-up is available in Palmagent without closing the terminal.
   Both clients share the existing session; Send now reaches its active turn.
   Closing either client does not transfer ownership. Do not tell the user to exit a connected CLI.
   When it reports `Session reconnecting`, shared ownership is retained. Report the
   connection error and wait for reconnection; do not ask the user to close the CLI.
   When it reports `Session queued`, explain that only saved-message preview is
   available and preserve any reported connection error. For this fallback only,
   follow-up becomes available after the local writer exits and synchronization succeeds.
   Do not describe a preview as an active connection.

A failed identity, directory, or transcript check leaves local ownership in place.
Keep the reported error and diagnose it within the requested scope. Do not edit
native transcripts or Palmagent's database to force a transfer through. Shared
clients must use the same app-server; never resume the thread in a second app-server
to bypass a failed connection. A disconnected shared session retains shared ownership
and reconnects without replaying unconfirmed input.
