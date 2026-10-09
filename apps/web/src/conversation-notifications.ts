// Transient notifications from the displayed conversation. Initial history is
// marked separately; repeated chunks of an existing reply are not announced.
type Notification = { taskId: string; initial?: boolean };
const listeners = new Set<(notification: Notification) => void>();
export function notifyConversation(taskId: string, initial = false) { listeners.forEach(listener => listener({ taskId, initial })); }
export function onConversationNotification(listener: (notification: Notification) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
