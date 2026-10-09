import type { AssistantPhase } from "@palmagent/shared";
import type { LogItem } from "./hooks/useTaskStream";
import { failed, payload } from "./transcript";

// Transient notifications from the displayed conversation. Initial history is
// marked separately; repeated chunks of an existing reply are not announced.
type Notification = { taskId: string; initial?: boolean };
const listeners = new Set<(notification: Notification) => void>();
export function notifyConversation(taskId: string, initial = false) { listeners.forEach(listener => listener({ taskId, initial })); }
export function onConversationNotification(listener: (notification: Notification) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// Providers may label final prose immediately, classify it after streaming, or
// leave it unclassified until the successful turn result. Announce once per turn.
export function createFinalReplyObserver() {
  const messages = new Map<string | number, { text: boolean; phase?: AssistantPhase }>();
  let announced = false;
  return (item: LogItem): boolean => {
    const p = payload(item);
    if (item.kind === "status" && ["dispatch", "followup", "turn_started"].includes(String(p.subtype))) {
      messages.clear(); announced = false;
      return false;
    }
    let ready = false;
    if (item.kind === "assistant_text") {
      const key = item.messageId ?? item.key;
      const previous = messages.get(key);
      const message = { text: Boolean(item.text.trim()) || !!previous?.text, phase: item.phase ?? previous?.phase };
      messages.set(key, message);
      ready = message.text && message.phase === "final";
    } else if (item.kind === "status" && p.subtype === "assistant_message" && typeof p.messageId === "string"
      && (p.phase === "progress" || p.phase === "final")) {
      const text = messages.get(p.messageId)?.text ?? false;
      messages.set(p.messageId, { text, phase: p.phase });
      ready = text && p.phase === "final";
    } else if (item.kind === "result" && !failed(item)) {
      ready = (typeof p.result === "string" && Boolean(p.result.trim()))
        || [...messages.values()].some(message => message.text && message.phase !== "progress");
    }
    if (!ready || announced) return false;
    announced = true;
    return true;
  };
}
