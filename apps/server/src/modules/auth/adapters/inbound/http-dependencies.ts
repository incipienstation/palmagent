import type { HttpRuntime } from "../../../../platform/http/types.js";
import type { AuthUseCases } from "../../application/ports/inbound/auth-use-cases.js";
export interface HttpDependencies extends HttpRuntime { auth: AuthUseCases }
