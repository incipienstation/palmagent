import { NativeReadHttp } from "../modules/installation/adapters/outbound/native-read-http.js";
import { NativeTaskTranscript } from "../modules/tasks/adapters/outbound/native-task-transcript.js";
import { NativeTaskActivity } from "../modules/tasks/adapters/outbound/native-task-activity.js";
import { NativeRetainedTurns } from "../modules/tasks/adapters/outbound/native-retained-turns.js";
import { NativeTaskUsage } from "../modules/tasks/adapters/outbound/native-task-usage.js";
import { createTaskService } from "./task-service.js";
import { CodexSharedSessions } from "../modules/agents/adapters/outbound/codex-shared-session.js";
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
import { createAttachmentStorage } from "./attachments.js";
import { SkillDiscovery } from "../modules/agents/adapters/outbound/skills.js";
import { VoiceSessions } from "../modules/agents/adapters/outbound/voice.js";
import { CodexSideChats } from "../modules/agents/adapters/outbound/side-chat.js";
import { readTaskImage, readTaskVisualization } from "../modules/tasks/adapters/outbound/task-previews.js";
import { config, validateConfig } from "./config.js";
import { Db } from "./database.js";
import { ExecutionBackend } from "../modules/agents/adapters/outbound/execution-client.js";
import { DaemonBackend } from "../modules/agents/adapters/outbound/daemon-client.js";
import { GithubService } from "../modules/tasks/adapters/outbound/github.js";
import { Hub } from "../platform/events/hub.js";
import { InProcessBackend } from "../modules/agents/adapters/outbound/inproc-backend.js";
import { PushService } from "../modules/tasks/adapters/outbound/web-push.js";
import { IndependentRoutines } from "../modules/routines/application/use-cases/independent-routines.js";
import { NativeRoutineRuntime } from "../modules/routines/adapters/outbound/native-routine-runtime.js";
import { RoutineService } from "../modules/routines/application/use-cases/routine-service.js";
import { TaskService } from "../modules/tasks/application/use-cases/task-service.js";
import { ProcessSupervisor } from "../modules/agents/adapters/outbound/supervisor.js";
import type { RunnerBackend } from "../modules/agents/application/ports/inbound/execution.js";
import { WorktreeManager } from "../modules/spaces/adapters/outbound/worktree.js";
import { isUpdateMaintenance } from "../modules/installation/adapters/outbound/update-maintenance.js";
import { ModelCatalogService } from "../modules/agents/adapters/outbound/model-catalog.js";
import { NodeIdentifierGenerator } from "../platform/process/id-generator.js";
import { LocalNativeSessionAdapter } from "../modules/tasks/adapters/outbound/native-session-adapter.js";
import { LocalRepositoryPaths } from "../modules/spaces/adapters/outbound/repository-paths.js";
import { DaemonRoutineScriptRunner } from "../modules/routines/adapters/outbound/daemon-script-runner.js";
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
export async function createRuntime(runtimeLease: number) {
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
    backend = await selectBackend();
    const selectedBackend = backend;
    resources.defer(() => selectedBackend.close?.());
    const voice = new VoiceSessions();
    resources.defer(() => voice.close());
    const accountLimits = new AccountLimitReader();
    resources.defer(() => accountLimits.close());
    const nativeRoutines = process.env.PALMAGENT_DAEMON_DATA && config.executionRelease && config.executionNode
      ? new NativeRoutineRuntime(config.dataDir) : undefined;
    if (config.nativeReadHttpPort !== undefined && !nativeRoutines) throw new Error("Direct read HTTP requires a native application runtime");
    const retainedTurns = nativeRoutines ? new NativeRetainedTurns(
      join(config.executionRelease!, "daemon", `linux-${process.arch}`, "palmagent-runtime"), config.dbPath, runtimeLease,
      () => { console.error("Task owner disconnected. Restarting the API to recover retained turns."); process.kill(process.pid, "SIGTERM"); },
    ) : undefined;
    if (retainedTurns) {
      resources.defer(() => retainedTurns.close());
      db.selectTaskOwner(retainedTurns);
    }
    const push = new PushService(retainedTurns ?? db, config.vapidKeyPath ?? join(dirname(config.dbPath), "vapid.json"), config.pushSubject);
    resources.defer(() => push.close());
    const attachments = createAttachmentStorage(retainedTurns?.attachments ?? db, config.attachmentStorage);
    resources.defer(() => attachments.close());
    const service = createTaskService(db, hub, supervisor, backend, worktrees, attachments,
      new LocalRepositoryPaths(), new LocalNativeSessionAdapter(config.dbPath), new NodeIdentifierGenerator(),
      push, () => isUpdateMaintenance(config.dbPath), {
      model: { claude: config.claudeModel, codex: config.codexModel },
      effort: { claude: config.claudeEffort, codex: config.codexEffort },
    }, { readImage: readTaskImage, readVisualization: readTaskVisualization }, {
      list: query => terminalService?.list(query) ?? [],
      cleanup: (cwd, taskId, removeWorktree) => terminalService
        ? terminalService.store.cleanup(cwd, taskId, removeWorktree)
        : removeWorktree(),
    }, taskId => github?.onNewPrs(taskId), voice, new SkillDiscovery(), accountLimits, nativeRoutines ? new NativeTaskUsage(config.dataDir) : db, nativeRoutines ? new NativeTaskActivity(config.dataDir) : db, nativeRoutines ? new NativeTaskTranscript(config.dataDir) : undefined, retainedTurns);
    resources.onStop(() => service.beginShutdown());
    service.sharedSessions = new CodexSharedSessions();
    const sideChats = new CodexSideChats();
    service.sideChats = sideChats;
    resources.onStop(() => sideChats.close());
    const terminalStore = new TerminalStore(join(config.dataDir, "terminals"));
    let terminalsOwnStore = false;
    resources.defer(() => { if (!terminalsOwnStore) terminalStore.close(); });
    const terminals = terminalService = new TerminalService(terminalStore,
      terminalPlatform(Boolean(config.executionRelease && config.executionNode)).supervisor,
      { task: id => service.getTask(id), repo: id => db.getRepo(id), cleanup: id => service.cleanupTerminalWorktree(id), updating: () => service.updating },
      config.executionRelease ?? "", config.executionNode ?? "", terminalFiles, () => hub.emitReadChange({ type: "read-change", terminals: true }));
    terminalsOwnStore = true;
    resources.defer(() => terminals.close());
    await service.init();
    const scriptRunner = process.env.PALMAGENT_DAEMON_DATA && config.executionRelease && config.executionNode
      ? new DaemonRoutineScriptRunner(config.dataDir, config.executionRelease, config.executionNode, worktrees)
      : new LocalRoutineScriptRunner(worktrees);
    if (nativeRoutines) {
      const status = await nativeRoutines.connect(config.executionRelease!);
      if (status.agentRoutines !== 1) throw new Error("This release requires native agent routine support");
      if (status.taskTranscriptSteps !== 1) throw new Error("This release requires native Task transcript step support");
      if (status.taskTranscript !== 1) throw new Error("This release requires native Task transcript support");
      if (status.taskActivityDetails !== 1) throw new Error("This release requires native Task activity support");
      if (status.taskUsage !== 1) throw new Error("This release requires native Task usage support");
      const readHttp = new NativeReadHttp(config.dataDir);
      if (config.nativeReadHttpPort !== undefined) {
        if (status.taskReadHttp !== 1) throw new Error("This release requires native read HTTP support");
        if (status.routineWriteHttp !== 1) throw new Error("This release requires native routine write HTTP support");
        // Production event batches already refresh their projection before commit. Repair
        // retained dirty rows once at startup, before the direct listener admits reads.
        for (const task of db.listTasks()) db.prepareConversation(task.taskId);
        resources.onStop(() => readHttp.configure(null));
        await readHttp.configure({ port: config.nativeReadHttpPort, authEnabled: config.authEnabled,
          cookieName: config.cookieName, sessionTtlMs: config.sessionTtlMs, authOrigin: config.authOrigin });
      } else if (status.taskReadHttp === 1) {
        // A retained application may have been enabled by the previous API owner.
        await readHttp.configure(null);
      }
    }
    const localRoutines = new RoutineService(db, service, new NodeIdentifierGenerator(), scriptRunner, hub);
    const routines = nativeRoutines ? new IndependentRoutines(localRoutines, nativeRoutines, hub, service) : localRoutines;
    if (routines instanceof IndependentRoutines) await routines.initialize();
    resources.defer(() => routines.stop());
    github = new GithubService(service, config.githubToken);
    resources.onStop(() => github?.stop());
    const auth = new AuthService(db, config, webauthn);
    const modelCatalog = new ModelCatalogService();
    return {
      db, hub, service, auth, push, routines, modelCatalog, config, terminals, terminalTickets: new TerminalTickets(),
      spaceCatalog: { getRepoByPath: db.getRepoByPath, discoveredRepoIds: retainedTurns?.spaces.discoveredRepoIds ?? db.discoveredRepoIds },
      start() { routines.start(); github?.start(); terminals.start(); },
      close: () => resources.close(),
    };
  } catch (error) { return resources.fail(error); }
}
