import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
