import type { HttpRuntime } from "../../../../platform/http/types.js";
import type { RoutineUseCases } from "../../application/ports/inbound/routine-use-cases.js";
export interface HttpDependencies extends HttpRuntime { routines: RoutineUseCases }
