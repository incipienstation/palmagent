import { useState } from "react";
import { startAuthentication } from "@simplewebauthn/browser";
import { Bot, Fingerprint } from "lucide-react";

import { BRANDING } from "@palmagent/shared";

import { Button } from "@/components/ui/button";
import { api } from "../api";
import { AuthScreen, authErrorMessage } from "./AuthScreen";

// Passkey sign-in. The browser offers any discoverable passkey for this RP, so a
// single tap (+ biometric) authenticates — no username, no password.
export function Login({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    setBusy(true);
    setError(null);
    try {
      const options = await api.auth.loginOptions();
      const assertion = await startAuthentication({ optionsJSON: options });
      await api.auth.loginVerify(assertion);
      onAuthenticated();
    } catch (e) {
      setError(authErrorMessage(e));
      setBusy(false);
    }
  }

  return (
    <AuthScreen
      icon={<Bot className="size-7" />}
      title={BRANDING.displayName}
      subtitle="Sign in with your passkey to continue."
    >
      <Button size="lg" className="w-full" disabled={busy} onClick={signIn}>
        <Fingerprint className="size-5" />
        {busy ? "Waiting for passkey…" : "Sign in with passkey"}
      </Button>
      {error && <p className="text-center text-sm text-destructive">{error}</p>}
    </AuthScreen>
  );
}
