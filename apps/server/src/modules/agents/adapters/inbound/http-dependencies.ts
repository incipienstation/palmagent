import type { HttpRuntime } from "../../../../platform/http/types.js";
import type { AgentInstallations } from "../../application/ports/inbound/agent-installations.js";
import type { SessionAccess } from "../../../../platform/http/types.js";
import type { AgentKind, AccountLimits, SkillContext, VoiceConnection, VoiceClientTimings } from "@palmagent/shared";
export interface HttpDependencies extends HttpRuntime {
 agentInstallations?: Pick<AgentInstallations, "list" | "update" | "observe">;
 auth: SessionAccess;
 service: {
  readonly updating: boolean;
  providerHome(agent: AgentKind): string;
  providerAccountLimits(agent: AgentKind): Promise<AccountLimits>;
  observeProviderAccountLimits(agent: AgentKind, listener: () => void): () => void;
  startVoice(context: SkillContext, sdp: string, signal?: AbortSignal): Promise<VoiceConnection>;
  touchVoice(id: string): void;
  stopVoice(id: string, timings?: VoiceClientTimings): void;
 };
}
