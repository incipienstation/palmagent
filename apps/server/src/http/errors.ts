import type { ApiErrorResponse } from "@palmagent/shared/http";
import type { ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ApplicationError, type ApplicationErrorCode } from "../errors.js";

const statusByCode: Record<ApplicationErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  gone: 410,
  payload_too_large: 413,
  unsupported_media_type: 415,
  too_many_requests: 429,
  service_unavailable: 503,
  insufficient_storage: 507,
};

export const handleError: ErrorHandler = (error, c) => {
  // A framework exception may carry a complete response, including protocol headers.
  if (error instanceof HTTPException && error.res) {
    const response = error.getResponse();
    return c.newResponse(response.body, response);
  }
  const expected = error instanceof ApplicationError || error instanceof HTTPException;
  const status = error instanceof ApplicationError ? statusByCode[error.code] : error instanceof HTTPException ? error.status : 500;
  if (!expected) console.error("HTTP request failed", error);
  return c.json({
    error: expected ? error.message : "internal server error",
    ...(error instanceof ApplicationError ? { code: error.code } : {}),
  } satisfies ApiErrorResponse, status as ContentfulStatusCode);
};
