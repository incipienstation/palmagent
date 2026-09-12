import type { Context } from "hono";
import type { z } from "zod";
import { HttpError } from "../service.js";

export function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    // Report fields and constraints, never echo submitted values.
    const issue = result.error.issues[0];
    throw new HttpError(400, `invalid request: ${issue.path.join(".") || "body"} (${issue.code})`);
  }
  return result.data;
}

export async function body<T extends z.ZodTypeAny>(c: Context, schema: T): Promise<z.output<T>> {
  const source = await c.req.text();
  let value: unknown;
  try { value = source ? JSON.parse(source) : {}; }
  catch { throw new HttpError(400, "invalid JSON body"); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "body must be a JSON object");
  }
  return parse(schema, value);
}
