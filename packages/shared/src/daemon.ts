import { z } from "zod";

/** Rust supervisor wire contract. Product/execution storage remains owned by its existing modules. */
export const DAEMON_PROTOCOL = 1;
export const DaemonKindSchema = z.enum(["execution", "terminal", "routine", "web", "update"]);
const host = { kind: DaemonKindSchema, id: z.string().regex(/^[a-f0-9-]{1,64}$/) };
export const DaemonRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status") }).strict(),
  z.object({ action: z.literal("list"), after: z.string().max(96).regex(/^[a-zA-Z0-9-]*$/).optional() }).strict(),
  z.object({ action: z.literal("launch"), ...host }).strict(),
  z.object({ action: z.literal("inspect"), ...host }).strict(),
  z.object({ action: z.literal("terminate"), ...host }).strict(),
  z.object({ action: z.literal("restart-web") }).strict(),
  z.object({ action: z.literal("replace") }).strict(),
  z.object({ action: z.literal("start-update") }).strict(),
  z.object({ action: z.literal("start-application"), release: z.string().min(1) }).strict(),
  z.object({ action: z.literal("stop") }).strict(),
]);
export type DaemonRequest = z.infer<typeof DaemonRequestSchema>;
export const DaemonLifecycleSchema = z.object({
  phase: z.enum(["starting", "running", "ready", "stopping", "exited", "unknown"]),
  supervision: z.enum(["guarded", "orphaned", "unconfirmed", "ended"]),
  readiness: z.enum(["pending", "ready", "unsupported"]),
  createdAt: z.number(), startedAt: z.number().nullable(), readyAt: z.number().nullable(), finishedAt: z.number().nullable(),
  reason: z.string().nullable(), compacted: z.boolean(),
});
export const DaemonHostStateSchema = z.object({
  state: z.enum(["absent", "running", "exited", "lost", "unknown"]), alive: z.boolean(),
  lifecycle: DaemonLifecycleSchema.optional(),
}).passthrough();
export const DaemonStatusSchema = z.object({
  protocol: z.literal(DAEMON_PROTOCOL), version: z.string(), sourceCommit: z.string(),
  instance: z.string().min(1),
  pid: z.number().int().positive(), isolation: z.enum(["cgroup", "process-group"]),
  web: DaemonHostStateSchema.nullable(),
  applicationRuntime: z.literal(1).optional(),
  applicationRequired: z.boolean().optional(),
  application: DaemonHostStateSchema.nullable().optional(),
  inventory: z.object({ checkedAt: z.number().nullable(), scanning: z.boolean(), hosts: z.number(), inspectionErrors: z.number(),
    orphaned: z.number(), unconfirmed: z.number(), logBytes: z.number(), logBudgetBytes: z.number(), overBudget: z.boolean(), retentionDays: z.number() }).optional(),
  recovery: z.object({ consecutiveFailures: z.number(), nextAttemptAt: z.number(), stableSince: z.number().nullable(),
    lastFailureAt: z.number().nullable(), reason: z.string().nullable() }).optional(),
});
export const DaemonConfigurationSchema = z.object({
  protocol: z.literal(DAEMON_PROTOCOL), daemon: z.string().min(1), release: z.string().min(1), node: z.string().min(1),
  environment: z.record(z.string(), z.string()), isolation: z.enum(["cgroup", "process-group"]),
  limits: z.object({ memoryHigh: z.number().int().nonnegative(), memoryMax: z.number().int().positive(),
    tasks: z.number().int().positive(), webTasks: z.number().int().positive(), cpuPercent: z.number().int().positive(), nofile: z.number().int().positive() }),
});
export type DaemonConfiguration = z.infer<typeof DaemonConfigurationSchema>;
