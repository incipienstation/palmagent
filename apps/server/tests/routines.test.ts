import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSessionControl } from "../src/session-control.js";
import { execFile, spawn, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { Db } from "../src/db.js";
import { RoutineService } from "../src/routines.js";
import { NodeIdentifierGenerator } from "../src/id-generator.js";
import { LocalRoutineScriptRunner } from "../src/routine-script.js";
import type { TaskService } from "../src/service.js";
import { createSessionApp } from "../src/local/app.js";
import { CreateRoutineSchema } from "@palmagent/shared/requests";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const createRoutineService = (db: Db, tasks: TaskService) => new RoutineService(db, tasks, new NodeIdentifierGenerator(), new LocalRoutineScriptRunner());

function fixture(t: test.TestContext, git = false) {
  const dir = mkdtempSync(join(tmpdir(), "routine-test-"));
  if (git) {
    execFileSync("git", ["init", "-q", dir]);
    execFileSync("git", ["-C", dir, "-c", "user.name=Test", "-c", "user.email=validation", "commit", "--allow-empty", "-qm", "init"]);
  }
  const db = new Db(join(dir, "state.db"));
  db.insertRepo({ id: "space", name: "test", path: dir, vcs: git ? "git" : "none", defaultBaseRef: "HEAD", createdAt: 1 });
  const dispatched: unknown[] = [];
  const tasks = { updating: false, createTask: (request: unknown) => { dispatched.push(request); return { taskId: "task" }; } } as unknown as TaskService;
  const service = createRoutineService(db, tasks);
  t.after(async () => { await service.stop(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  const create = (command: string, timeoutSeconds = 5) => service.create({ repoId: "space", kind: "script", script: { command, timeoutSeconds }, preset: "manual" });
  return { dir, db, tasks, service, create, dispatched };
}
async function settled(service: RoutineService, id: string) {
  for (let i = 0; i < 200; i++) {
    const run = service.runs(id)[0];
    if (run && run.status !== "running") return run;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("script did not finish");
}

test("legacy routine migration preserves templates and history", t => {
  const dir = mkdtempSync(join(tmpdir(), "routine-migration-"));
  const path = join(dir, "state.db");
  const original = new Db(path);
  original.insertRepo({ id: "space", name: "test", path: dir, vcs: "none", defaultBaseRef: "HEAD", createdAt: 1 });
  const service = createRoutineService(original, {} as TaskService);
  const routine = service.create({ repoId: "space", agent: "codex", prompt: "Review", preset: "manual" });
  original.insertRoutineRun({ routineId: routine.id, firedAt: 1, status: "manual", taskId: "task" });
  original.close();
  const old = new Database(path);
  old.exec("ALTER TABLE routines DROP COLUMN kind; ALTER TABLE routines DROP COLUMN script_json; ALTER TABLE routine_runs DROP COLUMN result_json");
  old.close();
  const migrated = new Db(path);
  t.after(() => { migrated.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.equal(migrated.getRoutine(routine.id)?.kind, "agent");
  assert.equal(migrated.getRoutine(routine.id)?.prompt, "Review");
  assert.equal(migrated.listRoutineRuns(routine.id)[0].taskId, "task");
});

test("scripts execute without an agent, persist output and fail on nonzero exit", async t => {
  const f = fixture(t);
  const routine = f.create("printf 'hello'; printf 'problem' >&2; exit 7");
  f.service.runNow(routine.id);
  const run = await settled(f.service, routine.id);
  assert.equal(run.status, "failed"); assert.equal(run.exitCode, 7);
  assert.match(run.output!, /hello/); assert.match(run.output!, /problem/);
  assert.ok(run.finishedAt); assert.equal(f.dispatched.length, 0);
  assert.equal(f.db.getRoutine(routine.id)?.script?.command, routine.script?.command);
  assert.equal(f.service.get(routine.id).nextRunAt, undefined);
});

test("script creates files only in a retained isolated Git worktree", async t => {
  const f = fixture(t, true);
  const routine = f.create("printf result > report.txt; pwd");
  f.service.runNow(routine.id);
  const run = await settled(f.service, routine.id);
  assert.equal(run.status, "succeeded"); assert.ok(run.worktreePath);
  assert.equal(readFileSync(join(run.worktreePath, "report.txt"), "utf8"), "result");
  assert.equal(existsSync(join(f.dir, "report.txt")), false);
});

test("timeout kills descendants, overlapping runs and deleting active runs are rejected", async t => {
  const f = fixture(t);
  const routine = f.create("(sleep 3; touch too-late) & wait", 1);
  f.service.runNow(routine.id);
  assert.throws(() => f.service.runNow(routine.id), /already running/);
  assert.throws(() => f.service.remove(routine.id), /running script/);
  const run = await settled(f.service, routine.id);
  assert.equal(run.status, "failed"); assert.match(run.note!, /timed out/);
  await new Promise(resolve => setTimeout(resolve, 2200));
  assert.equal(existsSync(join(f.dir, "too-late")), false);
});

test("shutdown interrupts active scripts; restart marks unfinished runs without replay", async t => {
  const f = fixture(t);
  const routine = f.create("sleep 30");
  f.service.runNow(routine.id);
  await f.service.stop();
  assert.equal(f.service.runs(routine.id)[0].status, "interrupted");
  f.db.insertRoutineRun({ routineId: routine.id, firedAt: 1, status: "running" });
  f.service.start();
  assert.ok(f.service.runs(routine.id).every(run => run.status === "interrupted"));
  assert.equal(f.dispatched.length, 0);
});

test("combined script output is bounded and old agent dispatch still isolates", async t => {
  const f = fixture(t);
  const routine = f.create("head -c 100000 /dev/zero | tr '\\0' x");
  f.service.runNow(routine.id);
  const run = await settled(f.service, routine.id);
  assert.equal(run.status, "succeeded"); assert.ok(run.output!.length < 66000); assert.match(run.output!, /truncated/);
  const agent = f.service.create({ repoId: "space", agent: "codex", prompt: "Review", preset: "daily", hour: 15 });
  const before = agent.nextRunAt;
  f.service.runNow(agent.id);
  assert.equal(f.service.get(agent.id).nextRunAt, before);
  assert.equal(f.service.runs(agent.id)[0].taskId, "task");
  assert.equal((f.dispatched[0] as { isolate: boolean }).isolate, true);
});

test("local plugin routes validate script definitions and share routine state", async t => {
  const f = fixture(t);
  const app = createSessionApp(f.tasks, undefined, f.service);
  const spaces = await (await app.request("/routine-spaces")).json();
  assert.equal(spaces.repos[0].id, "space"); assert.ok(spaces.timezone);
  const post = (data: unknown) => app.request("/routines", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
  assert.equal((await post({ repoId: "space", kind: "script", preset: "manual" })).status, 400);
  assert.equal((await post({ repoId: "space", kind: "script", script: { command: " " }, preset: "manual" })).status, 400);
  assert.equal(CreateRoutineSchema.safeParse({ repoId: "space", agent: "codex", prompt: " " }).success, false);
  assert.equal((await post({ repoId: "space", kind: "script", script: { command: "true" }, agent: "codex", prompt: "Review", preset: "manual" })).status, 400);
  const response = await post({ repoId: "space", kind: "script", script: { command: "printf ok" }, preset: "daily", enabled: false });
  assert.equal(response.status, 201);
  const { routine } = await response.json();
  assert.equal(routine.script.timeoutSeconds, 300); assert.equal(routine.enabled, false); assert.equal(routine.nextRunAt, undefined);
  assert.equal(f.service.list().length, 1);
  assert.throws(() => f.service.update(routine.id, { prompt: "Review" }), /do not accept agent settings/);
  assert.equal((await app.request(`/routines/${routine.id}/run`, { method: "POST" })).status, 200);
  assert.equal((await settled(f.service, routine.id)).status, "succeeded");
  Object.defineProperty(f.tasks, "updating", { value: true });
  assert.equal((await app.request(`/routines/${routine.id}/run`, { method: "POST" })).status, 503);
});

test("CLI creates, reads, pauses and deletes through the private installation socket", async t => {
  const f = fixture(t);
  writeFileSync(join(f.dir, "install.env"), "DOMAIN=example.com\n");
  const server = await startSessionControl(f.dir, { ...f.tasks, reconcileLocalSessions() {} } as TaskService, undefined, f.service);
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const cli = async (...args: string[]) => {
    const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "apps/server/src/cli/index.ts", "routine", ...args, "--data-dir", f.dir], {
      cwd: repository, env: { ...process.env, PALMAGENT_CLI_FORWARDED: "1" }, timeout: 10_000,
    });
    return JSON.parse(stdout);
  };
  const input = join(f.dir, "input.json");
  writeFileSync(input, JSON.stringify({ repoId: "space", kind: "script", script: { command: "printf '$(literal)'" }, preset: "manual" }));
  assert.equal((await cli("create", "--file", input, "--dry-run")).dryRun, true);
  assert.equal(f.service.list().length, 0);
  const { routine } = await cli("create", "--file", input);
  assert.equal((await cli("get", routine.id)).routine.script.command, "printf '$(literal)'");
  await cli("disable", routine.id);
  assert.equal(f.service.get(routine.id).enabled, false);
  await cli("run", routine.id);
  assert.equal((await settled(f.service, routine.id)).output, "$(literal)");
  await cli("delete", routine.id);
  assert.equal(f.service.list().length, 0);
});

test("abrupt server death revokes the script lifetime pipe", async t => {
  const dir = mkdtempSync(join(tmpdir(), "routine-crash-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = `
    import { Db } from './apps/server/src/db.ts';
    import { RoutineService } from './apps/server/src/routines.ts';
    import { NodeIdentifierGenerator } from './apps/server/src/id-generator.ts';
    import { LocalRoutineScriptRunner } from './apps/server/src/routine-script.ts';
    const dir = process.argv[1];
    const db = new Db(dir + '/state.db');
    db.insertRepo({id:'space',name:'test',path:dir,vcs:'none',defaultBaseRef:'HEAD',createdAt:1});
    const routines = new RoutineService(db, {updating:false}, new NodeIdentifierGenerator(), new LocalRoutineScriptRunner());
    const routine = routines.create({repoId:'space',kind:'script',script:{command:'touch started; sleep 2; touch orphan',timeoutSeconds:10},preset:'manual'});
    routines.runNow(routine.id);
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source, dir], { cwd: repository, stdio: "ignore" });
  t.after(() => child.kill("SIGKILL"));
  for (let i = 0; i < 200 && !existsSync(join(dir, "started")); i++) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(existsSync(join(dir, "started")));
  const exit = new Promise(resolve => child.once("exit", resolve));
  child.kill("SIGKILL"); await exit;
  await new Promise(resolve => setTimeout(resolve, 2400));
  assert.equal(existsSync(join(dir, "orphan")), false);
});

test("cadence patches preserve unspecified time and reject invalid scripts", t => {
  const f = fixture(t);
  const routine = f.service.create({ repoId: "space", agent: "codex", prompt: "Review", preset: "weekly", hour: 17, dayOfWeek: 2 });
  assert.equal(f.service.update(routine.id, { dayOfWeek: 4 }).schedule, "0 17 * * 4");
  assert.throws(() => f.service.update(routine.id, { script: { command: "true" } }), /Only script/);
  assert.throws(() => f.create("true", 3601), /3600/);
});

test("scheduled scripts skip overlaps, advance cadence and allow explicit stop", async t => {
  const f = fixture(t);
  t.mock.timers.enable({ apis: ["setInterval"] });
  f.service.start();
  const routine = f.service.create({ repoId: "space", kind: "script", script: { command: "sleep 30" }, preset: "hourly" });
  f.db.updateRoutine({ ...routine, nextRunAt: Date.now() - 1 });
  t.mock.timers.tick(15_000);
  assert.equal(f.service.runs(routine.id)[0].status, "running");
  assert.ok(f.service.get(routine.id).nextRunAt! > Date.now());
  assert.equal(f.db.hasRunningRoutine("space"), true);
  f.db.updateRoutine({ ...f.service.get(routine.id), nextRunAt: Date.now() - 1 });
  t.mock.timers.tick(15_000);
  assert.equal(f.service.runs(routine.id)[0].status, "skipped");
  assert.match(f.service.runs(routine.id)[0].note!, /already running/);
  await f.service.stopRun(routine.id);
  assert.equal(f.db.hasRunningRoutine("space"), false);
  assert.ok(f.service.runs(routine.id).some(run => run.status === "interrupted" && run.note === "interrupted by user"));
});
