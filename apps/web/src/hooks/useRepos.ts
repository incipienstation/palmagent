import { useCallback, useEffect, useRef, useState } from "react";
import type { Repo } from "@palmagent/shared";
import { api } from "../api";

// Client-side repoId → Repo lookup, so a task card can show WHICH project it
// belongs to. The task wire contract (TaskState) carries only `repoId`; the
// human-friendly repo name lives on the Repo objects from GET /api/repos. This
// is the same join the dispatch form and the routines screen already do — kept
// out of the TaskState DTO so the server/daemon contract stays untouched.
//
// Fetched once on mount; `refresh()` re-pulls on demand (the inbox calls it when
// a task references a repo we haven't seen yet — e.g. one registered since the
// last fetch — so a freshly-dispatched task's chip self-heals).
export function useRepos(): { repos: Map<string, Repo>; refresh: () => void } {
  const [repos, setRepos] = useState<Map<string, Repo>>(() => new Map());
  const inFlight = useRef(false);

  const refresh = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    void api
      .listRepos()
      .then((list) => setRepos(new Map(list.map((r) => [r.id, r]))))
      .catch(() => {
        /* transient (offline/proxy blip) — keep the last good map; a later
           refresh retries. A missing chip degrades gracefully (renders nothing). */
      })
      .finally(() => {
        inFlight.current = false;
      });
  }, []);

  useEffect(refresh, [refresh]);

  return { repos, refresh };
}
