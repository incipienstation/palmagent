import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AnswerRequest } from "@palmagent/shared";
import { buildClaudeArgv, buildClaudeUserMessage, ClaudeRunner } from "../src/claude.js";
import { buildCodexArgv, CodexRunner } from "../src/codex.js";
import { InProcessBackend } from "../src/inproc-backend.js";
import type {
  Emit,
  ProcHandle,
  RawEvent,
  RunnerBackend,
  SpawnSpec,
  StartArgs,
} from "../src/types.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeProc implements ProcHandle {
  readonly turnId: string;
  readonly writes: string[] = [];
  readonly kills: NodeJS.Signals[] = [];
  closeCount = 0;
  private writable = true;
  private lineHandler: (seq: number, line: string) => void = () => {};
  private stderrHandler: (text: string) => void = () => {};
  private exitHandler: (code: number | null) => void = () => {};
  private seq = 0;

  constructor(turnId = "task-1") {
    this.turnId = turnId;
  }

  onLine(cb: (seq: number, line: string) => void): void {
    this.lineHandler = cb;
  }

  onStderr(cb: (text: string) => void): void {
    this.stderrHandler = cb;
  }

  onExit(cb: (code: number | null) => void): void {
    this.exitHandler = cb;
  }

  stdinWritable(): boolean {
    return this.writable;
  }

  writeStdin(data: string): boolean {
    if (!this.writable) return false;
    this.writes.push(data);
    return true;
  }

  closeStdin(): void {
    this.closeCount++;
    this.writable = false;
  }

  kill(signal: NodeJS.Signals): void {
    this.kills.push(signal);
  }

  emit(value: unknown): void {
    this.lineHandler(++this.seq, JSON.stringify(value));
  }

  stderr(text: string): void {
    this.stderrHandler(text);
  }

  exit(code: number | null = 0): void {
    this.writable = false;
    this.exitHandler(code);
  }
}

class FakeBackend implements RunnerBackend {
  readonly proc: FakeProc;
  readonly specs: SpawnSpec[] = [];
  attachCalls: Array<{ turnId: string; fromSeq?: number }> = [];

  constructor(proc = new FakeProc()) {
    this.proc = proc;
  }

  start(spec: SpawnSpec): ProcHandle {
    this.specs.push(spec);
    return this.proc;
  }

  attach(turnId: string, fromSeq?: number): ProcHandle | undefined {
    this.attachCalls.push({ turnId, fromSeq });
    return this.proc;
  }

  async listLive(): Promise<string[]> {
    return [this.proc.turnId];
  }
}

function startArgs(overrides: Partial<StartArgs> = {}): StartArgs {
  return {
    taskId: "task-1",
    cwd: "/workspace/repository",
    prompt: "contract prompt",
    ...overrides,
  };
}

function captureEvents(): {
  events: Array<{ event: RawEvent; seq?: number }>;
  emit: Emit;
} {
  const events: Array<{ event: RawEvent; seq?: number }> = [];
  return {
    events,
    emit: (event, seq) => events.push({ event, seq }),
  };
}

function writtenJson(proc: FakeProc): any[] {
  return proc.writes.map((line) => JSON.parse(line));
}

function eventSubtype(event: RawEvent | undefined): string | undefined {
  if (!event?.payload || typeof event.payload !== "object") return undefined;
  return "subtype" in event.payload && typeof event.payload.subtype === "string"
    ? event.payload.subtype
    : undefined;
}

test("Claude launch contract covers resume settings and safe permission fallback", () => {
  assert.deepEqual(
    buildClaudeArgv({
      permission: "bypassPermissions",
      model: "claude-contract-model",
      effort: "high",
      resumeId: "session-1",
    }),
    [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-mode", "bypassPermissions",
      "--permission-prompt-tool", "stdio",
      "--model", "claude-contract-model",
      "--effort", "high",
      "--resume", "session-1",
    ],
  );
  const safeArgs = buildClaudeArgv({ permission: "unknown" });
  assert.equal(safeArgs[safeArgs.indexOf("--permission-mode") + 1], "acceptEdits");
});

test("Claude user-message contract keeps image blocks before the text block", () => {
  assert.deepEqual(
    buildClaudeUserMessage("contract prompt", [{ mediaType: "image/png", data: "cG5n" }]),
    {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "cG5n" },
          },
          { type: "text", text: "contract prompt" },
        ],
      },
    },
  );
});

test("Codex launch contract keeps dispatch and resume flag forms distinct", () => {
  assert.deepEqual(
    buildCodexArgv(
      {
        prompt: "dispatch prompt",
        permission: "workspace-write-net",
        model: "codex-contract-model",
        effort: "high",
      },
      ["-i", "/tmp/contract-image.png"],
    ),
    [
      "exec", "dispatch prompt",
      "--json",
      "--skip-git-repo-check",
      "-c", "approval_policy=never",
      "--sandbox", "workspace-write",
      "-c", "sandbox_workspace_write.network_access=true",
      "-c", "model=codex-contract-model",
      "-c", "model_reasoning_effort=high",
      "-i", "/tmp/contract-image.png",
    ],
  );
  assert.deepEqual(
    buildCodexArgv({
      prompt: "resume prompt",
      resumeId: "thread-1",
      permission: "read-only",
    }),
    [
      "exec", "resume", "thread-1", "resume prompt",
      "--json",
      "--skip-git-repo-check",
      "-c", "approval_policy=never",
      "-c", "sandbox_mode=read-only",
    ],
  );
  assert.deepEqual(
    buildCodexArgv({ prompt: "safe default", permission: "unknown" }).slice(-2),
    ["--sandbox", "workspace-write"],
  );
});

test("Claude runner owns prompt, event normalization, questions, steer, and stop", async () => {
  const backend = new FakeBackend();
  const capture = captureEvents();
  const handle = new ClaudeRunner().start(
    startArgs({ permission: "plan" }),
    capture.emit,
    backend,
  );

  assert.equal(backend.specs.length, 1);
  assert.equal(backend.specs[0].command, "claude");
  assert.equal(backend.specs[0].cwd, "/workspace/repository");
  assert.deepEqual(writtenJson(backend.proc)[0], {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text: "contract prompt" }],
    },
  });

  backend.proc.emit({
    type: "system",
    subtype: "init",
    session_id: "claude-session",
    model: "claude-contract-model",
    cwd: "/workspace/repository",
    tools: ["Read"],
  });
  backend.proc.emit({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      delta: { type: "text_delta", text: "hello" },
    },
  });
  backend.proc.emit({
    type: "assistant",
    message: {
      content: [{ type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "README.md" } }],
    },
  });
  backend.proc.emit({
    type: "control_request",
    request_id: "question-1",
    request: {
      subtype: "can_use_tool",
      tool_name: "AskUserQuestion",
      input: {
        questions: [{ question: "Continue?", header: "Confirm", options: [{ label: "Yes", description: "Continue" }], multiSelect: false }],
      },
    },
  });

  assert.deepEqual(capture.events.map(({ event, seq }) => [event.kind, seq]), [
    ["status", 1],
    ["assistant_text", 2],
    ["tool_call", 3],
    ["question", 4],
  ]);

  const answer: AnswerRequest = {
    requestId: "question-1",
    answers: [{ question: "Continue?", selected: ["Yes"] }],
  };
  assert.equal(handle.answer(answer), true);
  assert.deepEqual(writtenJson(backend.proc).at(-1), {
    type: "control_response",
    response: {
      subtype: "success",
      request_id: "question-1",
      response: {
        behavior: "allow",
        updatedInput: {
          questions: [{ question: "Continue?", header: "Confirm", options: [{ label: "Yes", description: "Continue" }], multiSelect: false }],
          answers: { "Continue?": "Yes" },
        },
      },
    },
  });

  assert.equal(handle.steer("steered prompt"), true);
  assert.equal(writtenJson(backend.proc).at(-1).request.subtype, "interrupt");
  await delay(300);
  assert.equal(writtenJson(backend.proc).at(-1).message.content[0].text, "steered prompt");
  assert.equal(handle.interrupt(), true);
  handle.cancel();
  assert.deepEqual(backend.proc.kills, ["SIGINT"]);

  backend.proc.stderr("provider warning");
  backend.proc.exit(0);
  await handle.done;
  assert.equal(eventSubtype(capture.events.at(-2)?.event), "stderr");
  assert.equal(eventSubtype(capture.events.at(-1)?.event), "process_exit");
});

test("Claude reattach restores a pending question without replaying the prompt", async () => {
  const backend = new FakeBackend();
  const capture = captureEvents();
  const pendingInput = {
    requestId: "question-reattach",
    questions: [{
      question: "Resume?",
      header: "Resume",
      options: [{ label: "Resume", description: "Continue the turn" }],
      multiSelect: false,
    }],
  };
  const handle = new ClaudeRunner().start(
    startArgs({ reattach: true, resumeFromSeq: 12, pendingInput }),
    capture.emit,
    backend,
  );

  assert.deepEqual(backend.attachCalls, [{ turnId: "task-1", fromSeq: 0 }]);
  assert.equal(backend.specs.length, 0);
  backend.proc.emit({
    type: "control_request", request_id: "already-answered",
    request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input: pendingInput },
  });
  backend.proc.emit({
    type: "control_request", request_id: "already-denied",
    request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "true" } },
  });
  assert.equal(backend.proc.writes.length, 0);
  assert.equal(capture.events.some(({ event }) => event.kind === "question"), false);
  assert.equal(handle.answer({
    requestId: "question-reattach",
    answers: [{ question: "Resume?", selected: ["Resume"] }],
  }), true);
  assert.equal(writtenJson(backend.proc)[0].response.request_id, "question-reattach");
  backend.proc.exit(0);
  await handle.done;
});

test("Claude replayed activity supersedes an earlier result's idle-close timer", async () => {
  const backend = new FakeBackend();
  const capture = captureEvents();
  const handle = new ClaudeRunner().start(
    startArgs({ reattach: true, resumeFromSeq: 2 }),
    capture.emit,
    backend,
  );
  backend.proc.emit({ type: "result", is_error: false });
  backend.proc.emit({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "continuing" } },
  });
  await delay(1600);
  assert.equal(backend.proc.closeCount, 0);
  backend.proc.emit({ type: "result", is_error: false });
  await delay(1600);
  assert.equal(backend.proc.closeCount, 1);
  backend.proc.exit(0);
  await handle.done;
});

test("In-process missing executable reports a failed exit", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR || "/tmp", "palmagent-missing-cli-"));
  try {
    const proc = new InProcessBackend().start({
      turnId: "missing-command", command: join(dir, "absent"), argv: [], cwd: dir,
    });
    const code = await new Promise<number | null>((resolve) => proc.onExit(resolve));
    assert.equal(code, -1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Claude stop still closes stdin when output drains without a result", async () => {
  const backend = new FakeBackend();
  const handle = new ClaudeRunner().start(
    startArgs({ reattach: true, resumeFromSeq: 0 }), () => {}, backend,
  );
  assert.equal(handle.interrupt(), true);
  backend.proc.emit({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "draining" } },
  });
  await delay(1600);
  assert.equal(backend.proc.closeCount, 1);
  backend.proc.exit(0);
  await handle.done;
});

test("Claude result closes idle stdin so one process remains one turn", async () => {
  const backend = new FakeBackend();
  const capture = captureEvents();
  const handle = new ClaudeRunner().start(startArgs(), capture.emit, backend);
  backend.proc.emit({ type: "result", subtype: "success", result: "done" });
  await delay(1_600);
  assert.equal(backend.proc.closeCount, 1);
  backend.proc.exit(0);
  await handle.done;
});

test("Codex runner normalizes JSONL, has no interactive channel, and cleans images", async () => {
  const backend = new FakeBackend();
  const capture = captureEvents();
  const handle = new CodexRunner().start(
    startArgs({
      images: [{ mediaType: "image/png", data: Buffer.from("contract-image").toString("base64") }],
      permission: "danger-full-access",
    }),
    capture.emit,
    backend,
  );

  assert.equal(backend.specs[0].command, "codex");
  assert.equal(backend.proc.closeCount, 1);
  const imageIndex = backend.specs[0].argv.indexOf("-i");
  assert.notEqual(imageIndex, -1);
  const imagePath = backend.specs[0].argv[imageIndex + 1];
  assert.equal(existsSync(imagePath), true);

  backend.proc.emit({ type: "thread.started", thread_id: "codex-thread" });
  backend.proc.emit({
    type: "item.completed",
    item: { type: "command_execution", command: "pwd", status: "completed", aggregated_output: "/workspace/repository", exit_code: 0 },
  });
  backend.proc.emit({ type: "item.completed", item: { type: "agent_message", text: "complete" } });
  backend.proc.emit({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } });

  assert.deepEqual(capture.events.map(({ event, seq }) => [event.kind, seq]), [
    ["status", 1],
    ["tool_call", 2],
    ["tool_result", 2],
    ["assistant_text", 3],
    ["result", 4],
  ]);
  assert.equal(handle.steer("later"), false);
  assert.equal(handle.interrupt(), false);
  assert.equal(handle.answer({ requestId: "none", answers: [] }), false);
  handle.cancel();
  assert.deepEqual(backend.proc.kills, ["SIGINT"]);

  backend.proc.exit(0);
  await handle.done;
  assert.equal(existsSync(imagePath), false);
  assert.equal(eventSubtype(capture.events.at(-1)?.event), "process_exit");
});

test("live smoke escalates to SIGKILL when a CLI ignores its timeout interrupt", async () => {
  const binDir = mkdtempSync(join(tmpdir(), "palmagent-smoke-bin-"));
  const fakeCodex = join(binDir, "codex");
  const interruptSeen = join(binDir, "interrupt-seen");
  writeFileSync(fakeCodex, [
    "#!/usr/bin/env node",
    "process.on('SIGINT', () => require('node:fs').writeFileSync(process.env.PALMAGENT_FAKE_SIGNAL_FILE, 'seen'));",
    "setInterval(() => {}, 1_000);",
    "",
  ].join("\n"));
  chmodSync(fakeCodex, 0o755);

  try {
    const startedAt = Date.now();
    const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "scripts/adapter-live-smoke.mjs", "--", "--agent", "codex"],
        {
          cwd: new URL("..", import.meta.url),
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH ?? ""}`,
            PALMAGENT_ADAPTER_SMOKE_TIMEOUT_MS: "500",
            PALMAGENT_ADAPTER_SMOKE_FORCE_KILL_MS: "50",
            PALMAGENT_FAKE_SIGNAL_FILE: interruptSeen,
          },
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, stderr }));
    });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /codex adapter live smoke timed out/);
    assert.equal(existsSync(interruptSeen), true, "fake CLI did not receive and ignore SIGINT");
    assert(Date.now() - startedAt < 5_000, "timeout escalation did not terminate promptly");
  } finally {
    rmSync(binDir, { recursive: true, force: true });
  }
});

test("live smoke kills descendants holding pipes after their wrapper exits", {
  skip: process.platform === "win32",
}, async () => {
  const binDir = mkdtempSync(join(tmpdir(), "palmagent-smoke-tree-"));
  const fakeCodex = join(binDir, "codex");
  const leaderFile = join(binDir, "leader");
  const interruptFile = join(binDir, "interrupt");
  const cwdFile = join(binDir, "cwd");
  const descendant = [
    "process.on('SIGINT', () => require('node:fs').writeFileSync(process.env.PALMAGENT_FAKE_SIGNAL_FILE, 'seen'));",
    "setInterval(() => {}, 1000);",
  ].join("\n");
  writeFileSync(fakeCodex, [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "fs.writeFileSync(process.env.PALMAGENT_FAKE_LEADER_FILE, String(process.pid));",
    "fs.writeFileSync(process.env.PALMAGENT_FAKE_CWD_FILE, process.cwd());",
    `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'inherit' });`,
    "setInterval(() => {}, 1000);",
  ].join("\n"));
  chmodSync(fakeCodex, 0o755);

  const child = spawn(process.execPath,
    ["--import", "tsx", "scripts/adapter-live-smoke.mjs", "--agent", "codex"], {
      cwd: new URL("..", import.meta.url),
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        PALMAGENT_ADAPTER_SMOKE_TIMEOUT_MS: "1000",
        PALMAGENT_ADAPTER_SMOKE_FORCE_KILL_MS: "100",
        PALMAGENT_FAKE_LEADER_FILE: leaderFile,
        PALMAGENT_FAKE_SIGNAL_FILE: interruptFile,
        PALMAGENT_FAKE_CWD_FILE: cwdFile,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
  let watchdog: NodeJS.Timeout | undefined;
  try {
    const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      watchdog = setTimeout(() => reject(new Error("live smoke hung on descendant pipes")), 5000);
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, stderr }));
    });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /codex adapter live smoke timed out/);
    assert.equal(existsSync(interruptFile), true, "descendant must receive and ignore SIGINT");
    assert.equal(existsSync(readFileSync(cwdFile, "utf8")), false, "smoke must remove its working directory");
  } finally {
    clearTimeout(watchdog);
    if (existsSync(leaderFile)) {
      try {
        process.kill(-Number(readFileSync(leaderFile, "utf8")), "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    child.kill("SIGKILL");
    rmSync(binDir, { recursive: true, force: true });
  }
});
