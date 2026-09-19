import { useEffect, useRef } from "react";

// Read-cache invalidation runs first at module scope. Mounted screens must also
// reload, otherwise their React state would outlive the cache's freshness window.
export function useForegroundRefresh(refresh: () => void): void {
  const current = useRef(refresh);
  current.current = refresh;
  useEffect(() => {
    const visible = () => { if (document.visibilityState === "visible") current.current(); };
    window.addEventListener("online", visible);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.removeEventListener("online", visible);
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);
}
