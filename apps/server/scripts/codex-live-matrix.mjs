import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexRunner } from "../src/codex.js";
import { InProcessBackend } from "../src/inproc-backend.js";

// Explicit, authenticated integration coverage; never runs in hermetic CI.
export async function codexLiveMatrix() {
  console.log(execFileSync("codex", ["--version"], { encoding: "utf8" }).trim());
  const cwd = mkdtempSync(join(tmpdir(), "palmagent-codex-matrix-"));
  const timeout = Number(process.env.PALMAGENT_ADAPTER_SMOKE_TIMEOUT_MS) || 120_000;
  async function run(interactive, args, stop = false) {
    const backend = new InProcessBackend();
    const events = [];
    let stopped = false;
    let stoppedAt;
    const handle = new CodexRunner().start({ taskId: randomUUID(), messageId: randomUUID(), cwd,
      permission: "read-only", interactive, ...args }, event => {
      events.push(event);
      if (stop && !stopped && event.kind === "tool_call") {
        stopped = true;
        stoppedAt = Date.now();
        if (interactive) assert.equal(handle.interrupt(), true);
        else handle.cancel();
      }
    }, backend);
    let timer;
    try {
      await Promise.race([handle.done, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Codex matrix timed out")), timeout);
      })]);
      if (stop) {
        assert(stopped, "must stop during a real tool call");
        assert(Date.now() - stoppedAt < 10_000, "stop must finish before the sleeping tool completes");
      }
      if (process.env.PALMAGENT_ADAPTER_SMOKE_EVENTS) writeFileSync(process.env.PALMAGENT_ADAPTER_SMOKE_EVENTS,
        JSON.stringify(events), { mode: 0o600 });
      return events;
    } finally {
      clearTimeout(timer);
      await backend.close();
    }
  }
  const text = events => events.filter(e => e.kind === "assistant_text").map(e => e.payload.text).join("");
  const success = events => {
    assert(!events.some(e => e.kind === "error"), "unexpected normalized error");
    assert(events.some(e => e.kind === "result" && !e.payload.is_error), "missing successful result");
    assert(events.some(e => e.kind === "status" && e.payload.subtype === "process_exit" && e.payload.code === 0), "missing clean process exit");
  };
  try {
    for (const interactive of [false, true]) {
      const mode = interactive ? "app-server" : "exec";
      const marker = `CONTEXT_${randomUUID().replaceAll("-", "")}`;
      const fresh = await run(interactive, { prompt: `Remember ${marker}. Reply with exactly that token. Do not use tools.` });
      success(fresh); assert(text(fresh).includes(marker));
      const resumeId = fresh.find(e => e.sessionId)?.sessionId;
      assert(resumeId, "missing session id");
      console.log(`${mode}: fresh PASS`);
      const resumed = await run(interactive, { resumeId, prompt: "Return the CONTEXT_ token from the previous turn. Do not use tools." });
      success(resumed); assert(text(resumed).includes(marker), "resume lost prior context");
      assert(resumed.filter(e => e.sessionId).every(e => e.sessionId === resumeId));
      console.log(`${mode}: resume PASS`);
      const tool = await run(interactive, { prompt: "Execute this exact shell command once: printf PALMAGENT_TOOL_OK; exit 7. Then reply DONE. The nonzero exit is intentional." });
      success(tool);
      const result = tool.find(e => e.kind === "tool_result" && e.payload.exit_code === 7 && e.payload.output?.includes("PALMAGENT_TOOL_OK"));
      assert(result, "missing real nonzero tool result");
      assert(tool.some(e => e.kind === "tool_call" && e.payload.id === result.payload.tool_use_id));
      console.log(`${mode}: tool execution / exit 7 PASS`);
      const failure = await run(interactive, { model: "palmagent-nonexistent-contract-model", prompt: "Reply OK." });
      assert(failure.some(e => e.kind === "error"), "missing provider error");
      assert(!failure.some(e => e.kind === "result" && !e.payload.is_error), "failure reported success");
      console.log(`${mode}: invalid model error PASS`);
      const stopped = await run(interactive, { prompt: "Run the shell command sleep 30, then reply FINISHED." }, true);
      assert(!stopped.some(e => e.kind === "result" && !e.payload.is_error), "interrupted turn reported success");
      if (interactive) assert(stopped.some(e => e.kind === "result" && e.payload.subtype === "interrupted"));
      const stoppedId = stopped.find(e => e.sessionId)?.sessionId;
      assert(stoppedId);
      const recovered = await run(interactive, { resumeId: stoppedId, prompt: "Do not run tools. Reply exactly RECOVERED." });
      success(recovered); assert(text(recovered).includes("RECOVERED"));
      console.log(`${mode}: interrupt / resume after stop PASS`);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
