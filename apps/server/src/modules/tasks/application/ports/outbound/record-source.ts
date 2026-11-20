import type { AgentEvent } from "@palmagent/shared";

export interface RawRecord {
  id: number; seq: number; task_id: string; kind: AgentEvent["kind"]; payload_json: string;
  ts: number; agent: AgentEvent["agent"]; session_id: string | null;
}

export interface TaskRecordSource {
  snapshot<T>(work: () => T): T;
  item(taskId: string, key: number): { revision: number; body_json: string } | null;
  sequenceKeys(taskId: string, before: number | undefined, limit: number): { cursor: number; keys: number[] };
  cursor(taskId: string): number;
  pageStart(taskId: string, before: number, limit: number): number;
  events(taskId: string, from: number, through: number, compact: boolean, limit: number): RawRecord[];
}
