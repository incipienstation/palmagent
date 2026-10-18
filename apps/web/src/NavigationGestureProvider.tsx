import { createContext, useContext, useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { createNavigationGesturePolicy } from "./navigation-gesture-policy";

const Context = createContext<ReturnType<typeof createNavigationGesturePolicy> | null>(null);

export function NavigationGestureProvider({ children }: { children: ReactNode }) {
  const [policy] = useState(createNavigationGesturePolicy);
  return <Context.Provider value={policy}>{children}</Context.Provider>;
}

function usePolicy() {
  const policy = useContext(Context);
  if (!policy) throw new Error("Navigation gestures require NavigationGestureProvider");
  return policy;
}

export function useBlockNavigationGestures(active: boolean) {
  const policy = usePolicy();
  useLayoutEffect(() => active ? policy.acquire() : undefined, [active, policy]);
}

export function useNavigationGesturesBlocked() {
  const policy = usePolicy();
  return useSyncExternalStore(policy.subscribe, policy.isBlocked, policy.isBlocked);
}
