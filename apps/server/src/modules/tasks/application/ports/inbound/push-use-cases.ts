import type { PushPayload, PushSubscriptionJson } from "@palmagent/shared";

/** Operations accepted by the tasks module. */
export interface PushUseCases {
  close(): void;
  getPublicKey(): string;
  subscribe(sub: PushSubscriptionJson): void;
  unsubscribe(endpoint: string): void;
  notify(payload: PushPayload): void;
}
