import type { TaskRecordSource } from "../../application/ports/outbound/record-source.js";

export class NativeTaskRecords implements TaskRecordSource {
  constructor(private readonly command: (taskId: string, query: object) => unknown, readonly snapshot: TaskRecordSource["snapshot"]) {}
  item(taskId: string, key: number) {
    return this.command(taskId, {kind: "item", key}) as ReturnType<TaskRecordSource["item"]>;
  }
  sequenceKeys(taskId: string, before: number | undefined, limit: number) {
    return this.command(taskId, {kind: "sequenceKeys", before, limit}) as ReturnType<TaskRecordSource["sequenceKeys"]>;
  }
  cursor(taskId: string) { return this.command(taskId, {kind: "cursor"}) as number; }
  pageStart(taskId: string, before: number, limit: number) { return this.command(taskId, {kind: "pageStart", before, limit}) as number; }
  events(taskId: string, from: number, through: number, compact: boolean, limit: number) {
    return this.command(taskId, {kind: "events", from, through, compact, limit}) as ReturnType<TaskRecordSource["events"]>;
  }
}
