import { useLayoutEffect, useMemo } from "react";
import { cacheSession } from "../query-lifecycle";

/** Each independent read lane owns one scope; superseded work cannot publish even if abort is ignored. */
export function createRequestScope() {
  let current: AbortController | undefined;
  const cancel = () => { current?.abort(); current = undefined; };
  return {
    cancel,
    begin() {
      cancel();
      const controller = current = new AbortController();
      const generation = cacheSession();
      return { signal: controller.signal,
        isCurrent: () => current === controller && !controller.signal.aborted && generation === cacheSession() };
    },
  };
}

export function useRequestScope(active: boolean) {
  const scope = useMemo(createRequestScope, []);
  useLayoutEffect(() => scope.cancel, [scope, active]);
  return scope;
}
