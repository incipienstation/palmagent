import { ApplicationError } from "../../../../kernel/errors.js";
import type { AdmissionInbox } from "../ports/outbound/admission-inbox.js";
import type { TaskUseCases } from "../ports/inbound/task-use-cases.js";

/** Called serially by the process holding runtime.lock. A crash before finish
 * repeats only the original client request against the Task owner's durable receipt. */
export async function drainAdmission(inbox: AdmissionInbox, service: TaskUseCases, stopped: () => boolean) {
  while (!stopped()) {
    const next = inbox.next();
    if (!next || service.updating) return;
    const { command } = next;
    try {
      if (command.kind === "create") {
        const input = command.input;
        const skills = await service.resolveSkills({ repoId: input.repoId, agent: input.agent }, input.skills);
        if (stopped()) return;
        inbox.assertOwner();
        service.createTask({ ...input, skills });
      } else {
        const skills = await service.resolveMessageSkills(command.taskId, command.input);
        if (stopped()) return;
        inbox.assertOwner();
        service.submitMessage(command.taskId, { ...command.input, skills });
      }
      inbox.finish(next.sequence, { state: "applied" });
    } catch (error) {
      if (error instanceof ApplicationError && error.code === "update_in_progress") return;
      if (!(error instanceof ApplicationError)) throw error;
      inbox.finish(next.sequence, { state: "rejected", code: error.code, reason: error.message });
    }
  }
}
