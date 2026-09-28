import { migrateLegacyEvent, type TaskState } from "@palmagent/shared";
import type { LogItem, TaskHistoryData } from "./hooks/useTaskStream";

function migrateCheckpointItems(items: LogItem[]): LogItem[] {
  return items.map(item => item.kind === "assistant_text" ? item : { ...item, event: migrateLegacyEvent(item.event) });
}
function migrateHistoryCheckpoint(data: TaskHistoryData): TaskHistoryData {
  return { ...data, pages: data.pages.map(page => ({ ...page, items: migrateCheckpointItems(page.items) })) };
}

// Deploy handoff snapshots from the previous client stored one flat transcript.
// Lift it into an InfiniteData page so an update can paint immediately and then
// continue from its durable history cursor.
export function restoredHistory(value: unknown): TaskHistoryData | undefined {
  if (!value || typeof value !== "object") return;
  const candidate = value as Partial<TaskHistoryData> & {
    items?: LogItem[]; lastSeq?: number; before?: number | null; task?: TaskState;
  };
  if (Array.isArray(candidate.pages) && Array.isArray(candidate.pageParams) && candidate.pages.length) {
    return migrateHistoryCheckpoint(candidate as TaskHistoryData);
  }
  if (!Array.isArray(candidate.items) || typeof candidate.lastSeq !== "number") return;
  return {
    pages: [{ items: migrateCheckpointItems(candidate.items), before: candidate.before ?? null, cursor: candidate.lastSeq, task: candidate.task }],
    pageParams: [null],
  };
}
