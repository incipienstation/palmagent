import { useEffect } from "react";
import { api } from "../api";
import { checkPwaUpdate } from "../pwa";
import { updatesChanged } from "../update-events";
import type { ConnState } from "./sse";

let visiting: Promise<unknown> | undefined;
export function useAccessUpdates(connection: ConnState): void {
  useEffect(() => {
    if (connection !== "open" || document.visibilityState === "hidden") return;
    // The inbox reconnects on foreground/online, so one lifecycle signal covers
    // initial access, mobile resume, and reconnect after a server update.
    void checkPwaUpdate();
    visiting ??= api.updateSettings.action({ action: "visit" })
      .then(() => updatesChanged()).catch(() => {}).finally(() => { visiting = undefined; });
  }, [connection]);
}
