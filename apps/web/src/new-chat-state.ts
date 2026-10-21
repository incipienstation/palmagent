import type { Dispatch, SetStateAction } from "react";
import { CreateTaskSchema, type CreateTaskRequest } from "@palmagent/shared/requests";
import { useActionState } from "./action-state";
import { attachmentBlob, type DraftAttachment } from "./images";
import { readBrowserDraft, writeBrowserDraft } from "./update-state";
import { cacheSession, onCacheSessionReset } from "./query-lifecycle";

export type NewChatSubmission = {
  request: CreateTaskRequest & { clientRequestId: string };
  draft: string;
  status: "sending" | "unknown" | "rejected";
  error?: string;
  stop?: boolean;
};
export class SubmissionCheckpointError extends Error {}
const key = "dispatch:submission";
let restored: NewChatSubmission | null = null;
let checkpoint: string | undefined;
let pending: Promise<void> = Promise.resolve();

function decode(saved: NewChatSubmission | null): NewChatSubmission | null {
  const request = CreateTaskSchema.safeParse(saved?.request);
  if (!request.success || !request.data.clientRequestId || typeof saved?.draft !== "string") return null;
  const images = request.data.images?.map((image, index) => {
    const blob = saved.request.images?.[index] && attachmentBlob(saved.request.images[index]);
    return blob instanceof Blob ? { ...image, blob } as DraftAttachment : image;
  });
  return { request: { ...request.data, images, clientRequestId: request.data.clientRequestId }, draft: saved.draft,
    status: saved.status === "rejected" ? "rejected" : "unknown", stop: saved.stop === true,
    error: "Your first message has been preserved. Check its status or retry." };
}
export async function restoreNewChatSubmission(): Promise<void> {
  let saved;
  try { saved = JSON.parse(sessionStorage.getItem(key) ?? "null"); } catch { return; }
  if (typeof saved?.checkpoint === "string") {
    checkpoint = saved.checkpoint;
    restored = decode(await readBrowserDraft(checkpoint!) as NewChatSubmission | null);
  } else restored = decode(saved); // Migrate older JSON checkpoints on the next write.
}
function persist(value: NewChatSubmission | null): void {
  const id = checkpoint ??= crypto.randomUUID();
  const generation = cacheSession();
  if (!value) { try { sessionStorage.removeItem(key); } catch { /* unavailable */ } }
  pending = pending.catch(() => {}).then(async () => {
    if (!value) {
      await writeBrowserDraft(id, null);
      return;
    }
    if (generation !== cacheSession()) return;
    try {
      await writeBrowserDraft(id, value);
      if (generation !== cacheSession()) return;
      sessionStorage.setItem(key, JSON.stringify({ checkpoint: id }));
    } catch {
      if (generation !== cacheSession()) return;
      if (value.request.images?.some(attachmentBlob)) throw new SubmissionCheckpointError("Could not preserve the attached file. Free browser storage or remove the file and retry.");
      try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* In-memory checkpoint remains usable. */ }
    }
  });
  void pending.catch(() => {});
}
// Await durability before a new POST, so a reload retains both bytes and retry ID.
export const checkpointNewChatSubmission = () => pending;
onCacheSessionReset(() => { restored = null; persist(null); checkpoint = undefined; });

export function useNewChatSubmission(): [NewChatSubmission | null, Dispatch<SetStateAction<NewChatSubmission | null>>] {
  const [value, set] = useActionState<NewChatSubmission | null>(key, () => restored);
  return [value, next => set(previous => {
    const result = typeof next === "function" ? next(previous) : next;
    if (!result) restored = null;
    persist(result);
    return result;
  })];
}
