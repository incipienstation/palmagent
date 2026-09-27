import type { Dispatch, SetStateAction } from "react";
import { CreateTaskSchema, type CreateTaskRequest } from "@palmagent/shared/requests";
import { useActionState } from "./action-state";
import { onCacheSessionReset } from "./query-lifecycle";

export type NewChatSubmission = {
  request: CreateTaskRequest & { clientRequestId: string };
  draft: string;
  status: "sending" | "unknown" | "rejected";
  error?: string;
  stop?: boolean;
};
const key = "dispatch:submission";
function restore(): NewChatSubmission | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) ?? "null");
    const request = CreateTaskSchema.safeParse(saved?.request);
    if (!request.success || !request.data.clientRequestId || typeof saved?.draft !== "string") return null;
    // A reload cannot tell whether the old POST finished. Keep the same request
    // ID and payload, and require an explicit status check or idempotent retry.
    return { request: { ...request.data, clientRequestId: request.data.clientRequestId }, draft: saved.draft,
      status: saved.status === "rejected" ? "rejected" : "unknown", stop: saved.stop === true,
      error: "Your first message has been preserved. Check its status or retry." };
  } catch { return null; }
}
onCacheSessionReset(() => { try { sessionStorage.removeItem(key); } catch { /* storage unavailable */ } });

export function useNewChatSubmission(): [NewChatSubmission | null, Dispatch<SetStateAction<NewChatSubmission | null>>] {
  const [value, set] = useActionState<NewChatSubmission | null>(key, restore);
  return [value, next => set(previous => {
    const result = typeof next === "function" ? next(previous) : next;
    try {
      if (result) sessionStorage.setItem(key, JSON.stringify(result));
      else sessionStorage.removeItem(key);
    } catch { /* The in-memory and controlled-update checkpoints remain usable. */ }
    return result;
  })];
}
