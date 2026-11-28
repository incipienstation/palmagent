import { AuthScreen } from "./AuthScreen";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useUpdateBlocker } from "../update-state";
import { useEffect, useState, type ReactNode } from "react";

import type { AuthMe } from "@palmagent/shared";
import { useAuthOperations } from "../hooks/remote-operations";
import { cacheSession, onCacheSessionReset } from "../query-lifecycle";
import { navigate, useRoute } from "../router";
import { Enroll } from "./Enroll";
import { Login } from "./Login";

type Phase = "loading" | "authed" | "unauthed";

// Gates the whole app on auth. On mount it asks /api/auth/me; any later 401 (via
// the api client) or a logged-out stream probe flips it back to the login screen.
// When the server doesn't enforce auth in development (me.required === false) the gate
// is transparent. The #/enroll/<token> route always renders, authed or not.
export function AuthGate({ children }: { children: ReactNode }) {
  const authOperations = useAuthOperations();
  const route = useRoute();
  const [methods, setMethods] = useState<Pick<AuthMe, "credentialCount" | "githubEnabled">>();
  const [phase, setPhase] = useState<Phase>("loading");
  useUpdateBlocker(phase === "loading");

  useEffect(() => {
    authOperations.setUnauthorizedHandler(() => setPhase("unauthed"));
    const offSession = onCacheSessionReset(() => setPhase("unauthed"));
    const generation = cacheSession();
    let alive = true;
    authOperations.me().then(
      me => {
        if (!alive || generation !== cacheSession()) return;
        setMethods(me);
        setPhase(me.authenticated || !me.required ? "authed" : "unauthed");
      },
      // Offline first-load cannot verify the session — fall back to the login screen.
      () => alive && generation === cacheSession() && setPhase("unauthed"),
    );
    return () => {
      alive = false;
      offSession();
      authOperations.setUnauthorizedHandler(null);
    };
  }, [authOperations]);

  if (route.name === "github-setup") return <Login setupKey={route.token} onAuthenticated={() => navigate("/")} />;
  if (route.name === "github-verified" || route.name === "github-failed") {
    const verified = route.name === "github-verified";
    return <AuthScreen title={verified ? "GitHub account verified" : "GitHub sign-in failed"}
      subtitle={verified ? "Confirm the displayed account on your installation host to enable sign-in."
        : "Check the selected GitHub account and try again. For setup, reopen the link from your installation host."}>
      <Button onClick={() => window.location.replace("/")}>Continue to Palmagent</Button>
    </AuthScreen>;
  }
  if (route.name === "enroll") {
    return (
      <Enroll
        token={route.token}
        onAuthenticated={() => {
          setMethods(previous => ({ ...previous, credentialCount: Math.max(1, previous?.credentialCount ?? 0) }));
          setPhase("authed");
          navigate("/");
        }}
      />
    );
  }
  if (phase === "loading") return <div role="status" aria-label="Opening Palmagent" className="grid h-full place-items-center bg-background text-muted-foreground"><Spinner className="size-5" /></div>;
  if (phase === "unauthed") return <Login methods={methods} onAuthenticated={() => setPhase("authed")} />;
  return <>{children}</>;
}
