import type { CreateTerminalRequest, TerminalSession, TerminalCapabilities } from "./terminals.js";
// Public HTTP contracts live here so browser builds never import server code.
// The server's chained Hono routes are checked against this schema by typecheck.
import type { Hono } from "hono";
import type { ApplyGlobalResponse } from "hono/client";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { JSONParsed } from "hono/utils/types";
import type { z } from "zod";
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import type * as Request from "./requests.js";
import type { SubmitMessage, MessageAction, MessageQueue } from "./messages.js";
import type { AccountLimits } from "./account-limits.js";
import type { Repo, SessionHandoffResponse } from "./task.js";
import type * as Response from "./protocol.js";
import type { RepoSettingsChange, RepoSettingsStatus } from "./settings.js";
import type { UpdateAction, UpdateSettingsChange, UpdateSettingsStatus } from "./updates.js";

type Endpoint<I, O, S extends ContentfulStatusCode = 200> = { input: I; output: JSONParsed<O>; outputFormat: "json"; status: S };
type Json<T> = { json: T };
type Id = { param: { id: string } };
type Query<T> = { query: T };
type Ok = { ok: true };

export type ApiSchema = {
  "/api/terminals": {
    $get: Endpoint<Query<{ taskId?: string; repoId?: string }>, { terminals: TerminalSession[]; capabilities: TerminalCapabilities }>;
    $post: Endpoint<Json<CreateTerminalRequest>, { terminal: TerminalSession }, 201>;
  };
  "/api/terminals/:id": {
    $get: Endpoint<Id, { terminal: TerminalSession }>;
    $patch: Endpoint<Id & Json<{ title: string }>, { terminal: TerminalSession }>;
  };
  "/api/terminals/:id/terminate": { $post: Endpoint<Id, { terminal: TerminalSession }> };
  "/api/terminals/:id/attach-ticket": { $post: Endpoint<Id, { ticket: string; protocol: number }> };
  "/api/tasks": {
    $get: Endpoint<Query<z.input<typeof Request.TaskQuerySchema>>, Response.TasksResponse>;
    $post: Endpoint<Json<Request.CreateTaskRequest>, Response.TaskResponse, 201>;
  };
  "/api/tasks/:id": {
    $get: Endpoint<Id, Response.TaskResponse>;
    $patch: Endpoint<Id & Json<Request.RenameTaskRequest>, Response.TaskResponse>;
    $delete: Endpoint<Id, Response.TaskResponse>;
  };
  "/api/tasks/:id/account-limits": { $get: Endpoint<Id, AccountLimits> };
  "/api/tasks/:id/image": { $get: { input: Id & Query<{ path: string | string[] }>; output: Uint8Array<ArrayBuffer>; outputFormat: "body"; status: 200 } };
  "/api/tasks/:id/history": { $get: Endpoint<Id & Query<{ before: string | string[] }>, Response.TaskHistoryResponse> };
  "/api/tasks/:id/handoff": { $post: Endpoint<Id, SessionHandoffResponse> };
  "/api/tasks/:id/messages": { $post: Endpoint<Id & Json<SubmitMessage>, MessageQueue, 202> };
  "/api/tasks/:id/messages/:messageId": { $post: Endpoint<{ param: { id: string; messageId: string } } & Json<MessageAction>, MessageQueue> };
  "/api/tasks/:id/queue/resume": { $post: Endpoint<Id & Json<{}>, MessageQueue> };
  "/api/tasks/:id/followup": { $post: Endpoint<Id & Json<Request.FollowupRequest>, Response.TaskResponse, 202> };
  "/api/tasks/:id/steer": { $post: Endpoint<Id & Json<Request.SteerRequest>, Response.SteerResponse> };
  "/api/tasks/:id/approve": { $post: Endpoint<Id & Json<Request.ApproveRequest>, Response.TaskResponse> };
  "/api/tasks/:id/answer": { $post: Endpoint<Id & Json<Request.AnswerRequest>, Response.TaskResponse> };
  "/api/tasks/:id/stop": { $post: Endpoint<Id & Json<{}>, Response.TaskResponse> };
  "/api/tasks/:id/cancel": { $post: Endpoint<Id & Json<{}>, Response.TaskResponse> };
  "/api/repos": {
    $get: Endpoint<{}, Response.ReposResponse>;
    $post: Endpoint<Json<Request.CreateRepoRequest>, { repo: Repo }, 201>;
  };
  "/api/repos/:id": { $delete: Endpoint<Id, { repo: Repo }> };
  "/api/repos/discover": { $get: Endpoint<Query<z.input<typeof Request.DiscoverQuerySchema>>, Response.DiscoverReposResponse> };
  "/api/repos/validate": { $get: Endpoint<Query<z.input<typeof Request.PathQuerySchema>>, Response.ValidateRepoPathResponse> };
  "/api/fs/list": { $get: Endpoint<Query<z.input<typeof Request.PathQuerySchema>>, Response.FsListResponse> };
  "/api/usage": { $get: Endpoint<{}, Response.UsageResponse> };
  "/api/routines": {
    $get: Endpoint<{}, Response.RoutinesResponse>;
    $post: Endpoint<Json<Request.CreateRoutineRequest>, Response.RoutineResponse, 201>;
  };
  "/api/routines/:id": {
    $get: Endpoint<Id, Response.RoutineResponse>;
    $patch: Endpoint<Id & Json<Request.UpdateRoutineRequest>, Response.RoutineResponse>;
    $delete: Endpoint<Id, Response.RoutineResponse>;
  };
  "/api/routines/:id/run": { $post: Endpoint<Id, Response.RoutineResponse> };
  "/api/routines/:id/runs": { $get: Endpoint<Id, Response.RoutineRunsResponse> };
  "/api/settings/repos": {
    $get: Endpoint<{}, RepoSettingsStatus>;
    $patch: Endpoint<Json<RepoSettingsChange>, RepoSettingsStatus>;
  };
  "/api/settings/updates": {
    $get: Endpoint<{}, UpdateSettingsStatus>;
    $patch: Endpoint<Json<UpdateSettingsChange>, UpdateSettingsStatus>;
    $post: Endpoint<Json<UpdateAction>, UpdateSettingsStatus>;
  };
  "/api/auth/me": { $get: Endpoint<{}, Response.AuthMe> };
  "/api/auth/login/options": { $post: Endpoint<{}, PublicKeyCredentialRequestOptionsJSON> };
  "/api/auth/login/verify": { $post: Endpoint<Json<z.input<typeof Request.AuthenticationSchema>>, Ok> };
  "/api/auth/register/options": { $post: Endpoint<Json<z.input<typeof Request.RegisterOptionsSchema>>, PublicKeyCredentialCreationOptionsJSON> };
  "/api/auth/register/verify": { $post: Endpoint<Json<z.input<typeof Request.RegistrationSchema>>, Ok, 201> };
  "/api/auth/logout": { $post: Endpoint<{}, Ok> };
  "/api/auth/enroll-token": { $post: Endpoint<{}, Response.EnrollTokenResponse, 201> };
  "/api/push/key": { $get: Endpoint<{}, Response.PushKeyResponse> };
  "/api/push/subscribe": { $post: Endpoint<Json<Request.PushSubscribeRequest>, Ok, 201> };
  "/api/push/unsubscribe": { $post: Endpoint<Json<Request.PushUnsubscribeRequest>, Ok> };
};

export type ApiErrorResponse = { error: string; code?: string };
type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 415 | 500 | 503;
// Global middleware and onError responses are not inferred by Hono routes.
export type Api = ApplyGlobalResponse<Hono<{}, ApiSchema>, {
  [S in ErrorStatus]: { json: ApiErrorResponse };
}>;
