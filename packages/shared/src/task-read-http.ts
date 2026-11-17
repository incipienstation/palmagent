import { z } from "zod";

/** Owner-only configuration; the public listener contains only selected authenticated reads. */
export const TaskReadHttpSettingsSchema = z.object({
  port: z.number().int().min(0).max(65535),
  authEnabled: z.boolean(),
  cookieName: z.string().min(1).max(256).regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/),
  sessionTtlMs: z.number().int().positive().safe(),
  authOrigin: z.string(),
}).strict();
export type TaskReadHttpSettings = z.infer<typeof TaskReadHttpSettingsSchema>;
export const TaskReadHttpStatusSchema = z.object({ enabled: z.boolean(), port: z.number().int().min(1).max(65535).nullable() });
