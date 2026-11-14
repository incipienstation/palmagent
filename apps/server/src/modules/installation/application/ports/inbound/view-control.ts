/** Local installation-owner controls. Never exposed on the browser API. */
export type ViewStatus = {
  protocol: 1;
  ownerPid: number;
  state: "starting" | "ready" | "unavailable" | "stopped";
  generation: number;
  pid?: number;
};
export interface ViewControl {
  status(): ViewStatus;
  restart(): Promise<ViewStatus>;
}
