import { isActiveTaskStatus } from "@palmagent/shared";
import { api } from "./api";
import { cacheSession } from "./query-lifecycle";
import { beginTaskStop, finishWhenStopped, observeTaskActivity } from "./task-activity";
import { toast } from "./components/ui/toaster";

export async function stopTaskTurn(taskId: string, runId?: string | null) {
  const stop = beginTaskStop(taskId);
  if (!stop) return;
  const generation = cacheSession();
  try {
    await stop.ready;
    if (generation !== cacheSession()) { stop.finish(); return; }
    if (stop.onStop) { await stop.onStop(); stop.finish(); return; }
    const actual = await api.stop(taskId);
    if (generation !== cacheSession()) { stop.finish(); return; }
    if (isActiveTaskStatus(actual.status)) observeTaskActivity(actual);
    // Keep the local Stop pending until the live task snapshot catches up, even
    // when the HTTP response already says a queued task is idle.
    finishWhenStopped(taskId, stop.finish, actual.messageQueue?.runId ?? runId);
  } catch (error) {
    if (generation === cacheSession()) toast({ title: error instanceof Error ? error.message : String(error), variant: "destructive" });
    stop.finish();
  }
}
