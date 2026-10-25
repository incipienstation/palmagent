import { useUpdateBlocker } from "../update-state";
import { useRef, useState } from "react";
import { startAuthentication } from "@simplewebauthn/browser";
import { Fingerprint } from "lucide-react";

import { BRANDING } from "@palmagent/shared";

import { Button } from "@/components/ui/button";
import { useAuthOperations } from "../hooks/remote-operations";
import { AuthScreen, authErrorMessage } from "./AuthScreen";

// Passkey sign-in. The browser offers any discoverable passkey for this RP, so a
// single tap (+ biometric) authenticates — no username, no password.
export function Login({ onAuthenticated }: { onAuthenticated: () => void }) {
  const authOperations = useAuthOperations();
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  useUpdateBlocker(busy);
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const options = await authOperations.loginOptions();
      const assertion = await startAuthentication({ optionsJSON: options });
      await authOperations.loginVerify(assertion);
      onAuthenticated();
    } catch (e) {
      setError(authErrorMessage(e));
      pending.current = false;
      setBusy(false);
    }
  }

  return (
    <AuthScreen
      icon={<span aria-hidden="true" className="size-9 bg-primary" style={{ mask: "url('/logo.svg') center / contain no-repeat" }} />}
      title={BRANDING.displayName}
      subtitle="Sign in with your passkey to continue."
    >
      <Button size="lg" className="w-full" disabled={busy} onClick={signIn}>
        <Fingerprint className="size-5" />
        {busy ? "Waiting for passkey…" : "Sign in with passkey"}
      </Button>
      {error && <p role="alert" className="text-center text-sm text-destructive">{error}</p>}
    </AuthScreen>
  );
}
