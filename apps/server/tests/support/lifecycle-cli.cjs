// Deterministic external CLI fixture. No provider calls or real transcripts.
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const agent = process.argv[2];
const argv = process.argv.slice(3);
const resumeIndex = argv.indexOf("--resume");
const resume = agent === "claude"
  ? (resumeIndex < 0 ? undefined : argv[resumeIndex + 1])
  : (argv[1] === "resume" ? argv[2] : undefined);
let session = resume || `session-${process.pid}`;
const interactive = agent === "codex" && argv[0] === "app-server";
let spec;
let ended = false;
let pinged = false;
const exitCode = () => spec.exitCode ?? (spec.failed ? 1 : 0);
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const marker = (suffix) => path.join(process.env.PROBE_CONTROL, spec.key + suffix);
const mark = (suffix, data = "") => {
  const temporary = marker(suffix) + `.${process.pid}.tmp`;
  fs.writeFileSync(temporary, data);
  fs.renameSync(temporary, marker(suffix));
};
const text = (value) => emit(interactive ? { method: "item/agentMessage/delta", params: { threadId: session, itemId: "answer", delta: value } } : agent === "claude"
  ? { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: value } } }
  : { type: "item.completed", item: { type: "agent_message", text: value } });

function result() {
  if (ended) return;
  ended = true;
  emit(interactive ? { method: "turn/completed", params: { threadId: session, turn: { id: "turn-1", status: spec.failed ? "failed" : "completed" } } } : agent === "claude"
    ? { type: "result", subtype: spec.failed ? "error_during_execution" : "success", is_error: !!spec.failed }
    : spec.failed
      ? { type: "turn.failed", error: { message: "synthetic failure" } }
      : { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
  mark(".terminal");
  if (spec.mode !== "terminal-hold" && agent === "codex") {
    setTimeout(() => process.exit(exitCode()), 30);
  }
}

function start(prompt) {
  ended = false; pinged = false;
  spec = JSON.parse(prompt);
  emit(interactive ? { method: "turn/started", params: { threadId: session, turn: { id: "turn-1" } } } : agent === "claude"
    ? { type: "system", subtype: "init", session_id: session }
    : { type: "thread.started", thread_id: session });
  text(spec.key + ":before");
  if (spec.transientError) emit({ type: "error", message: "synthetic transient error" });
  mark(".ready", JSON.stringify({
    pid: process.pid, session, argv, cwd: process.cwd(),
    home: process.env.HOME, configDir: process.env.CLAUDE_CONFIG_DIR,
  }));
  if (spec.mode === "question" || spec.mode === "answered-hold") {
    emit(interactive ? {
      id: "q1", method: "item/tool/requestUserInput",
      params: { threadId: session, turnId: "turn-1", itemId: "input", questions: [
        { id: "continue", question: "Continue?", header: "Probe", options: [{ label: "Yes", description: "Continue" }] },
      ] },
    } : {
      type: "control_request", request_id: "q1",
      request: {
        subtype: "can_use_tool", tool_name: "AskUserQuestion",
        input: { questions: [{
          question: "Continue?", header: "Probe", multiSelect: false,
          options: [{ label: "Yes", description: "Continue" }],
        }] },
      },
    });
  }
  setInterval(() => {
    if (fs.existsSync(marker(".ping")) && !pinged) {
      pinged = true;
      text(spec.key + ":ping");
    }
    if (fs.existsSync(marker(".release")) && !ended) {
      text(spec.key + ":after");
      result();
    }
    if (fs.existsSync(marker(".exit"))) process.exit(exitCode());
  }, 20);
  if (spec.mode === "auto" || spec.mode === "terminal-hold") result();
}

if (interactive) {
  const input = readline.createInterface({ input: process.stdin });
  input.on("line", line => {
    const msg = JSON.parse(line);
    if (msg.method === "initialize") emit({ id: msg.id, result: {} });
    if (msg.method === "thread/start" || msg.method === "thread/resume") { session = msg.params.threadId || session; emit({ id: msg.id, result: { thread: { id: session } } }); }
    if (msg.method === "turn/start") { emit({ id: msg.id, result: { turn: { id: "turn-1" } } }); start(msg.params.input[0].text); }
    if (msg.method === "turn/steer") { emit({ id: msg.id, result: { turnId: "turn-1" } }); text(msg.params.input[0].text); }
    if (msg.method === "turn/interrupt") { mark(".interrupted"); emit({ id: msg.id, result: {} }); result(); }
    if (msg.id === "q1" && msg.result) {
      mark(".answer", JSON.stringify(msg));
      emit({ method: "serverRequest/resolved", params: { threadId: session, requestId: "q1" } });
      text(spec.key + ":answered");
      if (spec.mode !== "answered-hold") result();
    }
  });
  input.on("close", () => { if (spec?.mode !== "terminal-hold") process.exit(spec ? exitCode() : 0); });
} else if (agent === "codex") {
  start(argv[1] === "resume" ? argv[3] : argv[1]);
} else {
  const input = readline.createInterface({ input: process.stdin });
  input.on("line", (line) => {
    const msg = JSON.parse(line);
    if (msg.type === "user") { if (argv.includes("--replay-user-messages")) emit(msg); start(msg.message.content.find((c) => c.type === "text").text); }
    if (msg.type === "control_request" && msg.request?.subtype === "interrupt") {
      mark(".interrupted");
      result();
    }
    if (msg.type === "control_response" && msg.response?.request_id === "q1") {
      mark(".answer", JSON.stringify(msg));
      text(spec.key + ":answered");
      if (spec.mode !== "answered-hold") result();
    }
  });
  input.on("close", () => {
    if (spec) mark(".eof");
    process.exit(spec ? exitCode() : 0);
  });
}
process.on("SIGINT", () => process.exit(130));
