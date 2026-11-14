import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { startViewServer } from "../composition/view-server.js";

const [socket, directory] = process.argv.slice(2);
if (!process.send || !process.connected || !socket || !directory) throw new Error("The API owner must launch the web view");
let closing = false;
const server = await startViewServer(socket, directory);
const close = () => {
  if (closing) return;
  closing = true;
  void server.close().finally(() => { rmSync(dirname(socket), { recursive: true, force: true }); process.exit(0); });
};
process.on("disconnect", close);
process.once("SIGTERM", close);
process.once("SIGINT", close);
if (!process.connected) close();
else process.send({ ready: 1 }, error => { if (error) close(); });
