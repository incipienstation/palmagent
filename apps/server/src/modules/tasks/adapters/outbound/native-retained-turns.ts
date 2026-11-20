import { NativeTaskRecords } from "./native-task-records.js";
import { NativeAttachmentIndex } from "./native-attachment-index.js";
import { taskToRow } from "./sqlite-tasks.js";
import type { AgentEvent, PushSubscriptionJson, TaskState } from "@palmagent/shared";
import type { TaskEventBatches, AssignedEvent, BatchProjection, SessionImport, ProviderLine } from "../../application/ports/outbound/event-batches.js";
import { NativeTaskMetadata } from "./native-task-metadata.js";
import { NativeCommandChannel } from "../../../../platform/ipc/native-command-channel.js";
import { MessageConflict } from "../../domain/message-policy.js";
import { ApplicationError } from "../../../../kernel/errors.js";
import type { ActionEffect, ActionRequest, SharedObservation, QueueOperation, QueueReceipt, RecoveryResult, RetainedTurns, TurnTicket, TurnDisposition, TurnObservation } from "../../application/ports/outbound/retained-turns.js";

/** The child inherits the coordinator's locked open file description. Keeping
 * this handoff synchronous prevents provider callbacks from running before commit. */
export class NativeRetainedTurns implements RetainedTurns, TaskEventBatches {
  readonly records = new NativeTaskRecords((taskId, query) => this.command({ kind: "records", taskId, query }),
    work => this.attachments.transaction(work, true));
  readonly attachments: NativeAttachmentIndex;
  readonly metadata = new NativeTaskMetadata(changes => this.command({ kind: "lifecycle", changes }) as number | null);
  private readonly channel: NativeCommandChannel;
  constructor(binary: string, database: string, lease: number, onFailure?: () => void) {
    this.attachments = new NativeAttachmentIndex(database, body => this.command(body));
    this.channel = new NativeCommandChannel(binary, ["task-command", database], lease, onFailure);
  }
  creation(id: string, repo: string, agent: string, prompt: string) {
    return this.command({kind: "creation", id, repo, agent, prompt}) as boolean | null;
  }
  taskAction(id: string, request: ActionRequest) {
    const reply = this.command({kind: "taskAction", id, request}) as {effect: ActionEffect; conflict?: string};
    if (reply.conflict) throw new ApplicationError("conflict", reply.conflict);
    return reply.effect;
  }
  sharedSnapshot(taskId: string, observation: SharedObservation) {
    return this.command({kind: "sharedSnapshot", taskId, observation}) as ReturnType<RetainedTurns["sharedSnapshot"]>;
  }
  removeSpace(id: string): void { this.command({ kind: "removeSpace", id }); }
  upsertPushSub(sub: PushSubscriptionJson, now: number): void {
    this.command({kind: "subscription", operation: {kind: "save", endpoint: sub.endpoint, body: JSON.stringify(sub), now}});
  }
  deletePushSub(endpoint: string): void { this.command({kind: "subscription", operation: {kind: "delete", endpoint}}); }
  listPushSubs(): PushSubscriptionJson[] {
    return (this.command({kind: "subscription", operation: {kind: "list"}}) as string[]).map(body => JSON.parse(body));
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

  transaction<T>(work: () => T): T { return this.attachments.transaction(work); }

  create<T>(task: TaskState, prepareFiles: () => T): T {
    return this.attachments.transaction(() => {
      const row = taskToRow(task);
      this.command({ kind: "create", row: JSON.stringify(row, (_key, value) => typeof value === "string" ? Buffer.from(value).toString("utf8") : value) });
      return prepareFiles();
    });
  }

  append(taskId: string, events: AgentEvent[], rawSeq: number | undefined, project: (rows: AssignedEvent[]) => BatchProjection, session?: SessionImport, provider?: ProviderLine) {
    const records = events.map(event => ({ kind: event.kind, payload: JSON.stringify(event.payload ?? null), ts: event.ts }));
    const assigned = this.command({ kind: "append", taskId, events: records, rawSeq, session, provider, now: Date.now() },
      rows => project(rows as AssignedEvent[])) as AssignedEvent[];
    return assigned.map(({ id, seq }, i) => ({ id, seq, event: events[i] }));
  }

  track(taskId: string, runId: string | null, baseline: number) {
    return this.command({ kind: "track", taskId, runId, baseline }) as TurnTicket;
  }
  observe(ticket: TurnTicket, event: TurnObservation, expectedSession?: string, observedSession?: string, rawSeq?: number) {
    return this.command({ kind: "observe", ticket, event, expectedSession, observedSession, rawSeq }) as TurnDisposition;
  }
  end(ticket: TurnTicket, compacting = false, steerRestart = false) {
    return this.command({ kind: "end", ticket, compacting, steerRestart }) as ReturnType<RetainedTurns["end"]>;
  }

  queue(taskId: string, operation: QueueOperation): QueueReceipt {
    const reply = this.command({ kind: "queue", taskId, operation: JSON.stringify(operation) }) as {
      conflict?: string; changed: boolean; runId: string | null; claimed?: string;
    };
    if (reply.conflict) throw new MessageConflict(reply.conflict);
    return { changed: reply.changed, runId: reply.runId,
      claimed: reply.claimed ? JSON.parse(reply.claimed) : undefined };
  }

  start(taskId: string, runId: string, now: number): void {
    this.command({ kind: "start", taskId, runId, now });
  }
}
