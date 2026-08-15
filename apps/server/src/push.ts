import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import webpush from "web-push";
import type { PushPayload, PushSubscriptionJson } from "@palmagent/shared";
import type { Db } from "./db.js";

// Web Push. VAPID keys are generated once and persisted next to the DB so
// subscriptions survive restarts (rotating keys would orphan every subscriber).
// Sends are fire-and-forget: a push failure must never affect the task loop.
// 404/410 from the push service mean the subscription is gone — prune it.

export class PushService {
  private publicKey: string;
  private readonly enabled: boolean;

  constructor(
    private readonly db: Db,
    keyPath: string,
    subject: string | undefined,
  ) {
    // PUSH_SUBJECT is optional with no default — unset means Web Push is simply
    // disabled (we never fabricate a VAPID contact address). See config.ts.
    if (!subject) {
      this.enabled = false;
      this.publicKey = "";
      console.log("[push] disabled — set PUSH_SUBJECT (a mailto: or https URL) to enable Web Push");
      return;
    }
    const keys = loadOrCreateVapidKeys(keyPath);
    this.publicKey = keys.publicKey;
    webpush.setVapidDetails(subject, keys.publicKey, keys.privateKey);
    this.enabled = true;
  }

  getPublicKey(): string {
    return this.publicKey;
  }

  subscribe(sub: PushSubscriptionJson): void {
    if (!sub?.endpoint) throw new Error("subscription.endpoint is required");
    this.db.upsertPushSub(sub, Date.now());
  }

  unsubscribe(endpoint: string): void {
    if (!endpoint) throw new Error("endpoint is required");
    this.db.deletePushSub(endpoint);
  }

  // Broadcast to every stored subscription. Never throws.
  notify(payload: PushPayload): void {
    if (!this.enabled) return; // push disabled (no PUSH_SUBJECT)
    const subs = this.db.listPushSubs();
    if (!subs.length) return;
    const body = JSON.stringify(payload);
    for (const sub of subs) {
      webpush
        .sendNotification(sub as webpush.PushSubscription, body, { TTL: 3600 })
        .catch((err: { statusCode?: number }) => {
          if (err?.statusCode === 404 || err?.statusCode === 410) {
            this.db.deletePushSub(sub.endpoint); // subscription expired/revoked
          } else {
            console.error(`[push] send failed (${err?.statusCode ?? "?"})`);
          }
        });
    }
  }
}

function loadOrCreateVapidKeys(path: string): { publicKey: string; privateKey: string } {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed.publicKey && parsed.privateKey) return parsed;
  } catch {
    /* missing or corrupt — generate below */
  }
  const keys = webpush.generateVAPIDKeys();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(keys, null, 2), { mode: 0o600 });
  console.log(`[push] generated new VAPID keypair at ${path}`);
  return keys;
}
