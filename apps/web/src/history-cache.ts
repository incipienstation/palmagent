import type { TaskState } from "@palmagent/shared";
import type { LogItem } from "./hooks/useTaskStream";
import { onCacheSessionReset } from "./read-cache";

export interface HistorySnapshot {
  items: LogItem[];
  lastSeq: number;
  before: number | null;
  task?: TaskState;
}

// Retain whole sessions, not truncated messages: the sequence cursor must always
// describe exactly the retained log. Oversized sessions simply reload their tail.
export class HistoryCache {
  private entries = new Map<string, { snapshot: HistorySnapshot; size: number; at: number }>();
  private size = 0;
  constructor(private readonly maxSize = 4_000_000, private readonly maxEntries = 5, private readonly now = Date.now) {}
  get(id: string): HistorySnapshot | undefined {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.remove(id);
    if (this.now() - entry.at > 5 * 60_000) return;
    this.entries.set(id, entry); this.size += entry.size;
    return entry.snapshot;
  }
  set(id: string, snapshot: HistorySnapshot): void {
    this.remove(id);
    const size = JSON.stringify(snapshot).length * 2;
    if (size > this.maxSize) return;
    this.entries.set(id, { snapshot, size, at: this.now() }); this.size += size;
    while (this.size > this.maxSize || this.entries.size > this.maxEntries) this.remove(this.entries.keys().next().value!);
  }
  private remove(id: string): void {
    this.size -= this.entries.get(id)?.size ?? 0;
    this.entries.delete(id);
  }
  clear(): void { this.entries.clear(); this.size = 0; }
}
export const historyCache = new HistoryCache();
onCacheSessionReset(() => historyCache.clear());
