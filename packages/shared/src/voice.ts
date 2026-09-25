import { z } from "zod";
import { SkillContextSchema } from "./skills.js";

export const VoiceStartSchema = z.object({
  context: SkillContextSchema,
  sdp: z.string().min(1).max(65_536).startsWith("v=0"),
});
export type VoiceStart = z.infer<typeof VoiceStartSchema>;

const VoiceDurationMsSchema = z.number().finite().min(0).max(10 * 60_000);
export const VoiceClientTimingsSchema = z.object({
  outcome: z.enum(["completed", "cancelled", "failed"]),
  audioContextResumeMs: VoiceDurationMsSchema.optional(),
  microphoneRequestMs: VoiceDurationMsSchema.optional(),
  localOfferMs: VoiceDurationMsSchema.optional(),
  serverRequestMs: VoiceDurationMsSchema.optional(),
  remoteDescriptionMs: VoiceDurationMsSchema.optional(),
  tapToReadyMs: VoiceDurationMsSchema.optional(),
  tapToFirstTranscriptMs: VoiceDurationMsSchema.optional(),
  voiceToFirstTranscriptMs: VoiceDurationMsSchema.optional(),
}).strict();
export type VoiceClientTimings = z.infer<typeof VoiceClientTimingsSchema>;

export const VoiceStopSchema = z.object({
  timings: VoiceClientTimingsSchema.optional(),
}).strict();
export type VoiceStop = z.infer<typeof VoiceStopSchema>;

export interface VoiceConnection { id: string; sdp: string }
