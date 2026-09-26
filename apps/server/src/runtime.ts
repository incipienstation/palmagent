import { TerminalStore } from "./terminal/store.js";
import { TerminalService } from "./terminal/service.js";
import { terminalPlatform } from "./terminal/adapters.js";
import { TerminalTickets } from "./terminal/gateway.js";
import { dirname, join } from "node:path";
import { AuthService } from "./auth.js";
import { AccountLimitReader } from "./account-limits.js";
import { LocalAttachmentStorage } from "./attachments.js";
import { SkillDiscovery } from "./skills.js";
import { VoiceSessions } from "./voice.js";
import { readTaskImage } from "./task-images.js";
import { config, validateConfig } from "./config.js";
import { Db } from "./db.js";
import { ExecutionBackend } from "./execution/client.js";
import { DaemonBackend } from "./daemon-client.js";
import { GithubService } from "./github.js";
import { Hub } from "./hub.js";
import { InProcessBackend } from "./inproc-backend.js";
import { PushService } from "./push.js";
import { RoutineService } from "./routines.js";
import { TaskService } from "./service.js";
import { ProcessSupervisor } from "./supervisor.js";
import type { RunnerBackend } from "./types.js";
import { WorktreeManager } from "./worktree.js";
import { isUpdateMaintenance } from "./update-maintenance.js";
import { CodexModelCatalogService } from "./model-catalog.js";
import { NodeIdentifierGenerator } from "./id-generator.js";
import { LocalNativeSessionAdapter } from "./native-session-adapter.js";
import { LocalRepositoryPaths } from "./repository-paths.js";
import { LocalRoutineScriptRunner } from "./routine-script.js";

async function selectBackend(): Promise<RunnerBackend> {
  if (config.executionRelease) {
    if (!config.executionNode) throw new Error("An immutable execution runtime is required");
    return new ExecutionBackend(join(config.dataDir, "executions"), config.executionRelease, config.executionNode, config.concurrency);
  }
  if (config.runnerSocket) {
    const daemon = new DaemonBackend(config.runnerSocket);
    if (await daemon.init()) {
      console.log(`[runner] using daemon backend at ${config.runnerSocket}`);
      return daemon;
    }
    daemon.close();
    throw new Error("Configured runner is unavailable; refusing to start agent processes in the web service");
  }
  return new InProcessBackend();
}

// No module-level DB, timers, subprocesses or listeners. Tests can construct the
// HTTP app with isolated dependencies without starting the operational runtime.
export async function createRuntime() {
  validateConfig();
  const db = new Db(config.dbPath);
  const hub = new Hub();
  const supervisor = new ProcessSupervisor(config.concurrency);
  const worktrees = new WorktreeManager();
  let backend: RunnerBackend | undefined;
  let terminalService: TerminalService | undefined;
  let github: GithubService | undefined;
  try {
    const push = new PushService(db, config.vapidKeyPath ?? join(dirname(config.dbPath), "vapid.json"), config.pushSubject);
    backend = await selectBackend();
    const attachments = new LocalAttachmentStorage(db, config.attachmentStorage);
    const service = new TaskService(db, hub, supervisor, backend, worktrees, attachments,
      new LocalRepositoryPaths(), new LocalNativeSessionAdapter(config.dbPath), new NodeIdentifierGenerator(),
      push, () => isUpdateMaintenance(config.dbPath), {
      model: { claude: config.claudeModel, codex: config.codexModel },
      effort: { claude: config.claudeEffort, codex: config.codexEffort },
    }, { read: readTaskImage }, {
      list: query => terminalService?.list(query) ?? [],
      cleanup: (cwd, taskId, removeWorktree) => terminalService
        ? terminalService.store.cleanup(cwd, taskId, removeWorktree)
        : removeWorktree(),
    }, taskId => github?.onNewPrs(taskId), new VoiceSessions(), new SkillDiscovery(), new AccountLimitReader());
    const terminals = terminalService = new TerminalService(new TerminalStore(join(config.dataDir, "terminals")),
      terminalPlatform(Boolean(config.executionRelease && config.executionNode)).supervisor,
      { task: id => service.getTask(id), repo: id => db.getRepo(id), cleanup: id => service.cleanupTerminalWorktree(id), updating: () => service.updating },
      config.executionRelease ?? "", config.executionNode ?? "");
    await service.init();
    const routines = new RoutineService(db, service, new NodeIdentifierGenerator(), new LocalRoutineScriptRunner());
    github = new GithubService(service, config.githubToken);
    const auth = new AuthService(db);
    const modelCatalog = new CodexModelCatalogService();
    let closing: Promise<void> | undefined;
    return {
      db, hub, service, auth, push, routines, modelCatalog, config, terminals, terminalTickets: new TerminalTickets(),
      start() { routines.start(); github?.start(); terminals.start(); },
      close() {
        return closing ??= (async () => {
          service.beginShutdown();
          await routines.stop(); github?.stop(); push.close();
          await backend?.close?.();
          await terminals.close();
          db.close();
        })();
      },
    };
  } catch (error) { await backend?.close?.(); await terminalService?.close(); db.close(); throw error; }
}
