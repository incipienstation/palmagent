import { Hono } from "hono";
import { TelemetryChangeSchema, type TelemetryStatus } from "@palmagent/shared/telemetry";
import type { TelemetrySettings } from "../../application/ports/inbound/settings.js";
import { jsonBody } from "../../../../platform/http/input.js";
import { requireSignIn } from "../../../../platform/http/middleware.js";
import { ApplicationError } from "../../../../kernel/errors.js";

export function telemetryRoutes(settings: TelemetrySettings | undefined, authenticated: boolean) {
  const status = (): TelemetryStatus => settings?.status() ?? { available: false, enabled: true, pendingDisclosure: true };
  return new Hono()
    .get("/", c => c.json({ ...status(), available: authenticated && status().available }, 200))
    .patch("/", requireSignIn(authenticated, "Sign-in must be enabled to change performance sharing."),
      jsonBody(TelemetryChangeSchema), c => {
        if (!settings) throw new ApplicationError("service_unavailable", "Performance sharing is unavailable.");
        return c.json(settings.change(c.req.valid("json").enabled), 200);
      });
}
