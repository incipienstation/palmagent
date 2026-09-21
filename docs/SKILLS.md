# Selecting skills in messages

Type `/` at the beginning of a word in the composer, or tap the skill button, to
search the skills exposed by the selected agent. Pick a result with the arrow keys
and Enter, or tap it. Selection adds a removable chip; it does not send a message.
Enter selects while the menu is open, Escape dismisses it, and the normal send
shortcut applies after selection. You can add instructions or send just the skill.

One skill can be selected per message. The choice stays with the draft, queued
message, queue edit, and conversation history. Choosing another agent or Space
uses a separate skill draft. Skills from the distributed Palmagent plugin carry a
small Palmagent logo. Names and descriptions come from the installed agent;
Palmagent does not maintain a list of operator actions or special execution paths.

## Discovery and delivery

The authenticated `/api/skills` endpoint accepts a task ID, or a registered repo ID
and agent. It resolves the task's working directory and provider home internally;
the browser cannot supply arbitrary discovery paths. Opening the picker never sends
an agent prompt. Discovery failures are visible and retryable.

Codex discovery uses `skills/list`; Claude discovery uses its initialization command
catalogue, including invokable skills. Discovery suppresses Claude hooks and project
MCP connections. Skill visibility and installed plugin resolution remain with the
native CLI. A short, bounded server cache coalesces picker reads. The browser does
not persist the catalogue. The service checks selected IDs again on submission and
before execution, replacing client-supplied paths and descriptions with native data.
An unavailable selection stops delivery instead of becoming an ordinary prompt.
Retries of an already accepted message return its original receipt even if the skill
was removed afterward.

Codex receives native skill input items alongside the user's text; Claude receives
its qualified slash invocation, preserving native arguments and execution semantics.
Only references are stored, never copies of skill instructions. Selected repository
paths are remapped into an isolated worktree and checked again there. Draft and
history chips mean **selected**, not proof that the agent completed the skill.

New independent executions carry an explicit skill-input record, including an
empty array. This additive table keeps the strict v1 argument JSON readable by older
packages during rollback. A retained run without the record predates this capability:
sending a skill into it is rejected so its older parser cannot silently discard the
selection. Use a subsequent turn after the retained run finishes.

Onboarding and plugin installation are separate from this picker.
