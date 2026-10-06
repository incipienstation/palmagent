/** Expected application failure. Transport adapters choose how its code is represented. */
export type ApplicationErrorCode =
  | "bad_request" | "unauthorized" | "forbidden" | "not_found" | "conflict" | "gone"
  | "too_many_requests" | "payload_too_large" | "unsupported_media_type"
  | "service_unavailable" | "insufficient_storage";

export class ApplicationError extends Error {
  constructor(readonly code: ApplicationErrorCode, message: string) {
    super(message);
    this.name = "ApplicationError";
  }
}
