import assert from "node:assert/strict";
import test from "node:test";
import type { CreateTaskRequest, Routine } from "@palmagent/shared";
import { IndependentRoutines } from "../../../src/modules/routines/application/use-cases/independent-routines.js";
import type { RoutineService } from "../../../src/modules/routines/application/use-cases/routine-service.js";
import type { RoutineTaskUseCases } from "../../../src/modules/routines/application/ports/outbound/routines.js";
import type { RoutineRuntime } from "../../../src/modules/routines/application/ports/outbound/routine-runtime.js";

const tasks: RoutineTaskUseCases & { createdTask(): undefined } = { createdTask() { return undefined; }, updating: false, createTask() { throw Error("unexpected task"); } };
const routine = { id: "routine", kind: "script" } as Routine;
function fixture() {
  let active = 0, starts = 0, reads = 0, changes = 0, failStatus = false;
  let release!: () => void;
  const stale = new Promise<void>(resolve => { release = resolve; });
  const native = {
    async agentTick() { return null; },
    async status() {
      const before = active, revision = starts;
      if (++reads === 1) await stale;
      if (failStatus) throw Error("observation unavailable");
      return { instance: "fixture", revision, activeScripts: before };
    },
    async run() { starts++; active++; return { routine }; },
    async stop() { active = 0; return routine; },
  } as unknown as RoutineRuntime;
  const local = { get() { return routine; }, async stop() {} } as unknown as RoutineService;
  const service = new IndependentRoutines(local, native, { emitReadChange() { changes++; } }, tasks);
  return { service, release, get starts() { return starts; }, get changes() { return changes; }, failStatus() { failStatus = true; } };
}

test("confirmed native admission refreshes health after an older in-flight poll", async () => {
  const f = fixture();
  const initial = f.service.initialize();
  const admitted = f.service.runNow(routine.id);
  f.release();
  await initial;
  await admitted;
  assert.equal(f.service.activeScriptCount, 1);
  assert.equal(f.starts, 1);
  assert.equal(f.changes, 2);
  assert.equal(f.service.updateBlockingScriptCount, 0);
  await f.service.stopRun(routine.id);
  assert.equal(f.service.activeScriptCount, 0);
  await f.service.stop();
});

test("a failed status observation does not reject or replay an accepted mutation", async () => {
  const f = fixture(); f.release();
  await f.service.initialize(); f.failStatus();
  assert.equal(await f.service.runNow(routine.id), routine);
  assert.equal(f.starts, 1);
  await f.service.stop();
});


test("script reads reuse the persisted projection without a native round trip", () => {
  const runs = [{ id: 1, status: "succeeded" }];
  let limit: number | undefined;
  const local = { get() { return routine; }, list() { return [routine]; }, runs(_id: string, value?: number) { limit = value; return runs; } } as unknown as RoutineService;
  const native = new Proxy({}, { get() { throw Error("Reads must not depend on native availability"); } }) as RoutineRuntime;
  const service = new IndependentRoutines(local, native, { emitReadChange() {} }, tasks);
  assert.deepEqual(service.list(), [routine]);
  assert.equal(service.get(routine.id), routine);
  assert.equal(service.runs(routine.id, 7), runs);
  assert.equal(limit, 7);
});

test("scheduled acknowledgements drain in order and an older poll cannot replace receipt health", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let reads = 0;
  const status = (revision: number) => ({ instance: "fixture", revision, activeScripts: revision });
  let release!: (value: ReturnType<typeof status>) => void;
  const stale = new Promise<ReturnType<typeof status>>(resolve => { release = resolve; });
  const dispatch = (id: number) => ({ id, task: { clientRequestId: String(id) } as CreateTaskRequest });
  const native = {
    status: async () => ++reads === 1 ? status(0) : stale,
    agentTick: async () => dispatch(1),
    run: async () => ({ routine, dispatch: dispatch(3) }),
    async settleDispatch(id: number, receipt: {taskId?: string}, includeNext: boolean) {
      assert.equal(receipt.taskId, String(id));
      assert.equal(includeNext, id !== 3);
      return { status: status(id), next: id === 1 ? dispatch(2) : null };
    },
  } as unknown as RoutineRuntime;
  const created: string[] = [];
  const service = new IndependentRoutines({} as RoutineService, native, { emitReadChange() {} }, {
    ...tasks, createTask(req) { created.push(req.clientRequestId!); return { taskId: req.clientRequestId } as ReturnType<typeof tasks.createTask>; },
  });
  t.after(() => service.stop());
  await service.initialize();
  service.start();
  t.mock.timers.tick(1000);
  await service.runNow("routine");
  release(status(2));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(created, ["1", "2", "3"]);
  assert.equal(reads, 2);
  assert.equal(service.activeScriptCount, 3);
});
