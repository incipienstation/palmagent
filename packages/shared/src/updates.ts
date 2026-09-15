import { z } from "zod";

export const UpdateChannelSchema = z.enum(["stable", "preview"]);
export type UpdateChannel = z.infer<typeof UpdateChannelSchema>;

export const UpdateReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  status: z.enum(["applying", "succeeded", "failed", "deferred"]),
  previousVersion: z.string(),
  targetVersion: z.string(),
  reason: z.string(),
  checkedAt: z.string(),
});
export type UpdateReceipt = z.infer<typeof UpdateReceiptSchema>;

// Each request changes one preference. A channel change never implicitly enables
// updates, and a toggle never overwrites a choice made from another device/plugin.
export const UpdateSettingsChangeSchema = z.union([
  z.object({ channel: UpdateChannelSchema }).strict(),
  z.object({ autoUpdate: z.boolean() }).strict(),
]);
export type UpdateSettingsChange = z.infer<typeof UpdateSettingsChangeSchema>;

export const UpdateActionSchema = z.union([
  z.object({ action: z.enum(["visit", "check"]) }).strict(),
  z.object({ action: z.literal("install"), version: z.string().min(1).max(100) }).strict(),
]);
export type UpdateAction = z.infer<typeof UpdateActionSchema>;

export const UpdateDiscoverySchema = z.object({
  channel: UpdateChannelSchema,
  currentVersion: z.string(),
  targetVersion: z.string().nullable(),
  checkedAt: z.string().datetime(),
  eligible: z.boolean(),
  error: z.boolean(),
});
export type UpdateDiscovery = z.infer<typeof UpdateDiscoverySchema>;

export const UpdateRequestSchema = z.object({
  id: z.string().uuid(), channel: UpdateChannelSchema,
  currentVersion: z.string(), targetVersion: z.string(), automatic: z.boolean(),
});
export type UpdateRequest = z.infer<typeof UpdateRequestSchema>;

export const UpdateSettingsStateSchema = z.object({
  availability: z.enum(["available", "not-installed", "source-install", "installation-mismatch", "permission-required", "authentication-required", "unavailable"]),
  settings: z.object({
    channel: UpdateChannelSchema,
    autoUpdate: z.boolean(),
    independentExecutions: z.boolean().optional(),
    discovery: UpdateDiscoverySchema.nullable(),
    pending: UpdateRequestSchema.nullable(),
    lastUpdate: UpdateReceiptSchema.nullable(),
  }).nullable(),
});
export type UpdateSettingsState = z.infer<typeof UpdateSettingsStateSchema>;
export type UpdateSettingsStatus = UpdateSettingsState & {
  /** Embedded in the running server, independent of files replaced by an update. */
  currentVersion: string | null;
};

export const UpdateSettingsCommandResultSchema = z.union([
  z.object({ ok: z.literal(true), state: UpdateSettingsStateSchema }),
  z.object({ ok: z.literal(false), error: z.enum(["busy", "unavailable", "save-failed", "stale-update", "update-failed"]) }),
]);
export type UpdateSettingsCommandResult = z.infer<typeof UpdateSettingsCommandResultSchema>;
