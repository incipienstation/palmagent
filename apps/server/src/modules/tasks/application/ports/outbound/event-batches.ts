import type { AgentEvent } from "@palmagent/shared";
import type { EventRow } from "../../../domain/models.js";

export interface DisplayChange {
  key: number; start: number; end: number; revision: number; body: string | null; wire: string | null;
}
export interface BatchProjection {
  cursor: number; start: number; log: string; activity: string; changes: DisplayChange[];
  context?: { body: string | null };
  prs?: { evidence: string; body: string; first?: string; updatedAt?: number };
}
export interface AssignedEvent { id: number; seq: number; compact?: string | null }
export interface ImportMarker { length: number | null; hash: string | null }
export interface ImportChange { source: string; previous?: ImportMarker; next: ImportMarker }
export interface SessionImport { control?: string; changes: ImportChange[] }

export interface ProviderLine {
  independent: boolean; sessionId?: string; subtype?: string; requestId?: string; messageId?: string;
}

export interface TaskEventBatches {
  append(taskId: string, events: AgentEvent[], rawSeq: number | undefined,
    project: (assigned: AssignedEvent[]) => BatchProjection, session?: SessionImport, provider?: ProviderLine): EventRow[];
}
