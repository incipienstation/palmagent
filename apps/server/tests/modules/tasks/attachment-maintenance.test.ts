import assert from "node:assert/strict";
import { test } from "node:test";
import { ATTACHMENT_DEFAULTS, attachmentRetention } from "../../../src/modules/tasks/domain/attachment-policy.js";
import { createAttachmentMaintenance } from "../../../src/modules/tasks/application/use-cases/attachment-maintenance.js";
import type { AttachmentFileCollection, AttachmentRetentionRepository } from "../../../src/modules/tasks/application/ports/outbound/attachments.js";

const policy = { ...ATTACHMENT_DEFAULTS, retentionMs: 1000, unusedGraceMs: 100 };
const record = { id: "attachment", taskId: "task", mediaType: "image/png" as const, size: 10, digest: "digest",
  unusedSince: null, expiredAt: null, status: "archived", updatedAt: 1000 };
const empty = () => ({ history: new Set<string>(), pending: new Set<string>() });

test("pending references override archived expiration, while expired access stays expired", () => {
  const refs = { history: new Set([record.id]), pending: new Set([record.id]) };
  assert.deepEqual(attachmentRetention(record, refs, policy, 3000), { kind: "update", unusedSince: null, expiredAt: null });
  assert.equal(attachmentRetention({ ...record, expiredAt: 2000 }, refs, policy, 3000), undefined);
});

test("archived history expires at the configured boundary, only when retention is enabled", () => {
  const refs = { ...empty(), history: new Set([record.id]) };
  assert.deepEqual(attachmentRetention(record, refs, policy, 1999), { kind: "update", unusedSince: null, expiredAt: null });
  assert.deepEqual(attachmentRetention(record, refs, policy, 2000), { kind: "update", unusedSince: null, expiredAt: 2000 });
  for (const [entry, settings] of [[{ ...record, status: "idle" }, policy], [record, ATTACHMENT_DEFAULTS]] as const) {
    assert.deepEqual(attachmentRetention(entry, refs, settings, 20_000), { kind: "update", unusedSince: null, expiredAt: null });
  }
});

test("unused content is marked before its grace period and a renewed reference clears that mark", () => {
  assert.deepEqual(attachmentRetention(record, empty(), policy, 2000), { kind: "update", unusedSince: 2000, expiredAt: null });
  const unused = { ...record, unusedSince: 2000 };
  assert.equal(attachmentRetention(unused, empty(), policy, 2099), undefined);
  assert.deepEqual(attachmentRetention(unused, empty(), policy, 2100), { kind: "delete" });
  assert.deepEqual(attachmentRetention(unused, { ...empty(), pending: new Set([record.id]) }, policy, 2100), { kind: "update", unusedSince: null, expiredAt: null });
});

function fixture() {
  let records: ReturnType<AttachmentRetentionRepository["attachmentInventory"]> = [{ ...record }];
  const calls: string[] = [];
  let transaction = 0, held = false;
  let afterMark = () => {};
  const physical = new Set([record.id]);
  const index: AttachmentRetentionRepository = {
    transaction(work) {
      assert(!held); held = true; calls.push(`begin:${++transaction}`);
      const before = structuredClone(records);
      try { const value = work(); calls.push(`commit:${transaction}`); return value; }
      catch (error) { records = before; calls.push(`rollback:${transaction}`); throw error; }
      finally { held = false; if (transaction === 1) afterMark(); }
    },
    attachmentInventory: () => { assert(held); calls.push("inventory"); return structuredClone(records); },
    attachmentReferences: () => ({ ...empty(), history: new Set([record.id]) }),
    setAttachmentLifecycle(id, unusedSince, expiredAt) {
      assert(held); calls.push("mark"); records = records.map(r => r.id === id ? { ...r, unusedSince, expiredAt } : r);
    },
    deleteAttachment(id) { assert(held); records = records.filter(r => r.id !== id); },
  };
  const files: AttachmentFileCollection = {
    exists: () => true,
    removeUnreferenced(retained) {
      assert(held, "the writer lock must cover unlinking"); calls.push("sweep");
      for (const id of physical) if (!retained.has(id)) physical.delete(id);
    },
  };
  return { index, files, calls, physical, records: () => records,
    restoreBetweenTransactions() { afterMark = () => { records[0].expiredAt = null; }; },
    maintenance: createAttachmentMaintenance(index, files, policy, () => 2000),
  };
}

test("cleanup commits expiration before sweeping and re-reads under the writer lock", () => {
  const f = fixture(); f.maintenance.prune();
  assert.deepEqual(f.calls, ["begin:1", "inventory", "mark", "commit:1", "begin:2", "inventory", "sweep", "commit:2"]);
  assert.equal(f.records()[0].expiredAt, 2000); assert.equal(f.physical.size, 0);
});

test("an explicit reupload between transactions is retained by the fresh sweep", () => {
  const f = fixture(); f.restoreBetweenTransactions(); f.maintenance.prune();
  assert.equal(f.records()[0].expiredAt, null); assert(f.physical.has(record.id));
});

test("failed deletion leaves a durable expiration and can be retried", () => {
  const f = fixture(), sweep = f.files.removeUnreferenced;
  f.files.removeUnreferenced = () => { throw new Error("storage unavailable"); };
  assert.throws(() => f.maintenance.prune(), /storage unavailable/);
  assert.equal(f.records()[0].expiredAt, 2000); assert(f.physical.has(record.id));
  f.files.removeUnreferenced = sweep; f.maintenance.prune();
  assert.equal(f.records()[0].expiredAt, 2000); assert.equal(f.physical.size, 0);
});

test("a failed marking transaction never reaches physical deletion", () => {
  const f = fixture();
  f.index.setAttachmentLifecycle = () => { throw new Error("index unavailable"); };
  assert.throws(() => f.maintenance.prune(), /index unavailable/);
  assert.equal(f.records()[0].expiredAt, null); assert(f.physical.has(record.id));
  assert(!f.calls.includes("sweep"));
});
