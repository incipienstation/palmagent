import { HOST_INGRESS_REQUIREMENTS, httpOrigin, type ConnectionInfo } from "@palmagent/shared";
import type { InstallConfig } from "./config.js";

/** Read-only application contract. No proxy choice, certificate paths, or credentials. */
export function connectionInfo(cfg: Pick<InstallConfig, "host" | "port" | "authOrigin" | "rpId">): ConnectionInfo {
  return {
    schemaVersion: 1,
    ingressOwner: "plugin",
    publicOrigin: cfg.authOrigin,
    rpId: cfg.rpId,
    upstream: httpOrigin(cfg.host, cfg.port),
    healthPath: "/api/health",
    proxy: HOST_INGRESS_REQUIREMENTS, httpOrigin,
  } as const;
}
