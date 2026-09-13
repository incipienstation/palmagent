import type { Hub } from "./hub.js";

/** Task transitions wake a pending request. Time passing never does. */
export function bindUpdateActivity(hub: Hub, hasPending: () => boolean, resume: () => Promise<unknown>) {
  let running = false;
  let again = false;
  let closed = false;
  let wasIdle = false;
  async function wake() {
    if (closed) return;
    if (running) { again = true; return; }
    running = true;
    try {
      do {
        again = false;
        if (closed || !hasPending()) break;
        await resume();
      } while (again);
    } catch { /* A future access or task transition can reconcile unavailable state. */ }
    finally { running = false; }
  }
  const off = hub.onTasks((tasks) => {
    const idle = !tasks.some((task) => ["running", "queued", "awaiting_input", "awaiting_approval"].includes(task.status));
    if (idle && !wasIdle) void wake();
    wasIdle = idle;
  });
  return { wake, close() { closed = true; off(); } };
}
