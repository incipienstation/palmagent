export type UpdateEffect =
  | { op: "resolve" | "refreshPlugins" | "verifyCurrent" | "stage" | "openGateway" | "admission" | "preferences" | "prepareIntent" | "needsSwitch" | "configure" | "restart" | "verify" | "commit" | "restore" }
  | { op: "record"; status: "applying" | "deferred" | "succeeded" | "failed"; reason: string }
  | { op: "report"; message: string }
  | { op: "recoveryReceipt"; restored: boolean };

export type StandaloneUpdate = (
  request: { resume: boolean; automatic: boolean; recoverApplication: boolean },
  effect: (command: UpdateEffect) => Promise<unknown>,
) => Promise<boolean>;
