import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClaudeArgv, buildClaudeUserMessage } from "../src/claude.js";
import { buildCodexArgv } from "../src/codex.js";

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
  const { events, assistantText } = await run(agent, cwd);
  if (agent === "codex") {
    assert(events.some((event) => event.type === "thread.started"), "missing thread.started");
    assert(events.some((event) => event.type === "turn.completed"), "missing turn.completed");
    assert(assistantText.includes(marker), "missing expected Codex agent message");
  } else {
    assert(events.some((event) => event.type === "system" && event.session_id), "missing Claude session id");
    assert(events.some((event) => event.type === "result" && !event.is_error), "missing successful Claude result");
    assert(assistantText.includes(marker), "missing expected Claude text delta");
  }
  console.log(`${agent} adapter live smoke passed`);
} finally {
  rmSync(cwd, { recursive: true, force: true });
}

function run(selectedAgent, workingDirectory) {
  return new Promise((resolvePromise, reject) => {
    const argv = selectedAgent === "codex"
      ? buildCodexArgv({ prompt, permission: "read-only" })
      : buildClaudeArgv({ permission: "plan" });
    const child = spawn(selectedAgent, argv, {
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
      timeoutError = new Error(`${selectedAgent} adapter live smoke timed out`);
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

    child.once("error", (error) => finish(new Error(`${selectedAgent} could not start: ${error.message}`)));
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
        if (selectedAgent === "claude" && event.type === "result" && child.stdin.writable) {
          child.stdin.end();
        }
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
      else finish(new Error(`${selectedAgent} adapter live smoke exited ${code ?? signal ?? "unknown"}`));
    });

    if (selectedAgent === "claude") {
      child.stdin.write(`${JSON.stringify(buildClaudeUserMessage(prompt))}\n`);
    } else {
      child.stdin.end();
    }

    function recordEvent(event) {
      events.push(event);
      if (selectedAgent === "codex" && event.type === "item.completed" && event.item?.type === "agent_message") {
        assistantText += event.item.text ?? "";
      }
      if (
        selectedAgent === "claude" &&
        event.type === "stream_event" &&
        event.event?.type === "content_block_delta" &&
        event.event?.delta?.type === "text_delta"
      ) {
        assistantText += event.event.delta.text ?? "";
      }
    }
  });
}

function positiveMs(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
