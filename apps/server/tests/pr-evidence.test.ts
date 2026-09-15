import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import type { AgentEvent, TaskState } from "@palmagent/shared";
import { makePrRef } from "@palmagent/shared";
import { Db } from "../src/db.js";
import { isPrCreate, PrEvidence } from "../src/pr-evidence.js";

const url = "https://github.com/acme/sample-app/pull/42";
const other = "https://github.com/acme/sample-app/pull/43";
const event = (kind: AgentEvent["kind"], payload: unknown): AgentEvent => ({ taskId: "task", agent: "codex", ts: 1, kind, payload });
const call = (command: string, id = "call") => event("tool_call", { id, name: "bash", command, status: "completed" });
const result = (output = url, id = "call", exit_code: number | null = 0) => event("tool_result", { tool_use_id: id, output, exit_code });

for (const command of [
  "gh pr create --base develop --body-file /tmp/body.md",
  "cd '/projects/repo with spaces' && git push && gh pr create --title 'Fix gh pr view'",
  "/usr/bin/zsh -lc 'git push && gh pr create --base develop'",
  'gh -R acme/sample-app pr create --title "Fix"',
  "cat > /tmp/body.md <<'EOF'\ngh pr create\nEOF\ngh pr create --body-file /tmp/body.md",
]) test(`recognizes creation: ${command.split("\n")[0]}`, () => assert.equal(isPrCreate(command), true));

for (const command of [
  `rg 'gh pr create' tests`, `echo 'gh pr create'`, "cat fixture.ts", "gh pr view 42", "gh pr list",
  "gh pr create --help", "gh pr create --web", "gh pr create -w", "gh pr create --dry-run", "gh pr create --dry-run=true", `printf '${url}'; false && gh pr create || true`,
  "gh pr create | cat", "gh pr create &", "gh pr create; cat fixture.ts", "if false; then gh pr create; fi",
  "cat <<'EOF'\ngh pr create\nEOF", "sh -c 'echo gh pr create'", "eval 'gh pr create'",
  "echo $(gh pr create)", "gh pr create > /tmp/result", "gh pr create --title \"$(cat title)\"",
]) test(`rejects incidental or ambiguous command: ${command.split("\n")[0]}`, () => assert.equal(isPrCreate(command), false));

test("pairs results by ID, requires success and a standalone final URL", () => {
  const tracker = new PrEvidence();
  for (const e of [event("assistant_text", { text: url }), call(`rg '${url}' .`), result(), result(url, "missing"), call("gh pr view 42"), result()]) {
    assert.deepEqual(tracker.accept(e), []);
  }
  tracker.accept(call("gh pr create", "create"));
  tracker.accept(call("cat fixture.ts", "read"));
  assert.deepEqual(tracker.accept(result(other, "read")), []);
  assert.deepEqual(tracker.accept(result(url, "create", null)), []);
  assert.deepEqual(tracker.accept(result("Creating pull request...\n" + url + "\n", "create")), [url]);
  assert.deepEqual(tracker.accept(result(url, "create")), []);
  for (const [output, code] of [[url, 1], [`source: ${url}`, 0], [`${url}\nother output`, 0]] as const) {
    tracker.accept(call("gh pr create"));
    assert.deepEqual(tracker.accept(result(output, "call", code)), []);
  }
});

test("Claude tool IDs, error flags and content blocks are respected", () => {
  const tracker = new PrEvidence();
  const c = event("tool_call", { name: "Bash", input: { command: "gh pr create" }, id: "claude" });
  tracker.accept(c);
  assert.deepEqual(tracker.accept({ ...event("tool_result", { tool_use_id: "claude", is_error: true, content: url }), agent: "claude" }), []);
  tracker.accept(c);
  assert.deepEqual(tracker.accept({ ...event("tool_result", { tool_use_id: "claude", content: [{ type: "text", text: url }] }), agent: "claude" }), [url]);
});

test("anonymous legacy Codex results require adjacent completed creation", () => {
  const tracker = new PrEvidence();
  const c = event("tool_call", { name: "bash", command: "gh pr create", status: "completed" });
  tracker.accept(c);
  assert.deepEqual(tracker.accept(event("tool_result", { output: url, exit_code: 0 })), [url]);
  tracker.accept(c);
  tracker.accept(event("assistant_text", { text: "interleaved" }));
  assert.deepEqual(tracker.accept(event("tool_result", { output: url, exit_code: 0 })), []);
});

test("pending creation survives serialization but ends at a turn boundary", () => {
  const tracker = new PrEvidence(); tracker.accept(call("gh pr create"));
  assert.deepEqual(new PrEvidence(tracker.snapshot()).accept(result()), [url]);
  tracker.accept(event("result", {}));
  assert.deepEqual(tracker.accept(result()), []);
});

function setup(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "palmagent-pr-evidence-"));
  const path = join(dir, "test.db");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = new Db(path);
  db.insertRepo({ id: "repo", name: "Fixture", path: "/projects/fixture", vcs: "none", defaultBaseRef: "", createdAt: 1 });
  const task: TaskState = { taskId: "task", repoId: "repo", agent: "codex", prompt: "Fixture", status: "idle", interrupted: false, permission: "read-only", createdAt: 1, updatedAt: 1, lastActivityAt: 1 };
  db.insertTask(task);
  return { db, path, task };
}

test("DB commits PRs with events, preserves metadata, and recovers an outstanding call after restart", (t) => {
  const f = setup(t);
  f.db.appendAgentEvents("task", [call("gh pr create")], 3);
  assert.equal(f.db.getTask("task")?.prs, undefined);
  f.db.close();
  const db = new Db(f.path); t.after(() => db.close());
  db.appendAgentEvents("task", [result()], 4);
  assert.equal(db.getTaskRawSeq("task"), 4);
  assert.equal(db.eventsAfterSeq("task", 0).length, 2);
  assert.deepEqual(db.getTask("task")?.prs, [makePrRef(url)]);
  db.setTaskPrs("task", [{ ...makePrRef(url)!, title: "Real title", status: "merged" }], 5);
  db.appendAgentEvents("task", [call("gh pr create"), result()]);
  assert.equal(db.getTask("task")?.prs?.length, 1);
  assert.equal(db.getTask("task")?.prs?.[0].status, "merged");
});

test("DB rollback cannot persist a PR or pending state without its event", (t) => {
  const f = setup(t); t.after(() => f.db.close());
  const raw = new Database(f.path);
  raw.exec(`CREATE TRIGGER reject_cursor BEFORE UPDATE OF last_raw_seq ON tasks BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`);
  raw.close();
  assert.throws(() => f.db.appendAgentEvents("task", [call("gh pr create"), result()], 1), /fixture failure/);
  assert.equal(f.db.getTask("task")?.prs, undefined);
  assert.equal(f.db.eventCursor("task"), 0);
});

test("upgrade rebuilds legacy lists, keeps real metadata and full history, and is idempotent", (t) => {
  const f = setup(t);
  f.db.insertEvent("task", "tool_call", { name: "bash", command: "cat fixture.ts", status: "completed" }, 1);
  f.db.insertEvent("task", "tool_result", { output: other, exit_code: 0 }, 2);
  f.db.insertEvent("task", "tool_call", { name: "bash", command: "gh pr create", status: "completed" }, 3);
  f.db.insertEvent("task", "tool_result", { output: url, exit_code: 0 }, 4);
  f.db.setTaskPrs("task", [makePrRef(other)!, { ...makePrRef(url)!, status: "merged", title: "Keep metadata" }], 7);
  f.db.close();
  let db = new Db(f.path);
  const corrected = db.getTask("task")!;
  assert.deepEqual(corrected.prs?.map((p) => p.url), [url]);
  assert.equal(corrected.prUrl, url);
  assert.equal(corrected.prs?.[0].title, "Keep metadata");
  assert.equal(corrected.updatedAt, 7);
  assert.equal(db.eventCursor("task"), 4);
  db.close(); db = new Db(f.path); t.after(() => db.close());
  assert.deepEqual(db.getTask("task"), corrected);
});

test("upgrade clears both legacy columns when no creation evidence survives", (t) => {
  const f = setup(t); f.db.setTaskPrs("task", [makePrRef(url)!], 2); f.db.close();
  const db = new Db(f.path); t.after(() => db.close());
  assert.equal(db.getTask("task")?.prs, undefined);
  assert.equal(db.getTask("task")?.prUrl, undefined);
});

test("imported sessions use the same projection and do not trust prose", (t) => {
  const f = setup(t); t.after(() => f.db.close());
  f.db.importSessionEvents(f.task, [event("assistant_text", { text: other }), call("gh pr create"), result()]);
  assert.deepEqual(f.db.getTask("task")?.prs?.map((p) => p.url), [url]);
});
