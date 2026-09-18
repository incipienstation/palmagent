import type { MiddlewareHandler } from "hono";
import { validator } from "hono/validator";
import type { z } from "zod";
import { HttpError } from "../service.js";

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    // Report fields and constraints, never echo submitted values.
    const issue = result.error.issues[0];
    throw new HttpError(400, `invalid request: ${issue.path.join(".") || "body"} (${issue.code})`);
  }
  return result.data;
}

// Keep the established empty-body and Content-Type-independent JSON contract.
// Hono's JSON validator deliberately has different parsing semantics, so this
// adapter publishes the validated value through the same typed req.valid API.
export function jsonBody<T extends z.ZodTypeAny>(schema: T): MiddlewareHandler<{}, string, {
  in: { json: z.input<T> }; out: { json: z.output<T> };
}> {
  return async (c, next) => {
    const source = await c.req.text();
    let value: unknown;
    try { value = source ? JSON.parse(source) : {}; }
    catch { throw new HttpError(400, "invalid JSON body"); }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new HttpError(400, "body must be a JSON object");
    }
    c.req.addValidatedData("json", parse(schema, value));
    await next();
  };
}

export function query<T extends z.ZodTypeAny>(schema: T) {
  // Preserve the existing first-value behavior for repeated query parameters.
  return validator("query", (_value, c) => parse(schema, c.req.query()));
}

export function params<T extends z.ZodTypeAny>(schema: T) {
  return validator("param", (value) => parse(schema, value));
}
