import type { ExecutionCommandResult } from "@palmagent/shared/executions";
import type { RunHandle } from "../../domain/run-handle.js";
import type { ExecutionStore } from "./execution-store.js";
import type { ExecutionPersistence } from "./execution-persistence.js";

/** Claim and settle may retry; the intervening provider write must run at most once. */
export async function drainExecutionCommands(store: ExecutionStore, persistence: ExecutionPersistence,
  id: string, handle: RunHandle, stopping: () => boolean): Promise<void> {
  for (const command of await persistence.run("pending", () => store.pending(id))) {
    if (stopping()) return;
    let result: ExecutionCommandResult = "unknown";
    try {
      const body = command.body;
      let accepted = false;
      switch (body.kind) {
        case "send": result = await handle.send?.(body.text, body.images, body.messageId, body.skills) ?? "rejected"; break;
        case "steer": accepted = handle.steer(body.text, body.images); break;
        case "answer": accepted = await handle.answer(body.answer); break;
        case "approve": accepted = handle.approve(body.decision, body.scope); break;
        case "interrupt": accepted = handle.interrupt(); if (!accepted) { handle.cancel(); accepted = true; } break;
        case "cancel": handle.cancel(); accepted = true; break;
      }
      if (body.kind !== "send") result = accepted ? "delivered" : "rejected";
    } catch { /* Sending to a provider and persisting its receipt cannot be atomic. */ }
    if (stopping()) return;
    await persistence.run("settle", () => store.settle(id, command.id, result));
  }
}
