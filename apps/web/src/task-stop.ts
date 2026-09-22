import { api } from "./api";
import { cacheSession } from "./read-cache";
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
    if (["queued", "running", "awaiting_input", "awaiting_approval"].includes(actual.status)) {
      observeTaskActivity(actual);
      finishWhenStopped(taskId, stop.finish, actual.messageQueue?.runId ?? runId);
    } else stop.finish();
  } catch (error) {
    if (generation === cacheSession()) toast({ title: error instanceof Error ? error.message : String(error), variant: "destructive" });
    stop.finish();
  }
}
