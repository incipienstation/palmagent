import { useMemo } from "react";
import type { CreateTaskRequest, MessageAction, SubmitMessage } from "@palmagent/shared";
import type { CreateTerminalRequest } from "@palmagent/shared/terminals";
import { api, setOnUnauthorized } from "../api";

/** Feature use cases consumed by views; transport details remain in api-client. */
export function useTaskOperations(taskId: string) {
  return useMemo(() => ({
    handoff: () => api.handoff(taskId),
    messageAction: (messageId: string, input: MessageAction) => api.messageAction(taskId, messageId, input),
    submitMessage: (input: SubmitMessage) => api.submitMessage(taskId, input),
    getTask: () => api.getTask(taskId),
    cancel: () => api.cancel(taskId),
    resumeQueue: () => api.resumeQueue(taskId),
    answer: (input: Parameters<typeof api.answer>[1]) => api.answer(taskId, input),
    approve: (input: Parameters<typeof api.approve>[1]) => api.approve(taskId, input),
    accountLimits: () => api.getAccountLimits(taskId),
  }), [taskId]);
}

export function useDispatchOperations() {
  return useMemo(() => ({ createTask: (input: CreateTaskRequest) => api.createTask(input) }), []);
}

export function useRepositoryBrowserOperations() {
  return useMemo(() => ({
    discover: (refresh?: boolean) => api.discoverRepos(refresh),
    validatePath: (path: string) => api.validateRepoPath(path),
    listDirectory: (path?: string) => api.listFs(path),
  }), []);
}

export function useTerminalOperations() {
  return useMemo(() => ({
    list: (query?: { taskId?: string; repoId?: string }) => api.terminals.list(query),
    create: (input: CreateTerminalRequest) => api.terminals.create(input),
    rename: (id: string, title: string) => api.terminals.rename(id, title),
    terminate: (id: string) => api.terminals.terminate(id),
    ticket: (id: string) => api.terminals.ticket(id),
  }), []);
}

export function useAuthOperations() {
  return useMemo(() => ({
    setUnauthorizedHandler: (handler: (() => void) | null) => setOnUnauthorized(handler),
    me: () => api.auth.me(),
    loginOptions: () => api.auth.loginOptions(),
    loginVerify: (response: Parameters<typeof api.auth.loginVerify>[0]) => api.auth.loginVerify(response),
    registerOptions: (token: string) => api.auth.registerOptions(token),
    registerVerify: (response: Parameters<typeof api.auth.registerVerify>[0], label?: string) => api.auth.registerVerify(response, label),
  }), []);
}
