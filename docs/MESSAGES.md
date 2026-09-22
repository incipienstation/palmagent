# Message delivery and recovery

Palmagent owns message ordering. Both agents share Send and Queue controls;
CLI capabilities never silently turn an explicit Send into a queued prompt.
The contract is defined in `packages/shared/src/messages.ts`.

## Ownership

`MessageController` owns the persisted queue, message IDs, settings snapshots,
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
Image bytes live in private files beside SQLite; see
[attachment storage and backup](../apps/web/README.md#sent-image-attachments).
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

Queue entries run individually in FIFO order. Stop or a failed run pauses the
queue without deleting entries. Resume is explicit. A server restart reattaches
surviving processes; missing runs remain interrupted with a paused queue.

Editing holds one waiting entry for 60 seconds, renewed every 20 seconds by the
open editor. Following entries cannot overtake it. Save checks both lease token
and content version, preserves its place, and releases the hold. Cancel keeps
the original prompt. When a disconnected editor's lease expires, the original
saved entry becomes eligible again. A late save fails instead of overwriting a
prompt that has already started; the browser keeps the edit draft visible.

A local CLI's ownership remains read-only. Queue dispatch checks ownership and
maintenance state again before starting. Ordinary chat input does not answer a
pending question or approval; those retain their separate controls.

## Verification

The controller tests cover FIFO, edits, version conflicts, pause/resume,
idempotency, ownership and uncertain delivery. Adapter contracts cover native
turn targeting, interruption sequencing, echoed acknowledgements and replay.
Lifecycle tests use deterministic external CLI processes and daemon restarts.
Browser tests cover long press, cancellation, keyboard/context menus, haptic
requests and draft-preserving queue edits. Actual hardware vibration and
provider-backed steering require separate live verification.
