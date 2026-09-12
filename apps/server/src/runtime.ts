import { dirname, join } from "node:path";
import { AuthService } from "./auth.js";
import { config, validateConfig } from "./config.js";
import { Db } from "./db.js";
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

async function selectBackend(): Promise<RunnerBackend> {
  if (config.runnerSocket) {
    const daemon = new DaemonBackend(config.runnerSocket);
    if (await daemon.init()) {
      console.log(`[runner] using daemon backend at ${config.runnerSocket}`);
      return daemon;
    }
    daemon.close();
    console.warn(`[runner] daemon at ${config.runnerSocket} unreachable — falling back to in-process (no deploy survival)`);
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
  try {
    const push = new PushService(db, config.vapidKeyPath ?? join(dirname(config.dbPath), "vapid.json"), config.pushSubject);
    backend = await selectBackend();
    const service = new TaskService(db, hub, supervisor, backend, worktrees, push, () => isUpdateMaintenance(config.dbPath));
    await service.init();
    const routines = new RoutineService(db, service);
    const github = new GithubService(service, config.githubToken);
    service.attachGithub(github);
    const auth = new AuthService(db);
    let closing: Promise<void> | undefined;
    return {
      db, hub, service, auth, push, routines, config,
      start() { routines.start(); github.start(); },
      close() {
        return closing ??= (async () => {
          service.beginShutdown();
          routines.stop(); github.stop(); push.close();
          await backend?.close?.();
          db.close();
        })();
      },
    };
  } catch (error) { await backend?.close?.(); db.close(); throw error; }
}
