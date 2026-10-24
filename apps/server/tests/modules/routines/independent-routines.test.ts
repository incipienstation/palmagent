import assert from "node:assert/strict";
import test from "node:test";
import type { Routine } from "@palmagent/shared";
import { IndependentRoutines } from "../../../src/modules/routines/application/use-cases/independent-routines.js";
import type { RoutineService } from "../../../src/modules/routines/application/use-cases/routine-service.js";
import type { ScriptRuntime } from "../../../src/modules/routines/application/ports/outbound/script-runtime.js";

const routine = { id: "routine", kind: "script" } as Routine;
function fixture() {
  let active = 0, starts = 0, reads = 0, changes = 0, failStatus = false;
  let release!: () => void;
  const stale = new Promise<void>(resolve => { release = resolve; });
  const native = {
    async status() {
      const before = active, revision = starts;
      if (++reads === 1) await stale;
      if (failStatus) throw Error("observation unavailable");
      return { instance: "fixture", revision, activeScripts: before };
    },
    async run() { starts++; active++; return routine; },
    async stop() { active = 0; return routine; },
  } as unknown as ScriptRuntime;
  const local = { get() { return routine; }, async stop() {} } as unknown as RoutineService;
  const service = new IndependentRoutines(local, native, { emitReadChange() { changes++; } });
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
  const native = new Proxy({}, { get() { throw Error("Reads must not depend on native availability"); } }) as ScriptRuntime;
  const service = new IndependentRoutines(local, native, { emitReadChange() {} });
  assert.deepEqual(service.list(), [routine]);
  assert.equal(service.get(routine.id), routine);
  assert.equal(service.runs(routine.id, 7), runs);
  assert.equal(limit, 7);
});
