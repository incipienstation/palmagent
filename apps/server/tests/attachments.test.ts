import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalAttachmentStorage } from "../src/attachments.js";
import { Db } from "../src/db.js";
import { MessageController } from "../src/message-controller.js";

const image = { mediaType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==" };
function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "palmagent-attachments-")), path = join(dir, "state.db");
  let db = new Db(path), storage = new LocalAttachmentStorage(db);
  db.insertRepo({ id: "r", name: "Fixture", path: dir, vcs: "none", defaultBaseRef: "", createdAt: 1 });
  for (const taskId of ["one", "two"]) db.insertTask({ taskId, repoId: "r", agent: "codex", prompt: "Fixture", status: "idle", interrupted: false, permission: "read-only", createdAt: 1, updatedAt: 1, lastActivityAt: 1 });
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { get db() { return db; }, get storage() { return storage; }, directory: join(dir, "attachments", "state.db"),
    restart() { db.close(); db = new Db(path); storage = new LocalAttachmentStorage(db); storage.prune(); } };
}

test("private attachments survive restart, deduplicate within a task, and reject cross-task reads", t => {
  const f = fixture(t), [ref] = f.storage.save("one", [image])!;
  assert.deepEqual([ref.width, ref.height], [1, 1]);
  assert.deepEqual(f.storage.save("one", [image, image]), [ref, ref]);
  assert.equal(statSync(join(f.directory, ref.id)).mode & 0o777, 0o600);
  assert.equal(statSync(f.directory).mode & 0o777, 0o700);
  assert.deepEqual(readFileSync(join(f.directory, ref.id)), Buffer.from(image.data, "base64"));
  f.restart();
  assert.deepEqual(f.storage.load("one", [ref]), [image]);
  assert.throws(() => f.storage.read("two", ref.id), /not found/);
  const [other] = f.storage.save("two", [image])!;
  assert.notEqual(other.id, ref.id);
  assert.equal(f.db.attachmentIds().size, 2);
});

test("invalid batches and missing tasks never leave partially stored images", t => {
  const f = fixture(t);
  for (const invalid of [{ ...image, mediaType: "image/jpeg" }, { ...image, data: Buffer.from("<svg/>").toString("base64") },
    { ...image, data: Buffer.concat([Buffer.from(image.data, "base64"), Buffer.alloc(5 * 1024 * 1024)]).toString("base64") }]) {
    assert.throws(() => f.storage.save("one", [image, invalid]), /Invalid image/);
  }
  assert.throws(() => f.storage.save("one", Array(9).fill(image)), /Too many/);
  assert.throws(() => f.storage.save("missing", [image]), /FOREIGN KEY/);
  assert.equal(f.db.attachmentIds().size, 0);
  assert.deepEqual(readdirSync(f.directory), []);
});

test("missing, modified and symlinked files fail closed; resubmission repairs the stored content", t => {
  const f = fixture(t), [ref] = f.storage.save("one", [image])!, path = join(f.directory, ref.id);
  writeFileSync(path, Buffer.alloc(ref.size));
  assert.throws(() => f.storage.read("one", ref.id), /unavailable/);
  unlinkSync(path);
  symlinkSync(f.db.path, path);
  assert.throws(() => f.storage.read("one", ref.id), /unavailable/);
  unlinkSync(path);
  assert.throws(() => f.storage.read("one", ref.id), /unavailable/);
  assert.deepEqual(f.storage.save("one", [image]), [ref]);
  assert.deepEqual(f.storage.load("one", [ref]), [image]);
});

test("cleanup preserves indexed attachments and removes crash remnants and permanently deleted task files", t => {
  const f = fixture(t), [ref] = f.storage.save("one", [image])!;
  writeFileSync(join(f.directory, randomUUID()), "orphan");
  writeFileSync(join(f.directory, `${randomUUID()}.${randomUUID()}.tmp`), "interrupted write");
  f.storage.prune();
  assert.deepEqual(readdirSync(f.directory), [ref.id]);
  f.db.deleteRepo("r"); f.storage.prune();
  assert.deepEqual(readdirSync(f.directory), []);
});

test("queue stores references, preserves edits and retry identity, and hydrates only the leased editor", t => {
  const f = fixture(t);
  const c = new MessageController(f.db, { assertWritable() {}, canStart() { return false; }, settings() { return {}; },
    changed() {}, start() {}, async steer() { return "delivered"; } }, f.storage);
  t.after(() => c.close());
  const req = { clientMessageId: randomUUID(), mode: "queue" as const, text: "Inspect", images: [image], expectedRunId: null };
  const first = c.submit("one", req).messages[0];
  assert.equal(first.images, undefined); assert.equal(first.attachments?.length, 1);
  assert(!JSON.stringify(f.db.readMessageState("one")).includes(image.data));
  assert.deepEqual(c.submit("one", req).messages[0], first);
  const token = randomUUID();
  const edit = c.action("one", first.id, { action: "edit", token, version: 1 }).messages[0];
  assert.deepEqual(edit.images, [image]);
  assert.equal(c.snapshot("one").messages[0].images, undefined);
  assert.throws(() => c.action("one", first.id, { action: "save", token, version: 1, text: "Bad", images: [{ ...image, data: "AAAA" }] }), /Invalid image/);
  assert.equal(c.snapshot("one").messages[0].text, "Inspect");
  c.action("one", first.id, { action: "save", token, version: 1, text: "No image", images: [] });
  assert.equal(c.snapshot("one").messages[0].attachments, undefined);
  assert.throws(() => c.submit("one", { ...req, text: "Different" }), /different content/);
});

test("storage failures reject submission without creating a queue entry", t => {
  const f = fixture(t);
  writeFileSync(join(f.directory, ".."), "unwritable directory");
  const c = new MessageController(f.db, { assertWritable() {}, canStart() { return false; }, settings() { return {}; },
    changed() {}, start() {}, async steer() { return "delivered"; } }, f.storage);
  t.after(() => c.close());
  assert.throws(() => c.submit("one", { clientMessageId: randomUUID(), mode: "queue", text: "Keep draft", expectedRunId: null, images: [image] }));
  assert.deepEqual(c.snapshot("one").messages, []);
  assert.equal(f.db.attachmentIds().size, 0);
});


test("an unreadable queued attachment rejects before execution even after a previous run", t => {
  const f = fixture(t);
  let ready = false;
  const c = new MessageController(f.db, { assertWritable() {}, canStart() { return ready; }, settings() { return {}; }, changed() {},
    start(id, message) { f.storage.load(id, message.attachments); }, async steer() { return "delivered"; } }, f.storage);
  t.after(() => c.close());
  c.beginRun("one"); c.startingRuntime("one"); c.finish("one", false);
  const queued = c.submit("one", { clientMessageId: randomUUID(), mode: "queue", text: "Inspect", expectedRunId: null, images: [image] });
  unlinkSync(join(f.directory, queued.messages[0].attachments![0].id));
  ready = true; c.pump("one");
  assert.equal(c.snapshot("one").messages[0].status, "rejected");
  assert.equal(c.snapshot("one").paused, true);
});

const bytes = Buffer.from(image.data, "base64").length;
const policy = { maxBytes: 1024 * 1024, minFreeBytes: 0, unusedGraceMs: 1000, retentionMs: 0 };
function remember(db: Db, taskId: string, attachments: ReturnType<LocalAttachmentStorage["save"]>) {
  db.appendAgentEvents(taskId, [{ taskId, agent: "codex", kind: "status", ts: 1,
    payload: { subtype: "followup", attachments } }]);
}

test("capacity charges actual files and unique content; quota failure rolls back the whole batch", t => {
  const f = fixture(t), storage = new LocalAttachmentStorage(f.db, { ...policy, maxBytes: bytes });
  const [ref] = storage.save("one", [image, image])!;
  assert.deepEqual(storage.save("one", [image]), [ref]);
  assert.throws(() => storage.save("two", [image]), { status: 507 });
  assert.equal(f.db.attachmentIds().size, 1);
  assert.deepEqual(storage.load("one", [ref]), [image]);
  assert.equal(storage.save("two", undefined), undefined);
  f.db.deleteAttachment(ref.id);
  // Unindexed or failed-deletion files still consume real capacity.
  assert.throws(() => storage.save("two", [image]), { status: 507 });
  storage.prune();
  const different = { ...image, data: Buffer.concat([Buffer.from(image.data, "base64"), Buffer.from([0])]).toString("base64") };
  assert.throws(() => storage.save("two", [image, different]), { status: 507 });
  assert.equal(f.db.attachmentIds().size, 0);
  assert.deepEqual(readdirSync(f.directory), []);
  assert.equal(storage.save("two", [image])?.length, 1);
});

test("disk reserve rejects writes and queue submission without discarding an existing edit", t => {
  const f = fixture(t);
  const storage = new LocalAttachmentStorage(f.db, { ...policy, minFreeBytes: Number.MAX_SAFE_INTEGER });
  const [ref] = f.storage.save("one", [image])!;
  assert.deepEqual(storage.save("one", [image]), [ref]);
  const c = new MessageController(f.db, { assertWritable() {}, canStart() { return false; }, settings() { return {}; },
    changed() {}, start() {}, async steer() { return "delivered"; } }, storage);
  t.after(() => c.close());
  assert.throws(() => c.submit("two", { clientMessageId: randomUUID(), mode: "queue", text: "Keep draft", expectedRunId: null, images: [image] }), { status: 507 });
  assert.deepEqual(c.snapshot("two").messages, []);
  const entry = c.submit("two", { clientMessageId: randomUUID(), mode: "queue", text: "Original", expectedRunId: null }).messages[0];
  const token = randomUUID();
  c.action("two", entry.id, { action: "edit", token, version: 1 });
  assert.throws(() => c.action("two", entry.id, { action: "save", token, version: 1, text: "New", images: [image] }), { status: 507 });
  assert.equal(c.snapshot("two").messages[0].text, "Original");
  assert.equal(f.db.readMessageState("two")?.messages[0].editToken, token);
});

test("unused cleanup waits a full observed grace period, survives restart, and protects history", t => {
  const f = fixture(t); let now = 1000;
  let storage = new LocalAttachmentStorage(f.db, policy, () => now);
  const [unused] = storage.save("one", [image])!, [used] = storage.save("two", [image])!;
  remember(f.db, "two", [used]);
  storage.prune(); now += 999; storage.prune();
  assert.equal(storage.read("one", unused.id).bytes.length, bytes);
  f.restart(); storage = new LocalAttachmentStorage(f.db, policy, () => now);
  now++; storage.prune();
  assert.throws(() => storage.read("one", unused.id), { status: 404 });
  assert.deepEqual(readdirSync(f.directory), [used.id]);
  now += 100_000; storage.prune();
  assert.deepEqual(storage.load("two", [used]), [image]);
});

test("resubmission resets the unused grace period before the reference is committed", t => {
  const f = fixture(t); let now = 1000;
  const storage = new LocalAttachmentStorage(f.db, policy, () => now);
  const [ref] = storage.save("one", [image])!;
  storage.prune(); now += 1000;
  assert.deepEqual(storage.save("one", [image]), [ref]);
  storage.prune();
  remember(f.db, "one", [ref]); now += 2000; storage.prune();
  assert.deepEqual(storage.load("one", [ref]), [image]);
});

test("pending and recoverable messages survive archived retention; cancelled references become unused", t => {
  const f = fixture(t); let now = 10_000;
  const storage = new LocalAttachmentStorage(f.db, { ...policy, retentionMs: 1000 }, () => now);
  const [ref] = storage.save("one", [image])!;
  f.db.setTaskStatus("one", "archived", false, 1);
  for (const status of ["queued", "sending", "rejected", "unknown"] as const) {
    f.db.writeMessageState("one", { revision: 1, runId: null, paused: true, messages: [{ id: "m", version: 1,
      mode: "queue", text: "Recover me", fingerprint: "f", status, attachments: [ref], editingUntil: now + 1000 }] });
    storage.prune(); now += 2000; storage.prune();
    assert.deepEqual(storage.load("one", [ref]), [image]);
  }
  const state = f.db.readMessageState("one")!; state.messages[0].status = "cancelled"; f.db.writeMessageState("one", state);
  storage.prune(); now += 1000; storage.prune();
  assert.throws(() => storage.read("one", ref.id), { status: 404 });
});

test("retention is opt-in, only expires archived history, and keeps durable tombstones", t => {
  const f = fixture(t); let now = 10_000;
  const [archived] = f.storage.save("one", [image])!, [active] = f.storage.save("two", [image])!;
  remember(f.db, "one", [archived]); remember(f.db, "two", [active]);
  f.db.setTaskStatus("one", "archived", false, now);
  const disabled = new LocalAttachmentStorage(f.db, policy, () => now);
  disabled.prune(); assert.deepEqual(disabled.load("one", [archived]), [image]);
  const enabled = new LocalAttachmentStorage(f.db, { ...policy, retentionMs: 1000 }, () => now);
  now += 999; enabled.prune(); assert.deepEqual(enabled.load("one", [archived]), [image]);
  now++; enabled.prune();
  assert.throws(() => enabled.read("one", archived.id), { status: 410 });
  assert.deepEqual(readdirSync(f.directory), [active.id]);
  assert.deepEqual(enabled.load("two", [active]), [image]);
  f.restart(); // Disabling retention must not turn an expired image into an unexplained 404.
  assert.throws(() => f.storage.read("one", archived.id), { status: 410 });
  assert.throws(() => f.storage.read("two", archived.id), { status: 404 });
  assert.deepEqual(f.storage.save("one", [image]), [archived]);
  assert.deepEqual(f.storage.load("one", [archived]), [image]);
});

test("periodic maintenance collects unused files and stops when the database closes", t => {
  const f = fixture(t); let now = 1000;
  t.mock.timers.enable({ apis: ["setInterval"] });
  const storage = new LocalAttachmentStorage(f.db, policy, () => now);
  t.after(() => storage.close());
  const [ref] = storage.save("one", [image])!;
  storage.start(); now += 1000;
  t.mock.timers.tick(60 * 60 * 1000);
  assert.throws(() => storage.read("one", ref.id), { status: 404 });
  f.db.close();
  assert.doesNotThrow(() => t.mock.timers.tick(60 * 60 * 1000));
});

test("interrupted expiration denies access durably and charges bytes until deletion succeeds", t => {
  const f = fixture(t);
  const [ref] = f.storage.save("one", [image])!;
  remember(f.db, "one", [ref]); f.db.setTaskStatus("one", "archived", false, 1);
  const storage = new LocalAttachmentStorage(f.db, { ...policy, maxBytes: bytes, retentionMs: 1000 }, () => 5000);
  const inventory = f.db.attachmentInventory.bind(f.db); let calls = 0;
  const failure = t.mock.method(f.db, "attachmentInventory", () => { if (++calls === 2) throw new Error("Interrupted before unlink"); return inventory(); });
  const warning = t.mock.method(console, "warn", () => {});
  storage.prune();
  assert.equal(warning.mock.callCount(), 1);
  assert.throws(() => storage.read("one", ref.id), { status: 410 });
  assert.deepEqual(readFileSync(join(f.directory, ref.id)), Buffer.from(image.data, "base64"));
  assert.throws(() => storage.save("two", [image]), { status: 507 });
  failure.mock.restore(); f.restart();
  assert.throws(() => f.storage.read("one", ref.id), { status: 410 });
  assert.deepEqual(readdirSync(f.directory), []);
  assert.equal(new LocalAttachmentStorage(f.db, { ...policy, maxBytes: bytes }).save("two", [image])?.length, 1);
});


test("existing attachment indexes gain lifecycle metadata without migrating image content", t => {
  const f = fixture(t), [ref] = f.storage.save("one", [image])!;
  remember(f.db, "one", [ref]);
  const path = f.db.path; f.db.close();
  const legacy = new Database(path);
  legacy.exec("ALTER TABLE attachments DROP COLUMN unused_since; ALTER TABLE attachments DROP COLUMN expired_at");
  legacy.close(); f.restart();
  assert.deepEqual(f.storage.load("one", [ref]), [image]);
  assert.equal(f.db.attachment("one", ref.id)?.expiredAt, null);
  assert.equal(f.db.attachment("one", ref.id)?.unusedSince, null);
});

test("atomic repairs reserve a temporary copy and release its allocation before the next image", t => {
  const f = fixture(t), [ref] = f.storage.save("one", [image])!;
  writeFileSync(join(f.directory, ref.id), Buffer.alloc(bytes));
  const full = new LocalAttachmentStorage(f.db, { ...policy, maxBytes: bytes });
  assert.throws(() => full.save("one", [image]), { status: 507 });
  const different = { ...image, data: Buffer.concat([Buffer.from(image.data, "base64"), Buffer.from([0])]).toString("base64") };
  const room = new LocalAttachmentStorage(f.db, { ...policy, maxBytes: bytes * 2 + 1 });
  const refs = room.save("one", [image, different])!;
  assert.deepEqual(room.load("one", refs), [image, different]);
});
