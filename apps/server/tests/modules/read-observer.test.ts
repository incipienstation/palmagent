import test from "node:test";
import assert from "node:assert/strict";
import { ReadObserver } from "../../src/kernel/read-observer.js";

const settled = () => new Promise<void>(resolve => setImmediate(resolve));

test("observers share refreshes, suppress unchanged notifications, and stop work when unsubscribed", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reads = 0, value = 1, events = 0;
  const source = new ReadObserver(async () => { reads++; return value; }, () => 1000);
  const first = source.subscribe(() => events++);
  await settled();
  const second = source.subscribe(() => events++);
  await settled();
  const initial = events;
  t.mock.timers.tick(1000); await settled();
  assert.equal(events, initial, "unchanged source is silent");
  value++;
  t.mock.timers.tick(1000); await settled();
  assert.equal(events, initial + 2, "one source refresh notifies both observers");
  first(); second();
  const stopped = reads;
  t.mock.timers.tick(10000); await settled();
  assert.equal(reads, stopped);
  assert.equal(source.observed, false);
});

test("a change during a slow refresh gets a trailing read and close cancels rescheduling", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let release!: (value: number) => void, reads = 0, events = 0;
  const source = new ReadObserver(() => {
    reads++;
    return reads === 1 ? new Promise<number>(resolve => { release = resolve; }) : Promise.resolve(2);
  }, () => 1000);
  source.subscribe(() => events++);
  source.refresh(); source.refresh();
  assert.equal(reads, 1);
  release(1); await settled();
  assert.equal(reads, 2);
  assert.equal(events, 3);
  source.close();
  t.mock.timers.tick(10000); await settled();
  assert.equal(reads, 2);
});
