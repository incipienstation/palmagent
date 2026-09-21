import { z } from "zod";
import { SkillContextSchema } from "./skills.js";

export const VoiceStartSchema = z.object({
  context: SkillContextSchema,
  sdp: z.string().min(1).max(65_536).startsWith("v=0"),
});
export type VoiceStart = z.infer<typeof VoiceStartSchema>;
export interface VoiceConnection { id: string; sdp: string }
