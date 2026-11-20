import { toUSVString } from "node:util";
import { NativeAttachmentIndex } from "./native-attachment-index.js";
import { taskToRow } from "./sqlite-tasks.js";
import type { AgentEvent, TaskState } from "@palmagent/shared";
import type { TaskEventBatches, AssignedEvent, BatchProjection, SessionImport } from "../../application/ports/outbound/event-batches.js";
import { NativeTaskMetadata } from "./native-task-metadata.js";
import { NativeCommandChannel } from "../../../../platform/ipc/native-command-channel.js";
import type { MessageState } from "../../domain/models.js";
import { MessageConflict } from "../../domain/message-policy.js";
import type { QueueOperation, QueueReceipt, RecoveryResult, RetainedTurns, TurnTicket, TurnDisposition, TurnObservation } from "../../application/ports/outbound/retained-turns.js";

/** The child inherits the coordinator's locked open file description. Keeping
 * this handoff synchronous prevents provider callbacks from running before commit. */
export class NativeRetainedTurns implements RetainedTurns, TaskEventBatches {
  readonly attachments: NativeAttachmentIndex;
  readonly metadata = new NativeTaskMetadata(changes => this.command({ kind: "lifecycle", changes }) as number | null);
  private readonly channel: NativeCommandChannel;
  constructor(binary: string, database: string, lease: number) {
    this.attachments = new NativeAttachmentIndex(database, body => this.command(body));
    this.channel = new NativeCommandChannel(binary, ["task-command", database], lease);
  }
  close(): Promise<void> { this.attachments.isOpen = false; return this.channel.close(); }

  private command(body: object, project?: (rows: unknown) => object): unknown {
    const reply = this.channel.request(body, project) as { ok: boolean; value?: unknown; error?: string };
    if (!reply.ok) throw new Error(reply.error ?? "Native Task command failed");
    return reply.value;
  }

  recover(live: string[], reattach: (taskId: string) => void, now: number): RecoveryResult {
    const planned = this.command({ kind: "plan", live });
    if (!Array.isArray(planned) || !planned.every(id => typeof id === "string")) throw new Error("Invalid native recovery plan");
    for (const id of planned) reattach(id);
    const result = this.command({ kind: "recover", attached: planned, now }) as RecoveryResult;
    if (!Array.isArray(result.reattached) || !Array.isArray(result.recovered)) throw new Error("Invalid native recovery receipt");
    return result;
  }

  create<T>(task: TaskState, prepareFiles: () => T): T {
    return this.attachments.transaction(() => {
      const row = taskToRow(task);
      this.command({ kind: "create", row: JSON.stringify(row, (_key, value) =>
        typeof value === "string" ? toUSVString(value) : value) });
      return prepareFiles();
    });
  }

  append(taskId: string, events: AgentEvent[], rawSeq: number | undefined, project: (rows: AssignedEvent[]) => BatchProjection, session?: SessionImport) {
    const records = events.map(event => ({ kind: event.kind, payload: JSON.stringify(event.payload ?? null), ts: event.ts }));
    const assigned = this.command({ kind: "append", taskId, events: records, rawSeq, session, now: Date.now() },
      rows => project(rows as AssignedEvent[])) as AssignedEvent[];
    return assigned.map(({ id, seq }, i) => ({ id, seq, event: events[i] }));
  }

  track(taskId: string, runId: string | null, baseline: number) {
    return this.command({ kind: "track", taskId, runId, baseline }) as TurnTicket;
  }
  observe(ticket: TurnTicket, event: TurnObservation, expectedSession?: string, observedSession?: string, rawSeq?: number) {
    return this.command({ kind: "observe", ticket, event, expectedSession, observedSession, rawSeq }) as TurnDisposition;
  }
  end(ticket: TurnTicket) {
    return this.command({ kind: "end", ticket }) as ReturnType<RetainedTurns["end"]>;
  }

  queue(taskId: string, operation: QueueOperation, snapshot?: MessageState): QueueReceipt {
    const reply = this.command({ kind: "queue", taskId, operation: JSON.stringify(operation), snapshot: JSON.stringify(snapshot) }) as {
      conflict?: string; changed: boolean; runId: string | null; claimed?: string; state?: string;
    };
    if (reply.conflict) throw new MessageConflict(reply.conflict);
    return { changed: reply.changed, runId: reply.runId,
      claimed: reply.claimed ? JSON.parse(reply.claimed) : undefined,
      state: reply.state ? JSON.parse(reply.state) : undefined };
  }

  start(taskId: string, runId: string, now: number): void {
    this.command({ kind: "start", taskId, runId, now });
  }
}
