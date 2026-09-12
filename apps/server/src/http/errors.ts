import type { ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { HttpError } from "../service.js";

export const handleError: ErrorHandler = (error, c) => {
  const expected = error instanceof HttpError || error instanceof HTTPException;
  const status = expected ? error.status : 500;
  if (!expected) console.error("HTTP request failed", error);
  return c.json({ error: expected ? error.message : "internal server error" }, status as ContentfulStatusCode);
};
