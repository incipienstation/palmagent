import type { AccountLimits, AgentKind, SkillCatalog, SkillSelection, VoiceClientTimings, VoiceConnection } from "@palmagent/shared";

export interface TaskVoiceOperations {
  start(home: string, sdp: string, signal?: AbortSignal): Promise<VoiceConnection>;
  touch(id: string): void;
  stop(id: string, timings?: VoiceClientTimings): void;
  close(): void;
}

export interface TaskSkillCatalog {
  list(environment: TaskSkillEnvironment): Promise<SkillCatalog>;
  resolve(environment: TaskSkillEnvironment, selected?: SkillSelection[]): Promise<SkillSelection[] | undefined>;
}

export interface TaskSkillEnvironment { agent: AgentKind; cwd: string; home: string }

export interface TaskAccountLimitReader {
  get(agent: AgentKind, home: string): Promise<AccountLimits>;
  observe(agent: AgentKind, home: string, listener: () => void): () => void;
}
