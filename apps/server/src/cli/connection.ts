import { HOST_INGRESS_REQUIREMENTS, type ConnectionInfo } from "@palmagent/shared";
import type { InstallConfig } from "./config.js";

/** Read-only application contract. No proxy choice, certificate paths, or credentials. */
export function connectionInfo(cfg: Pick<InstallConfig, "host" | "port" | "authOrigin" | "rpId">): ConnectionInfo {
  const host = cfg.host.includes(":") ? `[${cfg.host}]` : cfg.host;
  return {
    schemaVersion: 1,
    ingressOwner: "plugin",
    publicOrigin: cfg.authOrigin,
    rpId: cfg.rpId,
    upstream: `http://${host}:${cfg.port}`,
    healthPath: "/api/health",
    proxy: HOST_INGRESS_REQUIREMENTS,
  } as const;
}
