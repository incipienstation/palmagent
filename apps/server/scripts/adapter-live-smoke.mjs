import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCodexArgv } from "../src/modules/agents/adapters/outbound/codex.js";

const marker = "PALMAGENT_ADAPTER_CONTRACT_OK";
const prompt = `Reply with exactly ${marker}. Do not use tools.`;
const timeoutMs = positiveMs(process.env.PALMAGENT_ADAPTER_SMOKE_TIMEOUT_MS, 120_000);
const forceKillGraceMs = positiveMs(process.env.PALMAGENT_ADAPTER_SMOKE_FORCE_KILL_MS, 5_000);
const agentIndex = process.argv.indexOf("--agent");
const agent = agentIndex === -1 ? undefined : process.argv[agentIndex + 1];

if (agent !== "claude" && agent !== "codex") {
  console.error("usage: pnpm --filter @palmagent/server contracts:live -- --agent <claude|codex>");
  process.exit(2);
}

const cwd = mkdtempSync(join(tmpdir(), `palmagent-${agent}-contract-`));

try {
  if (agent === "claude") {
    const { InProcessBackend } = await import("../src/modules/agents/adapters/outbound/inproc-backend.js");
    const backend = new InProcessBackend();
    const events = [];
    const handle = backend.agentRunner(agent).start({ taskId: "smoke", cwd, prompt, permission: "plan" },
      event => events.push(event));
    const deadline = setTimeout(() => handle.cancel(), timeoutMs);
    try { await handle.done; } finally { clearTimeout(deadline); await backend.close(); }
    assert(events.some(event => event.kind === "status" && event.sessionId), "missing Claude session id");
    assert(events.some(event => event.kind === "result" && !event.payload.is_error), "missing successful Claude result");
    assert(events.filter(event => event.kind === "assistant_text").map(event => event.payload.text).join("").includes(marker),
      "missing expected Claude text delta");
    assert(events.some(event => event.kind === "status" && event.payload.subtype === "process_exit" && event.payload.code === 0),
      "Claude SDK query did not finish cleanly");
  } else {
    const { events, assistantText } = await runCodex(cwd);
    assert(events.some((event) => event.type === "thread.started"), "missing thread.started");
    assert(events.some((event) => event.type === "turn.completed"), "missing turn.completed");
    assert(assistantText.includes(marker), "missing expected Codex agent message");
  }
  console.log(`${agent} adapter live smoke passed`);
  if (agent === "codex" && process.argv.includes("--matrix")) {
    const { codexLiveMatrix } = await import("./codex-live-matrix.mjs");
    await codexLiveMatrix();
  }
} finally {
  rmSync(cwd, { recursive: true, force: true });
}

function runCodex(workingDirectory) {
  return new Promise((resolvePromise, reject) => {
    const argv = buildCodexArgv({ prompt, permission: "read-only" });
    const child = spawn("codex", argv, {
      cwd: workingDirectory,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      // Own a process group so CLI wrappers cannot leave descendants holding
      // stdout/stderr open after the wrapper exits.
      detached: process.platform !== "win32",
    });
    const events = [];
    let assistantText = "";
    let stdout = "";
    let settled = false;
    let timeoutError;
    let timeoutTimer;
    let forceKillTimer;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(forceKillTimer);
      if (error) reject(error);
      else resolvePromise({ events, assistantText });
    };
    timeoutTimer = setTimeout(() => {
      timeoutError = new Error(`codex adapter live smoke timed out`);
      signalTree("SIGINT");
      forceKillTimer = setTimeout(() => signalTree("SIGKILL"), forceKillGraceMs);
    }, timeoutMs);

    function signalTree(signal) {
      if (!child.pid) return;
      if (process.platform === "win32") {
        child.kill(signal);
        return;
      }
      try {
        // Signal the group even when its original leader has already exited.
        process.kill(-child.pid, signal);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }

    child.once("error", (error) => finish(new Error(`codex could not start: ${error.message}`)));
    child.stderr.resume();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      while (true) {
        const newline = stdout.indexOf("\n");
        if (newline === -1) break;
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (!line) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        recordEvent(event);
      }
    });
    child.once("close", (code, signal) => {
      const trailing = stdout.trim();
      if (trailing) {
        try {
          recordEvent(JSON.parse(trailing));
        } catch {
          // The adapter contract is NDJSON; a malformed trailing fragment is
          // ignored here and the required lifecycle assertions fail below.
        }
      }
      if (timeoutError) finish(timeoutError);
      else if (code === 0) finish();
      else finish(new Error(`codex adapter live smoke exited ${code ?? signal ?? "unknown"}`));
    });

    child.stdin.end();

    function recordEvent(event) {
      events.push(event);
      if (event.type === "item.completed" && event.item?.type === "agent_message") {
        assistantText += event.item.text ?? "";
      }
    }
  });
}

function positiveMs(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
