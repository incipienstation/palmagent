import { z } from "zod";

/** Rust supervisor wire contract. Product/execution storage remains owned by its existing modules. */
export const DAEMON_PROTOCOL = 1;
export const DaemonKindSchema = z.enum(["execution", "terminal", "web", "update"]);
const host = { kind: DaemonKindSchema, id: z.string().regex(/^[a-f0-9-]{1,64}$/) };
export const DaemonRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status") }).strict(),
  z.object({ action: z.literal("launch"), ...host }).strict(),
  z.object({ action: z.literal("inspect"), ...host }).strict(),
  z.object({ action: z.literal("terminate"), ...host }).strict(),
  z.object({ action: z.literal("restart-web") }).strict(),
  z.object({ action: z.literal("replace") }).strict(),
  z.object({ action: z.literal("start-update") }).strict(),
  z.object({ action: z.literal("stop") }).strict(),
]);
export type DaemonRequest = z.infer<typeof DaemonRequestSchema>;
export const DaemonHostStateSchema = z.object({
  state: z.enum(["absent", "running", "exited", "lost", "unknown"]), alive: z.boolean(),
}).passthrough();
export const DaemonStatusSchema = z.object({
  protocol: z.literal(DAEMON_PROTOCOL), version: z.string(), sourceCommit: z.string(),
  instance: z.string().min(1),
  pid: z.number().int().positive(), isolation: z.enum(["cgroup", "process-group"]),
  web: DaemonHostStateSchema.nullable(),
});
export const DaemonConfigurationSchema = z.object({
  protocol: z.literal(DAEMON_PROTOCOL), daemon: z.string().min(1), release: z.string().min(1), node: z.string().min(1),
  environment: z.record(z.string()), isolation: z.enum(["cgroup", "process-group"]),
  limits: z.object({ memoryHigh: z.number().int().nonnegative(), memoryMax: z.number().int().positive(),
    tasks: z.number().int().positive(), webTasks: z.number().int().positive(), cpuPercent: z.number().int().positive(), nofile: z.number().int().positive() }),
});
export type DaemonConfiguration = z.infer<typeof DaemonConfigurationSchema>;
