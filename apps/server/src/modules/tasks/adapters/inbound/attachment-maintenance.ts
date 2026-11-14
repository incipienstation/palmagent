import type { AttachmentMaintenance } from "../../application/ports/inbound/attachment-maintenance.js";
import { ATTACHMENT_MAINTENANCE_MS } from "../../domain/attachment-policy.js";

/** Process-owned scheduling and diagnostics for the retention use case. */
export class AttachmentMaintenanceDriver {
  private timer?: ReturnType<typeof setInterval>;
  constructor(private maintenance: AttachmentMaintenance, private available: () => boolean) {}
  prune(): void {
    try { this.maintenance.prune(); }
    catch { console.warn("[attachments] Cleanup deferred; check database and storage permissions"); }
  }
  start(): void {
    this.close();
    this.prune();
    this.timer = setInterval(() => {
      if (!this.available()) { this.close(); return; }
      this.prune();
    }, ATTACHMENT_MAINTENANCE_MS);
    this.timer.unref();
  }
  close(): void { clearInterval(this.timer); this.timer = undefined; }
}
