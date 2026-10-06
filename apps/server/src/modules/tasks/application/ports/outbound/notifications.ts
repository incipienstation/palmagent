import type { PushPayload, PushSubscriptionJson } from "@palmagent/shared";

export interface PushRepository {
  upsertPushSub(subscription: PushSubscriptionJson, now: number): void;
  deletePushSub(endpoint: string): void;
  listPushSubs(): PushSubscriptionJson[];
}

export interface TaskPushNotifier {
  notify(payload: PushPayload): void;
}
