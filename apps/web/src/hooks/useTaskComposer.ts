import { gameDelivery } from "../games/play-events";
import { isActiveTaskStatus } from "@palmagent/shared";
import { useEffect, useRef } from "react";
import type { MessageQueue, PendingMessage, SubmitMessage, TaskState, AnswerRequest } from "@palmagent/shared";
import { useActionState } from "../action-state";
import { cacheSession } from "../query-lifecycle";
import { acceptMessageQueue, clearQueuePreview, beginTaskAction, useTaskActivity, isSendingAction, type QueuePreview, type TaskActionKind } from "../task-activity";
import { readUpdateSnapshot, useUpdateState } from "../update-state";
import { ApiError, DEFAULT_OPTION, DEFAULT_PERMISSION, PERMISSIONS } from "../api";
import { modelSelection, useAgentCatalog } from "../model-catalog";
import { useDraft, usePersistedString } from "./useDraft";
import { useTaskOperations } from "./remote-operations";
import { useImageAttachments } from "../components/Attachments";
import { useSkillDraft } from "../components/SkillPicker";
import { isWaitingMessage } from "../components/MessageDelivery";
import { toast } from "../components/ui/toaster";

function errMsg(error: unknown) { return error instanceof Error ? error.message : String(error); }

/** Owns message retries, edit leases, optimistic previews and draft rollback. */
export function useTaskComposer(taskId: string, task?: TaskState) {
  const taskOperations = useTaskOperations(taskId);
  const catalog = useAgentCatalog(task?.agent ?? "codex");
  // Per-task draft, persisted so a deploy refresh never drops an unsent steer/follow-up.
  const [compose, setCompose] = useDraft(`draft:compose:${taskId}`);
  const [skills, setSkills] = useSkillDraft(`draft:skills:${taskId}`);
  const [editSkills, setEditSkills] = useSkillDraft(`draft:queue-skills:${taskId}`);
  // The compose selectors mirror the task's live model/effort (DEFAULT_OPTION =
  // the agent's own default). They re-sync whenever the task's setting changes —
  // e.g. after a steer persists a new one — instead of resetting to "default"
  // each turn. Changes are captured by queued messages or the next idle Send;
  // an active Send keeps the current run settings.
  const keepRestoredSelectors = useRef(readUpdateSnapshot(`task:${taskId}:model`) !== undefined);
  const selectorVersion = useRef<string>(undefined);
  const [savedModel, saveModel] = useUpdateState(`task:${taskId}:model`, task?.model ?? DEFAULT_OPTION);
  const [savedEffort, setEffort] = useUpdateState(`task:${taskId}:effort`, task?.effort ?? DEFAULT_OPTION);
  const { model, effort, setModel } = modelSelection(catalog, savedModel, savedEffort, saveModel, setEffort);
  // Permission has no DEFAULT_OPTION (always a concrete value); clamp the task's
  // stored value to a valid option for its agent (a legacy value shows the agent
  // default in the picker). A change applies to the next turn, like model/effort.
  const [permission, setPermission] = useUpdateState<string>(`task:${taskId}:permission`, "");
  useEffect(() => {
    if (!task) return;
    const version = JSON.stringify([taskId, task.model, task.effort, task.permission, task.agent]);
    if (version === selectorVersion.current) return;
    selectorVersion.current = version;
    if (keepRestoredSelectors.current) { keepRestoredSelectors.current = false; return; }
    saveModel(task?.model ?? DEFAULT_OPTION);
    setEffort(task?.effort ?? DEFAULT_OPTION);
    const agent = task?.agent;
    const perm = task?.permission;
    if (agent) {
      const valid = !!perm && PERMISSIONS[agent].some((p) => p.value === perm);
      setPermission(valid ? (perm as string) : DEFAULT_PERMISSION[agent]);
    }
  }, [taskId, task?.model, task?.effort, task?.permission, task?.agent]);
  const activity = useTaskActivity(taskId);
  const busy = Boolean(activity.kind);
  const normalAtt = useImageAttachments((msg) => toast({ title: msg, variant: "destructive" }));
  const editAtt = useImageAttachments((msg) => toast({ title: msg, variant: "destructive" }), `queue-edit-images:${taskId}`);
  const [deliveryMode, setDeliveryMode] = usePersistedString<"send" | "queue">(`delivery:${taskId}`, "send");
  const [edit, setEdit] = useActionState<{ id: string; version: number; token: string; expired?: boolean } | null>(`queue-edit:${taskId}`, null);
  const [editText, setEditText] = useDraft(`draft:queue-edit:${taskId}`);
  const [submitted, setSubmitted] = useActionState<{ fingerprint: string; id: string; request: Omit<SubmitMessage, "clientMessageId"> } | null>(`message-request:${taskId}`, null);
  const queueOverride = activity.queue;
  const setQueueOverride = (value: MessageQueue) => acceptMessageQueue(taskId, value);
  const remoteQueue = task?.messageQueue;
  const confirmedQueue = queueOverride && queueOverride.revision > (remoteQueue?.revision ?? -1) ? queueOverride : remoteQueue;
  const queue = activity.preview?.apply(confirmedQueue ?? { revision: 0, paused: false, runId: null, messages: [] }) ?? confirmedQueue;
  const pendingDeliveries = queue?.messages.filter(m => !isWaitingMessage(m)) ?? [];
  const displayedQueue = queue && { ...queue, messages: queue.messages.filter(isWaitingMessage) };
  const resumeDisabled = !!queue?.messages.some(m => m.status === "unknown" || m.status === "sending");
  const att = edit ? editAtt : normalAtt;
  useEffect(() => {
    if (!edit || edit.expired) return;
    const renew = () => { void taskOperations.messageAction(edit.id, { action: "renew", token: edit.token }).then(setQueueOverride).catch(() => setEdit(current => current?.id === edit.id && current.token === edit.token ? { ...current, expired: true } : current)); };
    if (busy) return;
    renew(); const timer = setInterval(renew, 20_000);
    return () => clearInterval(timer);
  }, [taskId, edit?.id, edit?.token, edit?.expired, busy]);
  async function startEdit(message: PendingMessage) {
    const token = crypto.randomUUID();
    await act("acquireEdit", async () => {
      const q = await taskOperations.messageAction(message.id, { action: "edit", version: message.version, token });
      setQueueOverride(q); setEdit({ id: message.id, version: message.version, token });
      setEditText(message.text); setEditSkills(message.skills ?? []); editAtt.setImages(q.messages.find(m => m.id === message.id)?.images ?? []);
    });
  }
  async function endEdit(save: boolean) {
    if (!edit || busy || (save && (edit.expired || (!editText.trim() && !editSkills.length)))) return;
    const draft = edit;
    const text = editText || (editSkills.length ? "Use the selected skill." : "");
    const selectedSkills = editSkills;
    const images = editAtt.images;
    await act(save ? "saveEdit" : "releaseEdit", async () => {
      // The lease remains represented by the pending action until release is
      // acknowledged. Keep the draft and restore the editor on failure.
      setEdit(null);
      try {
        if (save || !draft.expired) setQueueOverride(await taskOperations.messageAction(draft.id, save
          ? { action: "save", token: draft.token, version: draft.version, text, images, skills: selectedSkills }
          : { action: "release", token: draft.token }));
        editAtt.clear(); if (save) { setEditText(""); setEditSkills([]); }
      } catch (error) { setEdit({ ...draft, expired: true }); throw error; }
    }, undefined, { id: draft.id, label: save ? "Saving…" : "Releasing edit…", apply: q => ({ ...q, messages: q.messages.map(m => m.id === draft.id
      ? { ...m, ...(save ? { text, images, skills: selectedSkills } : {}), editingUntil: undefined } : m) }) });
  }

  const localOwner = !!task?.sessionControl && task.sessionControl.owner !== "palmagent";
  const status = task?.status;
  const running = status === "running";
  const queueWaits = (status !== "idle" && status !== "failed") || queue?.paused || !!queue?.runId
    || queue?.messages.some(message => message.status !== "delivered" && message.status !== "cancelled");
  const placeholder = edit ? "Edit queued message…"
    : deliveryMode === "queue" && queueWaits ? "Queue a message for later…"
    : running ? "Guide the current task…"
    : "Message Palmagent…";
  const editedSettings = edit ? queue?.messages.find(message => message.id === edit.id)?.settings : undefined;
  const settingsReadOnly = edit
    ? "Settings are retained from the queued message."
    : running && deliveryMode === "send" ? "Messages sent now use the running turn's settings." : undefined;
  const displayedModel = settingsReadOnly ? (editedSettings?.model ?? task?.model) || DEFAULT_OPTION : model;
  const displayedEffort = settingsReadOnly ? (editedSettings?.effort ?? task?.effort) || DEFAULT_OPTION : effort;
  const awaiting = status === "awaiting_approval";
  const needsInput = status === "awaiting_input";
  const active = status !== undefined && isActiveTaskStatus(status);
  const answering = needsInput && !!task?.pendingInput;
  // `interrupted` is a flag on idle tasks, not a status, so idle covers resume.
  const composeMode: "steer" | "followup" | null = !task || localOwner || status === "archived" || status === "cancelled" ? null : running
    ? "steer"
    : status === "idle" || status === "failed" || deliveryMode === "queue"
      ? "followup"
      : null;

  async function send() {
    if (edit) { await endEdit(true); return; }
    const text = compose.trim() || (skills.length ? "Use the selected skill." : att.images.length ? att.images.some(image => image.video) ? "See the attached media." : "See the attached image(s)." : "");
    if (!text || !composeMode) return;
    const images = att.images.length ? att.images : undefined;
    // Send an override only when it differs from the task's current setting.
    // Picking "default" (DEFAULT_OPTION) sends "" — reset to the agent's default.
    const curModel = task?.model ?? DEFAULT_OPTION;
    const curEffort = task?.effort ?? DEFAULT_OPTION;
    const curPermission = task
      ? PERMISSIONS[task.agent].some((p) => p.value === task.permission)
        ? task.permission
        : DEFAULT_PERMISSION[task.agent]
      : permission;
    const override = {
      ...(model !== curModel ? { model: model === DEFAULT_OPTION ? "" : model } : {}),
      ...(effort !== curEffort ? { effort: effort === DEFAULT_OPTION ? "" : effort } : {}),
      ...(permission !== curPermission ? { permission } : {}),
    };
    const request = { mode: deliveryMode, text, images, ...(skills.length ? { skills } : {}), expectedRunId: confirmedQueue?.runId ?? null,
      ...(running && deliveryMode === "send" ? {} : { settings: override }) };
    const fingerprint = JSON.stringify({ mode: deliveryMode, text, images, skills, model, effort, permission });
    const id = submitted?.fingerprint === fingerprint ? submitted.id : crypto.randomUUID();
    const submission = submitted?.fingerprint === fingerprint ? submitted.request : request;
    const preview: PendingMessage = { id, version: 0, mode: deliveryMode, text, images, skills, status: deliveryMode === "queue" ? "queued" : "sending" };
    const originalDraft = compose;
    await act(deliveryMode === "queue" ? "enqueue" : "send", async () => {
      if (deliveryMode === "send") gameDelivery({ id, taskId, state: "sending" });
      setSubmitted({ fingerprint, id, request: submission });
      setCompose(""); setSkills([]); att.clear();
      try {
        setQueueOverride(await taskOperations.submitMessage({ ...submission, clientMessageId: id }));
        if (deliveryMode === "send") gameDelivery({ id, taskId, state: "sent" });
        setSubmitted(null); setDeliveryMode("send");
      } catch (error) {
        if (deliveryMode === "send") gameDelivery({ id, taskId, state: "failed" });
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) setSubmitted(null);
        setCompose(originalDraft); setSkills(skills); att.setImages(images ?? []);
        throw error;
      }
    }, undefined, { id, submission: true, label: deliveryMode === "queue" ? "Adding…" : "Sending…", apply: q => q.messages.some(m => m.id === id) ? q : { ...q, messages: [...q.messages, preview] } });
  }

  async function act(kind: TaskActionKind, fn: () => Promise<unknown>, after?: () => void, preview?: QueuePreview) {
    const generation = cacheSession();
    const finish = beginTaskAction(taskId, kind, preview);
    if (!finish) return;
    try {
      await fn();
      if (generation === cacheSession()) after?.();
    } catch (e) {
      if (generation !== cacheSession()) return;
      clearQueuePreview(taskId);
      toast({ title: errMsg(e), variant: "destructive" });
      // Re-read after version/lease conflicts or lost responses. Never replay a
      // send, or resurrect a queue entry already delivered by another client.
      if (preview || kind === "acquireEdit") {
        try { const actual = await taskOperations.getTask(); if (actual.messageQueue) setQueueOverride(actual.messageQueue); }
        catch { /* The stream will reconcile when connectivity returns. */ }
      }
    } finally { finish(); }
  }

  async function queueAction(message: PendingMessage, action: "send" | "delete") {
    await act(action === "send" ? "sendQueued" : "deleteQueued", async () => {
      if (action === "send") gameDelivery({ id: message.id, taskId, state: "sending" });
      try {
        setQueueOverride(await taskOperations.messageAction(message.id, action === "send"
          ? { action, version: message.version, expectedRunId: confirmedQueue?.runId ?? null }
          : { action, version: message.version }));
        if (action === "send") gameDelivery({ id: message.id, taskId, state: "sent" });
      } catch (error) { if (action === "send") gameDelivery({ id: message.id, taskId, state: "failed" }); throw error; }
    }, undefined, { id: message.id, label: "Sending…", apply: q => ({ ...q, messages: action === "delete"
      ? q.messages.filter(m => m.id !== message.id)
      : q.messages.map(m => m.id === message.id && m.status === "queued" ? { ...m, mode: "send", status: "sending" } : m) }) });
  }

  const sending = isSendingAction(activity.kind) || pendingDeliveries.some(m => m.status === "sending");
  const canStop = active || sending || activity.stopping;
  const hasDraft = !!compose.trim() || normalAtt.images.length > 0 || skills.length > 0;
  const composerHasDraft = edit
    ? !!editText.trim() || editAtt.images.length > 0 || editSkills.length > 0
    : hasDraft;
  // Preserve one primary action through submission and delayed Stop snapshots.
  const primaryAction = edit ? "save" : activity.stopping || sending || canStop && !composerHasDraft ? "stop" : "send";
  const canCancel = running || status === "queued";
  const canArchive = !localOwner && !active && status !== "archived";

  const cancel = () => act("cancel", () => taskOperations.cancel());
  const resume = (delivery = false) => act(delivery ? "resumeDelivery" : "resumeQueue", async () => setQueueOverride(await taskOperations.resumeQueue()));
  const answer = (request: AnswerRequest, skip: boolean) => act(skip ? "skipQuestion" : "answer", () => taskOperations.answer({
    ...request, answers: skip ? request.answers.map(a => ({ ...a, selected: [], notes: undefined })) : request.answers,
  }), () => toast({ title: "Answer sent", variant: "success" }));
  const approve = (decision: "approve" | "deny") => act(decision === "approve" ? "approve" : "deny", () => taskOperations.approve({ decision }));
  return { activity, busy, compose, setCompose, skills, setSkills, editSkills, setEditSkills, edit, editText, setEditText, att, deliveryMode, setDeliveryMode, confirmedQueue, queue, pendingDeliveries, displayedQueue, resumeDisabled, localOwner, status, running, placeholder, awaiting, answering, composeMode, settingsReadOnly, displayedModel, displayedEffort, setModel, setEffort, permission, setPermission, primaryAction, canCancel, canArchive, startEdit, endEdit, send, queueAction, cancel, resume, answer, approve };
}
