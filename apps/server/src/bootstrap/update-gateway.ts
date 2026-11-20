import { startUpdateGateway } from "../composition/update-gateway.js";
import { readFileSync } from "node:fs";
if (!process.send || !process.connected) throw new Error("Update gateway requires the updater");
const build = JSON.parse(readFileSync(new URL("./build-info.json", import.meta.url), "utf8"));
const close = await startUpdateGateway(build);
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  void close().finally(() => process.exit());
};
process.once("disconnect", stop);
process.once("SIGTERM", stop);
if (process.connected) process.send({ ready: 1 }); else stop();
