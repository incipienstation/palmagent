import { Pending } from "@/components/ui/spinner";
import { useUpdateBlocker } from "../update-state";
import { useEffect, useRef, useState } from "react";
import { startAuthentication } from "@simplewebauthn/browser";
import { Fingerprint } from "lucide-react";

import { BRANDING, type AuthMe } from "@palmagent/shared";

import { Button } from "@/components/ui/button";
import { useAuthOperations } from "../hooks/remote-operations";
import { AuthScreen, authErrorMessage } from "./AuthScreen";

// Passkey sign-in. The browser offers any discoverable passkey for this RP, so a
// single tap (+ biometric) authenticates — no username, no password.
export function Login({ onAuthenticated, setupKey, methods: initialMethods }: {
  onAuthenticated: () => void; setupKey?: string; methods?: Pick<AuthMe, "credentialCount" | "githubEnabled">;
}) {
  const authOperations = useAuthOperations();
  const pending = useRef(false);
  const [operation, setOperation] = useState<"passkey" | "github">();
  const busy = operation !== undefined;
  useUpdateBlocker(busy);
  const [error, setError] = useState<string | null>(null);

  const [methods, setMethods] = useState(initialMethods);
  useEffect(() => {
    if (setupKey) return;
    let alive = true;
    const refresh = () => { void authOperations.me().then(
      status => { if (alive) setMethods(status); },
      () => { /* Keep the last known methods when the host is offline. */ },
    ); };
    refresh();
    window.addEventListener("focus", refresh);
    return () => { alive = false; window.removeEventListener("focus", refresh); };
  }, [authOperations, setupKey]);
  const passkey = !setupKey && (methods?.credentialCount ?? 1) > 0;
  const githubEnabled = Boolean(setupKey || methods?.githubEnabled);

  async function github() {
    if (pending.current) return;
    pending.current = true;
    setOperation("github");
    setError(null);
    try {
      const { url } = await authOperations.githubStart(setupKey ? { setupKey } : { returnHash: window.location.hash || "#/" });
      window.location.assign(url);
    } catch (e) {
      setError(authErrorMessage(e));
      pending.current = false;
      setOperation(undefined);
    }
  }

  async function signIn() {
    if (pending.current) return;
    pending.current = true;
    setOperation("passkey");
    setError(null);
    try {
      const options = await authOperations.loginOptions();
      const assertion = await startAuthentication({ optionsJSON: options });
      await authOperations.loginVerify(assertion);
      onAuthenticated();
    } catch (e) {
      setError(authErrorMessage(e));
      pending.current = false;
      setOperation(undefined);
    }
  }

  return (
    <AuthScreen
      icon={<span aria-hidden="true" className="size-9 bg-primary" style={{ mask: "url('/logo.svg') center / contain no-repeat" }} />}
      title={BRANDING.displayName}
      subtitle={setupKey ? "Verify the GitHub account you want to use on this installation." : undefined}
    >
      {passkey && <Button size="lg" className="w-full" disabled={busy} onClick={signIn}>
        <Fingerprint className="size-5" />
        {operation === "passkey" ? <Pending>Waiting for passkey…</Pending> : "Sign in with passkey"}
      </Button>}
      {githubEnabled && <Button size="lg" variant={passkey ? "outline" : "default"}
        disabled={busy} onClick={github}> {setupKey ? "Verify GitHub account" : "Sign in with GitHub"}</Button>}
      {!passkey && !githubEnabled && <p className="text-center text-sm text-muted-foreground">Set up a login method on your installation host.</p>}
      {error && <p role="alert" className="text-center text-sm text-destructive">{error}</p>}
    </AuthScreen>
  );
}
