import type { ConversationActivity, ConversationItem, ConversationPatch, LogItem } from "@palmagent/shared";
import type { TaskHistoryData } from "./hooks/useTaskStream";

export function conversationLogItems(items: ConversationItem[]): LogItem[] {
  return items.flatMap(item => item.type === "message" ? [item.item] : item.items);
}

export function retainedConversation(data: Pick<TaskHistoryData, "pages"> | undefined): ConversationItem[] | undefined {
  if (!data?.pages.some(page => page.transcript !== undefined)) return;
  const items = new Map<number, ConversationItem>();
  for (const page of data.pages) for (const item of page.transcript ?? []) {
    if ((items.get(item.key)?.revision ?? -1) <= item.revision) items.set(item.key, item);
  }
  return [...items.values()].sort((a, b) => a.key - b.key);
}

// A live phase marker can replace or remove an already loaded record. Apply it
// to its owning page, not just the newest page, and ignore unloaded old history.
export function mergeConversationChanges(data: TaskHistoryData | undefined, changes: ConversationPatch[], cursor: number,
  activity?: ConversationActivity): TaskHistoryData | undefined {
  if (!data?.pages.length) return data;
  const retained = retainedConversation(data) ?? [];
  const floor = retained[0]?.key ?? data.pages[0].before ?? 0;
  const pages = data.pages.map(page => ({ ...page, transcript: [...(page.transcript ?? [])] }));
  for (const patch of changes) {
    let owner = pages.findIndex(page => page.transcript.some(item => item.key === patch.key));
    const prior = owner < 0 ? undefined : pages[owner].transcript.find(item => item.key === patch.key);
    if (prior && prior.revision > patch.revision) continue;
    for (const page of pages) page.transcript = page.transcript.filter(item => item.key !== patch.key);
    if (!patch.item || (owner < 0 && patch.item.endSeq < floor)) continue;
    if (owner < 0) owner = pages.length - 1;
    pages[owner].transcript.push(patch.item);
  }
  for (const page of pages) {
    page.transcript.sort((a, b) => a.key - b.key);
    page.items = conversationLogItems(page.transcript);
  }
  const latest = pages[pages.length - 1];
  latest.cursor = Math.max(latest.cursor, cursor);
  if (activity !== undefined) latest.activity = activity;
  return { ...data, pages };
}
