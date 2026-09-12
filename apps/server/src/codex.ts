import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageAttachment } from "@palmagent/shared";
import type { AgentRunner, Emit, ProcHandle, RawEvent, RunHandle, RunnerBackend, StartArgs } from "./types.js";

// Codex's launch and JSONL protocol live here as executable integration code.
// Keep the dispatch/resume matrix and normalized-event behavior covered by the
// adapter contract tests instead of duplicating version snapshots in docs.
// The sandbox <mode> (+ optional workspace network_access) is derived from the
// task's permission via SANDBOX below; approval_policy is always "never" (exec is
// headless — nothing can answer an approval prompt). See @palmagent/shared
// PERMISSIONS for the catalog. Current CLI flag constraints: there is no
// `--ask-for-approval` flag (use `-c approval_policy=...`), and `resume` rejects
// `--sandbox` (use `-c sandbox_mode=...`). Codex exec has no stdin steer channel —
// the prompt is an argv and the process runs the turn to completion, then exits.
// Images: both `exec` and `exec resume` take `-i/--image <FILE>` (verified on
// 0.138.0) — base64 attachments are spilled to a temp dir, passed by path, and
// the dir is removed when the child exits. Process + stdio are owned by the
// RunnerBackend.

const IMG_EXT: Record<string, string> = {
  "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif",
};

// Returns repeated ["-i", <path>] pairs plus a cleanup fn for the temp dir.
function spillImages(images: ImageAttachment[] | undefined): { argv: string[]; cleanup: () => void } {
  if (!images?.length) return { argv: [], cleanup: () => {} };
  const dir = mkdtempSync(join(tmpdir(), "palmagent-img-"));
  const argv: string[] = [];
  images.forEach((img, i) => {
    const file = join(dir, `img-${i}${IMG_EXT[img.mediaType] ?? ".png"}`);
    writeFileSync(file, Buffer.from(img.data, "base64"));
    argv.push("-i", file);
  });
  return { argv, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// Strategy: map the task's per-agent permission to Codex sandbox flags.
// approval_policy is always "never" (headless). Accepts native values AND the
// legacy shared enum (readonly|auto-edit|full); unknown → the safe default
// (workspace-write). See PERMISSIONS in @palmagent/shared.
interface CodexSandbox {
  mode: string; // sandbox_mode: read-only | workspace-write | danger-full-access
  network?: boolean; // workspace-write only → sandbox_workspace_write.network_access
}
const SANDBOX: Record<string, CodexSandbox> = {
  "read-only": { mode: "read-only" },
  "workspace-write": { mode: "workspace-write" },
  "workspace-write-net": { mode: "workspace-write", network: true },
  "danger-full-access": { mode: "danger-full-access" },
  // legacy shared-enum values (pre per-agent permissions)
  readonly: { mode: "read-only" },
  "auto-edit": { mode: "workspace-write" },
  full: { mode: "danger-full-access" },
};
function codexSandbox(permission?: string): CodexSandbox {
  return SANDBOX[permission ?? ""] ?? SANDBOX["workspace-write"];
}

type CodexLaunchArgs = Pick<StartArgs, "prompt" | "resumeId" | "permission" | "model" | "effort">;

export function buildCodexArgv(
  { prompt, resumeId, permission, model, effort }: CodexLaunchArgs,
  imageArgv: readonly string[] = [],
): string[] {
  // Model and reasoning-effort overrides use -c on both fresh and resumed turns.
  // Supported models and effort levels depend on the installed CLI, selected
  // model, and authenticated account/API access.
  const modelArgs = [
    ...(model ? ["-c", `model=${model}`] : []),
    ...(effort ? ["-c", `model_reasoning_effort=${effort}`] : []),
  ];
  const sb = codexSandbox(permission);
  const sandboxArgs = resumeId ? ["-c", `sandbox_mode=${sb.mode}`] : ["--sandbox", sb.mode];
  const netArgs = sb.network ? ["-c", "sandbox_workspace_write.network_access=true"] : [];
  const common = [
    "--json",
    "--skip-git-repo-check",
    "-c", "approval_policy=never",
    ...sandboxArgs,
    ...netArgs,
    ...modelArgs,
    ...imageArgv,
  ];
  return resumeId
    ? ["exec", "resume", resumeId, prompt, ...common]
    : ["exec", prompt, ...common];
}

export class CodexRunner implements AgentRunner {
  readonly agent = "codex" as const;

  start(args: StartArgs, emit: Emit, backend: RunnerBackend): RunHandle {
    const { taskId, cwd, prompt, images, resumeId, permission, model, effort, reattach } = args;
    let sessionId: string | undefined = resumeId;

    // Reattach to a turn already running in the daemon (post-restart): no respawn,
    // no image spill, no prompt. Replay the full turn to restore terminal state;
    // the service suppresses persisted events using its saved baseline.
    if (reattach) {
      const proc = backend.attach(taskId, 0);
      if (!proc) {
        emit({ taskId, kind: "status", sessionId, payload: { subtype: "reattach_failed" } });
        return { steer: () => false, interrupt: () => false, approve: () => false, answer: () => false, cancel: () => {}, done: Promise.resolve() };
      }
      return this.wire(taskId, proc, emit, () => {}, () => sessionId, (s) => { sessionId = s; });
    }

    const imgs = spillImages(images);
    // Plain-folder tasks require --skip-git-repo-check. Headless execution pins
    // approval_policy=never, while resume expresses sandbox/model settings via
    // -c because it does not accept the dispatch-only flag forms.
    const argv = buildCodexArgv({ prompt, resumeId, permission, model, effort }, imgs.argv);

    const proc = backend.start({ turnId: taskId, command: "codex", argv, cwd, ...(args.providerHome ? { env: { CODEX_HOME: args.providerHome } } : {}) });
    proc.closeStdin(); // we never feed stdin; close it so codex doesn't wait

    return this.wire(taskId, proc, emit, imgs.cleanup, () => sessionId, (s) => { sessionId = s; });
  }

  // Shared stdout/stderr/exit wiring for both the fresh-spawn and reattach paths.
  private wire(
    taskId: string,
    proc: ProcHandle,
    emit: Emit,
    cleanup: () => void,
    getSession: () => string | undefined,
    setSession: (s: string) => void,
  ): RunHandle {
    const emitItem = (item: any, e: (raw: RawEvent) => void) => {
      const sessionId = getSession();
      switch (item?.type) {
        case "agent_message":
          e({ taskId, kind: "assistant_text", sessionId, payload: { text: item.text } });
          break;
        case "reasoning":
          e({ taskId, kind: "status", sessionId, payload: { subtype: "reasoning", text: item.text } });
          break;
        case "command_execution":
          e({ taskId, kind: "tool_call", sessionId,
            payload: { name: "bash", command: item.command, status: item.status } });
          if (item.aggregated_output != null || item.exit_code != null) {
            e({ taskId, kind: "tool_result", sessionId,
              payload: { output: item.aggregated_output, exit_code: item.exit_code } });
          }
          break;
        case "file_change":
          e({ taskId, kind: "tool_call", sessionId, payload: { name: "file_change", changes: item.changes } });
          break;
        case "mcp_tool_call":
        case "web_search":
          e({ taskId, kind: "tool_call", sessionId, payload: { name: item.type, item } });
          break;
        case "error":
          e({ taskId, kind: "error", sessionId, payload: { message: item.message } });
          break;
        default:
          e({ taskId, kind: "status", sessionId, payload: { subtype: item?.type ?? "item", item } });
      }
    };

    proc.onLine((seq, line) => {
      let ev: any;
      try { ev = JSON.parse(line); } catch { return; }
      const e = (raw: RawEvent) => emit(raw, seq);
      const sessionId = getSession();
      switch (ev.type) {
        case "thread.started":
          setSession(ev.thread_id);
          e({ taskId, kind: "status", sessionId: ev.thread_id, payload: { subtype: "thread_started", thread_id: ev.thread_id } });
          break;
        case "turn.started":
          e({ taskId, kind: "status", sessionId, payload: { subtype: "turn_started" } });
          break;
        case "item.started":
          // surface a command as soon as it begins; agent_message is emitted on completion
          if (ev.item?.type === "command_execution") emitItem(ev.item, e);
          break;
        case "item.updated":
          break; // intermediate; we render the completed item
        case "item.completed":
          emitItem(ev.item, e);
          break;
        case "turn.completed":
          e({ taskId, kind: "result", sessionId, payload: { usage: ev.usage } });
          break;
        case "turn.failed":
          e({ taskId, kind: "error", sessionId, payload: { error: ev.error } });
          break;
        case "error":
          e({ taskId, kind: "error", sessionId, payload: { message: ev.message } });
          break;
        default:
          break;
      }
    });

    proc.onStderr((text) => {
      emit({ taskId, kind: "status", sessionId: getSession(), payload: { subtype: "stderr", text } });
    });

    const done = new Promise<void>((resolve) => {
      proc.onExit((code) => {
        cleanup();
        emit({ taskId, kind: "status", sessionId: getSession(), payload: { subtype: "process_exit", code } });
        resolve();
      });
    });

    return {
      // Codex exec has no mid-turn stdin channel. Steering is turn-level via
      // resume — the service queues the text as the next follow-up (fallback).
      steer: () => false,
      // No graceful interrupt channel either — the service falls back to
      // cancel() (SIGINT). Rollouts are written incrementally, so a later turn
      // can resume from the persisted thread.
      interrupt: () => false,
      // approval_policy=never means codex never pauses for approval.
      approve: () => false,
      // Codex exec has no AskUserQuestion / interactive-question channel.
      answer: () => false,
      cancel: () => proc.kill("SIGINT"),
      done,
    };
  }
}
