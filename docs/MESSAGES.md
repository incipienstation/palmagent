# Message delivery and recovery

Palmagent owns message ordering. Both agents share Send and Queue controls;
CLI capabilities never silently turn an explicit Send into a queued prompt.
The contract is defined in `packages/shared/src/messages.ts`.

## Ownership

On daemon installations the [Rust Tasks worker](RUST-MIGRATION.md#tasks-ownership) commits
queue transitions and Task lifecycle changes under the API coordinator's lease. In the local
TypeScript implementation, `MessageController` owns the persisted queue, message IDs, settings snapshots,
edit holds and logical run IDs. `TaskService` owns admission, native-session
ownership, execution slots and task lifecycle. The adapters own CLI protocols.
`RunnerBackend` abstracts execution: package installations use independent execution
hosts, while source and legacy installations can use a daemon or in-process backend.
See [session lifecycle](SESSION-LIFECYCLE.md) for process ownership and durable replay.

A logical run may receive several Send messages. Queued messages each start a
separate run. Each run retains a dedicated process, including Codex App Server,
which closes after the terminal turn result. Claude
may interrupt and continue inside that process when it receives a Send. A
process exit without a terminal Codex result is a failure.

## Persistence and delivery

SQLite stores each task's versioned message-control state in `task_message_state`:
run identity, protocol, pause state and message records.
This is one atomic aggregate rather than separate run, attempt and command
tables. Task status and existing output events remain the lifecycle/transcript
records. Queue revisions travel in task snapshots; they do not add transcript
messages on every edit or lease renewal. Full snapshots restore missed updates.

Messages retain their IDs, original request fingerprints, settings and attachment references.
Attachment bytes live in private files beside SQLite; see
[attachment storage and backup](../apps/web/README.md#sent-attachments).
An identical client ID returns the accepted state; reuse with a different
request is rejected. Sending claims a message synchronously before adapter I/O.
Settings are captured per queued prompt; active Send does not change model or
permissions. A queued message promoted to Send uses the active run's settings.

Codex uses App Server `turn/steer` with its native active turn ID and waits for
the RPC response. Claude requests an interrupt, waits for the result, sends the
new user message and waits for the echoed message UUID. A successful stdin
write alone is not a delivery acknowledgement. The legacy exec adapter remains
available for reattaching processes started before this change.

A transport error or lost acknowledgement produces `unknown`, pauses automatic
queue execution, and never automatically resends the prompt. Replayed delivery
receipts can resolve it. Removing an unknown entry acknowledges uncertainty;
it does not undo a message already received by the agent. After inspecting the
conversation, the operator can explicitly resume the remaining queue.

## Queue and editing

Queue entries run individually in FIFO order. Stop or a failed run pauses pending
messages without deleting them. Resume is explicit while those messages remain;
sending another prompt does not resume them. A server restart reattaches surviving
processes; missing runs remain interrupted and their pending messages stay paused.

Pause expires when no pending messages remain. Stopping or failing with an empty
queue does not pause future submissions. Removing or confirming delivery of the
last pending message also clears the pause, including empty pauses saved by older
versions. Sending, rejected and unconfirmed entries count as pending; adding new
messages cannot bypass their protection.

Editing holds one waiting entry for 60 seconds, renewed every 20 seconds by the
open editor. Following entries cannot overtake it. Save checks both lease token
and content version, preserves its place, and releases the hold. Cancel keeps
the original prompt. When a disconnected editor's lease expires, the original
saved entry becomes eligible again. A late save fails instead of overwriting a
prompt that has already started; the browser keeps the edit draft visible.

A standalone local CLI session has a read-only preview until handoff. A connected
[shared Codex session](SESSION-LIFECYCLE.md#shared-native-sessions) accepts input from
both clients. Queue dispatch checks ownership and
maintenance state again before starting. Ordinary chat input does not answer a
pending question or approval; those retain their separate controls.

## Context compaction

Choose **Compact context** from the task menu or usage details, or enter `/compact`.
Palmagent resumes the same Claude or Codex session with its saved profile. The session
must be idle or failed, owned by Palmagent, and have no unresolved messages.

The compact endpoint checks the queue revision and saves a receipt for each request ID.
Retries and restarts reuse the existing operation. Completion requires a successful
provider result and a manual `compact_boundary` from Claude or a completed
`contextCompaction` item from Codex. The visible conversation and draft are preserved.

## Verification

The controller tests cover FIFO, edits, version conflicts, pause/resume,
idempotency, ownership and uncertain delivery. Adapter contracts cover native
turn targeting, interruption sequencing, echoed acknowledgements and replay.
Lifecycle tests use deterministic external CLI processes and daemon restarts.
Browser tests cover long press, cancellation, keyboard/context menus, haptic
requests and draft-preserving queue edits. Actual hardware vibration and
provider-backed steering require separate live verification.
