import type { HttpRuntime } from "../../../../platform/http/types.js";
import type { TaskUseCases } from "../../application/ports/inbound/task-use-cases.js";
import type { PushUseCases } from "../../application/ports/inbound/push-use-cases.js";
import type { LiveEventStream } from "../../../../kernel/events.js";
export interface HttpDependencies extends HttpRuntime {
 service: TaskUseCases; push: Pick<PushUseCases, "getPublicKey" | "subscribe" | "unsubscribe">; hub: LiveEventStream;
}
