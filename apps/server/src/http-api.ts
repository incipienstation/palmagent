import type { ApplyGlobalResponse } from "hono/client";
import type { ApplicationErrorCode } from "./errors.js";
import type { createApp } from "./http/app.js";
import type { ApiErrorResponse } from "@palmagent/shared/http";

type ErrorStatus = {
  bad_request: 400;
  unauthorized: 401;
  forbidden: 403;
  not_found: 404;
  conflict: 409;
  gone: 410;
  payload_too_large: 413;
  unsupported_media_type: 415;
  too_many_requests: 429;
  service_unavailable: 503;
  insufficient_storage: 507;
}[ApplicationErrorCode];

type GlobalErrors = { [S in ErrorStatus]: { json: ApiErrorResponse } };

/** Hono RPC contract: inferred from the same composed route tree the server mounts. */
export type AppType = ApplyGlobalResponse<ReturnType<typeof createApp>, GlobalErrors>;
