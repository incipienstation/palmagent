/** Transport requirements consumed by host-aware operator plugins. */
export const HOST_INGRESS_REQUIREMENTS = {
  preserveHost: true,
  publicHttpsRequired: true,
  cacheApi: false,
  maxBodyBytes: 48_000_000,
  sse: { path: "/api/stream", buffering: false, readTimeoutSeconds: 3600 },
  websocket: { pathPattern: "/api/terminals/:id/stream", upgrade: true, idleTimeoutSeconds: 60 },
  perClientLimits: { authRequestsPerSecond: 5, authBurst: 10, apiRequestsPerSecond: 20, apiBurst: 40, apiConnections: 30, terminalConnections: 16 },
} as const;

export interface ConnectionInfo {
  schemaVersion: 1;
  ingressOwner: "plugin";
  publicOrigin: string;
  rpId: string;
  upstream: string;
  healthPath: "/api/health";
  proxy: typeof HOST_INGRESS_REQUIREMENTS;
}
