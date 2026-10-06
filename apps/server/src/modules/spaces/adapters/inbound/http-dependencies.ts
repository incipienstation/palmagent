import type { SpaceDiscoveryUseCases } from "../../application/ports/inbound/space-discovery.js";
import type { HttpRuntime } from "../../../../platform/http/types.js";
import type { SpaceUseCases } from "../../application/ports/inbound/space-use-cases.js";
import type { SpaceSettings } from "../../application/ports/inbound/space-settings.js";
import type { SessionAccess } from "../../../../platform/http/types.js";
export interface HttpDependencies extends HttpRuntime { service: SpaceUseCases; discovery: SpaceDiscoveryUseCases; settings: SpaceSettings; auth: SessionAccess }
