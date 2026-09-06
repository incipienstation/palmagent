import { useEffect, useState, type ReactNode } from "react";

import { api, setOnUnauthorized } from "../api";
import { navigate, useRoute } from "../router";
import { Enroll } from "./Enroll";
import { Login } from "./Login";

type Phase = "loading" | "authed" | "unauthed";

// Gates the whole app on auth. On mount it asks /api/auth/me; any later 401 (via
// the api client) or a logged-out stream probe flips it back to the login screen.
// When the server doesn't enforce auth in development (me.required === false) the gate
// is transparent. The #/enroll/<token> route always renders, authed or not.
export function AuthGate({ children }: { children: ReactNode }) {
  const route = useRoute();
  const [phase, setPhase] = useState<Phase>("loading");

  useEffect(() => {
    setOnUnauthorized(() => setPhase("unauthed"));
    let alive = true;
    api.auth.me().then(
      (me) => alive && setPhase(me.authenticated || !me.required ? "authed" : "unauthed"),
      // Offline first-load with no cached me() — fall back to the login screen.
      () => alive && setPhase("unauthed"),
    );
    return () => {
      alive = false;
      setOnUnauthorized(null);
    };
  }, []);

  if (route.name === "enroll") {
    return (
      <Enroll
        token={route.token}
        onAuthenticated={() => {
          setPhase("authed");
          navigate("/");
        }}
      />
    );
  }
  if (phase === "loading") return <div className="h-app bg-background" />; // brief, avoids a flash
  if (phase === "unauthed") return <Login onAuthenticated={() => setPhase("authed")} />;
  return <>{children}</>;
}
