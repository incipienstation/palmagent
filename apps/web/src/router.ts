import { useSyncExternalStore } from "react";

// Minimal hash router — no dependency, free back-button support. Routes:
//   #/                  inbox
//   #/new               dispatch form
//   #/task/:id          task detail
//   #/routines          scheduled dispatch
//   #/usage             per-agent usage stats
//   #/enroll/:token     passkey enrollment (host-CLI-minted link)
export type Route =
  | { name: "inbox" }
  | { name: "new" }
  | { name: "task"; id: string }
  | { name: "routines" }
  | { name: "usage" }
  | { name: "enroll"; token: string };

function parse(hash: string): Route {
  const path = hash.replace(/^#/, "") || "/";
  if (path === "/new") return { name: "new" };
  if (path === "/routines") return { name: "routines" };
  if (path === "/usage") return { name: "usage" };
  const e = /^\/enroll\/(.+)$/.exec(path);
  if (e) return { name: "enroll", token: decodeURIComponent(e[1]) };
  const m = /^\/task\/(.+)$/.exec(path);
  if (m) return { name: "task", id: decodeURIComponent(m[1]) };
  return { name: "inbox" };
}

function subscribe(cb: () => void) {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(
    subscribe,
    () => window.location.hash,
    () => "#/",
  );
  return parse(hash);
}

export const navigate = (path: string, opts?: { replace?: boolean }) => {
  const hash = path.startsWith("#") ? path : `#${path}`;
  if (opts?.replace) {
    // replaceState doesn't fire hashchange, so notify subscribers manually.
    history.replaceState(null, "", hash);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    return;
  }
  window.location.hash = path;
};
export const goBack = () => window.history.back();
