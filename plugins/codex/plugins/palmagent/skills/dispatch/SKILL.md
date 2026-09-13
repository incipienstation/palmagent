---
name: dispatch
description: Send the current local Claude Code or Codex session to an existing Palmagent instance, show it read-only while working locally, or return a session previously handed off to a shell. Use when the user asks to continue this conversation in Palmagent.
---

# Continue this session in Palmagent

Use the installed `palmagent session dispatch` command on the Palmagent host under
its service account. It immediately registers a read-only preview of saved messages;
Palmagent takes execution control only after this native CLI exits and its transcript
synchronizes. The user's dispatch request authorizes registration. Do not end or kill the current CLI automatically.

1. Read the [shared CLI bootstrap guidance](../.shared/bootstrap.md) for finding the
   matching installed CLI. Check `palmagent compatibility` for the provider CLI ranges.
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
4. Report the returned task ID and distinguish viewing from execution. The user can open
   the task immediately to view saved messages and continue working locally; closing the CLI
   is not required for viewing. If they want to continue execution in Palmagent, ask them
   to close this local CLI normally. Do not continue local work after they choose that
   handoff. A preview is not completed transfer: Palmagent enables follow-up only after
   process exit and successful synchronization.

A failed identity, directory, or transcript check leaves local ownership in place.
Keep the reported error and diagnose it within the requested scope. Do not edit
native transcripts or Palmagent's database to force a transfer through. Only one
native writer may use a session at a time, including after copying a resume command.
