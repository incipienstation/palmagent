import { useSyncExternalStore } from "react";
import { navigationHash, subscribeNavigation } from "./navigation";
export { navigate, goBack } from "./navigation";

// Minimal hash router — no dependency, free back-button support. Routes:
//   #/                  inbox
//   #/new               dispatch form
//   #/task/:id          task detail
//   #/routines          scheduled dispatch
//   #/usage             per-agent usage stats
//   #/enroll/:token     passkey enrollment (host-CLI-minted link)
export type Route =
  | { name: "inbox" }
  | { name: "terminals"; repoId?: string; taskId?: string }
  | { name: "new" }
  | { name: "task"; id: string }
  | { name: "routines" }
  | { name: "usage" }
  | { name: "enroll"; token: string };

function parse(hash: string): Route {
  const path = hash.replace(/^#/, "") || "/";
  if (path === "/terminals") return { name: "terminals" };
  const terminalTask = /^\/terminals\/task\/(.+)$/.exec(path);
  if (terminalTask) return { name: "terminals", taskId: decodeURIComponent(terminalTask[1]) };
  const terminalRepo = /^\/terminals\/repo\/(.+)$/.exec(path);
  if (terminalRepo) return { name: "terminals", repoId: decodeURIComponent(terminalRepo[1]) };
  if (path === "/new") return { name: "new" };
  if (path === "/routines") return { name: "routines" };
  if (path === "/usage") return { name: "usage" };
  const e = /^\/enroll\/(.+)$/.exec(path);
  if (e) return { name: "enroll", token: decodeURIComponent(e[1]) };
  const m = /^\/task\/(.+)$/.exec(path);
  if (m) return { name: "task", id: decodeURIComponent(m[1]) };
  return { name: "inbox" };
}

export function useRoute(): Route {
  return parse(useSyncExternalStore(subscribeNavigation, navigationHash, () => "#/"));
}
