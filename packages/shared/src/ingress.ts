/** Transport requirements consumed by host-aware operator plugins. */
import policy from "./ingress-policy.json" with { type: "json" };
export const HOST_INGRESS_REQUIREMENTS = policy;

export interface ConnectionInfo {
  schemaVersion: 1;
  ingressOwner: "plugin";
  publicOrigin: string;
  rpId: string;
  upstream: string;
  healthPath: "/api/health";
  proxy: typeof HOST_INGRESS_REQUIREMENTS;
}
