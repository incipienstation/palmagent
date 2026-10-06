import type { HttpRuntime } from "../../../../platform/http/types.js";
import type { UpdateUseCases } from "../../application/ports/inbound/update-use-cases.js";
import type { SessionAccess } from "../../../../platform/http/types.js";
export interface HttpDependencies extends HttpRuntime { updates?: Pick<UpdateUseCases, "status" | "change" | "action">; auth: SessionAccess }
