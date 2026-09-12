import { z } from "zod";

// Runtime input contracts. Unknown fields are discarded; optional settings keep
// omission distinct from an empty string (which resets a task's override).
const agent = z.enum(["claude", "codex"]);
const text = z.string();
const required = text.min(1);
const settings = { permission: text.optional(), model: text.optional(), effort: text.optional() };
export const ImageAttachmentSchema = z.object({ mediaType: text, data: text });
const images = z.array(ImageAttachmentSchema).optional(); // decoded limits remain in the service
export const CreateRepoSchema = z.object({ path: required, name: text.optional(), defaultBaseRef: text.optional() });
export const CreateTaskSchema = z.object({
  repoId: required, agent, prompt: text, ...settings, title: text.optional(), images,
  isolate: z.boolean().optional(), // false/omitted runs in place; ignored for plain folders
});
export const FollowupSchema = z.object({ prompt: text, images, ...settings });
export const SteerSchema = z.object({ text, images, ...settings });
export const ApproveSchema = z.object({ decision: z.enum(["approve", "deny"]), scope: text.optional() });
export const QuestionAnswerSchema = z.object({ question: text, selected: z.array(text), notes: text.optional() });
export const AnswerSchema = z.object({ requestId: required, answers: z.array(QuestionAnswerSchema), response: text.optional() });
// Omitted preset means custom cron; friendly presets compile in the service.
// Omitted hour/dayOfWeek keep the existing 09:00/Monday defaults.
const cadence = {
  preset: z.enum(["hourly", "daily", "weekly", "weekdays", "manual", "custom"]).optional(),
  schedule: text.optional(), hour: z.number().int().min(0).max(23).optional(),
  dayOfWeek: z.number().int().min(0).max(6).optional(),
};
export const CreateRoutineSchema = z.object({ repoId: required, agent, prompt: required, ...cadence, ...settings, title: text.optional() });
export const UpdateRoutineSchema = z.object({ prompt: required.optional(), ...cadence, ...settings, title: text.optional(), enabled: z.boolean().optional() });
export const PushSubscriptionSchema = z.object({ endpoint: required, expirationTime: z.number().nullable().optional(), keys: z.record(text).optional() });
export const PushSubscribeSchema = z.object({ subscription: PushSubscriptionSchema });
export const PushUnsubscribeSchema = z.object({ endpoint: required });
export const DispatchSessionSchema = z.object({ agent, sessionId: required, cwd: required, home: required, waitPid: z.number().int().positive() });
export const TaskStatusSchema = z.enum(["queued", "running", "awaiting_approval", "awaiting_input", "idle", "archived", "failed", "cancelled"]);
export const TaskQuerySchema = z.object({ status: TaskStatusSchema.optional() });
export const StreamQuerySchema = z.object({ task: text.optional(), lastEventId: text.optional() });
export const PathQuerySchema = z.object({ path: text.optional() });
export const DiscoverQuerySchema = z.object({ refresh: z.enum(["0", "1"]).optional() });
export const IdParamsSchema = z.object({ id: required });
export const EmptyBodySchema = z.object({});
export const RegisterOptionsSchema = z.object({ token: text.optional() });

// WebAuthn owns cryptographic/semantic verification. These schemas only ensure
// the library receives structurally valid JSON, preserving extension fields.
const credential = {
  id: required, rawId: required, type: z.literal("public-key"),
  authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional(),
  clientExtensionResults: z.object({}).passthrough(),
};
export const AuthenticationSchema = z.object({ ...credential, response: z.object({
  clientDataJSON: required, authenticatorData: required, signature: required, userHandle: text.optional(),
}) });
export const RegistrationSchema = z.object({ response: z.object({ ...credential, response: z.object({
  clientDataJSON: required, attestationObject: required,
  transports: z.array(z.enum(["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"])).optional(),
  publicKeyAlgorithm: z.number().optional(), publicKey: text.optional(), authenticatorData: text.optional(),
}) }), label: text.optional() });

export type CreateRepoRequest = z.infer<typeof CreateRepoSchema>;
export type ImageAttachment = z.infer<typeof ImageAttachmentSchema>;
export type CreateTaskRequest = z.infer<typeof CreateTaskSchema>;
export type FollowupRequest = z.infer<typeof FollowupSchema>;
export type SteerRequest = z.infer<typeof SteerSchema>;
export type ApproveRequest = z.infer<typeof ApproveSchema>;
export type QuestionAnswer = z.infer<typeof QuestionAnswerSchema>;
export type AnswerRequest = z.infer<typeof AnswerSchema>;
export type CreateRoutineRequest = z.infer<typeof CreateRoutineSchema>;
export type UpdateRoutineRequest = z.infer<typeof UpdateRoutineSchema>;
export type PushSubscriptionJson = z.infer<typeof PushSubscriptionSchema>;
export type PushSubscribeRequest = z.infer<typeof PushSubscribeSchema>;
export type PushUnsubscribeRequest = z.infer<typeof PushUnsubscribeSchema>;
export type DispatchSessionRequest = z.infer<typeof DispatchSessionSchema>;
