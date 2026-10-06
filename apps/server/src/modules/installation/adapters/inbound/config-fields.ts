import { z } from "zod";
import { isLoopbackHost, normalizeHost } from "@palmagent/shared";

export const LoopbackHost = z.string().min(1).refine(isLoopbackHost,
  "HOST must be loopback; terminate public HTTPS at the host ingress").transform(normalizeHost);
export const Port = z.coerce.number().int().min(1).max(65_535);
export const Concurrency = z.coerce.number().int().min(1);
export const PushSubject = z.string().regex(
  /^(?:mailto:[^@\s]+@[^@\s]+\.[^@\s]+|https:\/\/\S+)$/,
  "PUSH_SUBJECT must be a mailto: address or an https:// URL",
);
