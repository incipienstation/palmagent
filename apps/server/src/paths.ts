import { homedir } from "node:os";
import { join } from "node:path";

// Users type paths with the shell habit ("~/code/x") — especially on a phone
// keyboard. path.resolve treats "~" literally, so expand it first.
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}
