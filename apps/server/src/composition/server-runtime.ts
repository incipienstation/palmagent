import { createTaskService } from "./task-service.js";
import { webauthn } from "../modules/auth/adapters/outbound/webauthn.js";
import { terminalFiles } from "../modules/terminals/adapters/outbound/terminal-files.js";
import { ResourceScope } from "../kernel/resource-scope.js";
import { TerminalStore } from "../modules/terminals/adapters/outbound/sqlite-terminal-store.js";
import { TerminalService } from "../modules/terminals/application/use-cases/terminal-service.js";
import { terminalPlatform } from "../modules/terminals/adapters/outbound/terminal-platform.js";
import { TerminalTickets } from "../modules/terminals/adapters/inbound/gateway.js";
import { dirname, join } from "node:path";
import { AuthService } from "../modules/auth/application/use-cases/auth-service.js";
import { AccountLimitReader } from "../modules/agents/adapters/outbound/account-limits.js";
import { LocalAttachmentStorage } from "../modules/tasks/adapters/outbound/file-attachment-storage.js";
import { SkillDiscovery } from "../modules/agents/adapters/outbound/skills.js";
import { VoiceSessions } from "../modules/agents/adapters/outbound/voice.js";
import { readTaskImage } from "../modules/tasks/adapters/outbound/task-images.js";
import { config, validateConfig } from "./config.js";
import { Db } from "./database.js";
import { ExecutionBackend } from "../modules/agents/adapters/outbound/execution-client.js";
import { DaemonBackend } from "../modules/agents/adapters/outbound/daemon-client.js";
import { GithubService } from "../modules/tasks/adapters/outbound/github.js";
import { Hub } from "../platform/events/hub.js";
import { InProcessBackend } from "../modules/agents/adapters/outbound/inproc-backend.js";
import { PushService } from "../modules/tasks/adapters/outbound/web-push.js";
import { RoutineService } from "../modules/routines/application/use-cases/routine-service.js";
import { TaskService } from "../modules/tasks/application/use-cases/task-service.js";
import { ProcessSupervisor } from "../modules/agents/adapters/outbound/supervisor.js";
import type { RunnerBackend } from "../modules/agents/application/ports/inbound/execution.js";
import { WorktreeManager } from "../modules/spaces/adapters/outbound/worktree.js";
import { isUpdateMaintenance } from "../modules/installation/adapters/outbound/update-maintenance.js";
import { CodexModelCatalogService } from "../modules/agents/adapters/outbound/model-catalog.js";
import { NodeIdentifierGenerator } from "../platform/process/id-generator.js";
import { LocalNativeSessionAdapter } from "../modules/tasks/adapters/outbound/native-session-adapter.js";
import { LocalRepositoryPaths } from "../modules/spaces/adapters/outbound/repository-paths.js";
import { LocalRoutineScriptRunner } from "../modules/routines/adapters/outbound/local-script-runner.js";

async function selectBackend(): Promise<RunnerBackend> {
  if (config.executionRelease) {
    if (!config.executionNode) throw new Error("An immutable execution runtime is required");
    return new ExecutionBackend(join(config.dataDir, "executions"), config.executionRelease, config.executionNode, config.concurrency);
  }
  if (config.runnerSocket) {
    const daemon = new DaemonBackend(config.runnerSocket);
    try {
      if (await daemon.init()) {
        console.log(`[runner] using daemon backend at ${config.runnerSocket}`);
        return daemon;
      }
      throw new Error("Configured runner is unavailable; refusing to start agent processes in the web service");
    } catch (error) { daemon.close(); throw error; }
  }
  return new InProcessBackend();
}

// No module-level DB, timers, subprocesses or listeners. Tests can construct the
// HTTP app with isolated dependencies without starting the operational runtime.
export async function createRuntime() {
  validateConfig();
  const resources = new ResourceScope();
  const db = new Db(config.dbPath);
  resources.defer(() => db.close());
  const hub = new Hub();
  const supervisor = new ProcessSupervisor(config.concurrency);
  const worktrees = new WorktreeManager();
  let backend: RunnerBackend | undefined;
  let terminalService: TerminalService | undefined;
  let github: GithubService | undefined;
  try {
    const push = new PushService(db, config.vapidKeyPath ?? join(dirname(config.dbPath), "vapid.json"), config.pushSubject);
    resources.defer(() => push.close());
    backend = await selectBackend();
    const selectedBackend = backend;
    resources.defer(() => selectedBackend.close?.());
    const attachments = new LocalAttachmentStorage(db, config.attachmentStorage);
    resources.defer(() => attachments.close());
    const voice = new VoiceSessions();
    resources.defer(() => voice.close());
    const service = createTaskService(db, hub, supervisor, backend, worktrees, attachments,
      new LocalRepositoryPaths(), new LocalNativeSessionAdapter(config.dbPath), new NodeIdentifierGenerator(),
      push, () => isUpdateMaintenance(config.dbPath), {
      model: { claude: config.claudeModel, codex: config.codexModel },
      effort: { claude: config.claudeEffort, codex: config.codexEffort },
    }, { read: readTaskImage }, {
      list: query => terminalService?.list(query) ?? [],
      cleanup: (cwd, taskId, removeWorktree) => terminalService
        ? terminalService.store.cleanup(cwd, taskId, removeWorktree)
        : removeWorktree(),
    }, taskId => github?.onNewPrs(taskId), voice, new SkillDiscovery(), new AccountLimitReader());
    resources.onStop(() => service.beginShutdown());
    const terminalStore = new TerminalStore(join(config.dataDir, "terminals"));
    let terminalsOwnStore = false;
    resources.defer(() => { if (!terminalsOwnStore) terminalStore.close(); });
    const terminals = terminalService = new TerminalService(terminalStore,
      terminalPlatform(Boolean(config.executionRelease && config.executionNode)).supervisor,
      { task: id => service.getTask(id), repo: id => db.getRepo(id), cleanup: id => service.cleanupTerminalWorktree(id), updating: () => service.updating },
      config.executionRelease ?? "", config.executionNode ?? "", terminalFiles);
    terminalsOwnStore = true;
    resources.defer(() => terminals.close());
    await service.init();
    const routines = new RoutineService(db, service, new NodeIdentifierGenerator(), new LocalRoutineScriptRunner(new WorktreeManager()), hub);
    resources.defer(() => routines.stop());
    github = new GithubService(service, config.githubToken);
    resources.onStop(() => github?.stop());
    const auth = new AuthService(db, config, webauthn);
    const modelCatalog = new CodexModelCatalogService();
    return {
      db, hub, service, auth, push, routines, modelCatalog, config, terminals, terminalTickets: new TerminalTickets(),
      start() { routines.start(); github?.start(); terminals.start(); },
      close: () => resources.close(),
    };
  } catch (error) { return resources.fail(error); }
}
