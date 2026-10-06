import { join } from "node:path";
export const sessionSocket = (dataDir: string) => join(dataDir, "session-control.sock");
