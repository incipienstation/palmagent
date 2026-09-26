import { useUpdateBlocker } from "../update-state";
import { useRef, useState } from "react";
import { startRegistration } from "@simplewebauthn/browser";
import { CheckCircle2, KeyRound } from "lucide-react";

import { BRANDING } from "@palmagent/shared";

import { Button } from "@/components/ui/button";
import { useAuthOperations } from "../hooks/remote-operations";
import { AuthScreen, authErrorMessage } from "./AuthScreen";

// A coarse, human label for the passkey (shown by the host `--list` command).
function deviceLabel(): string {
  const ua = navigator.userAgent;
  if (/Android/.test(ua)) return "Android";
  if (/iPhone|iPad|iPod/.test(ua)) return "iOS";
  if (/Macintosh/.test(ua)) return "macOS";
  if (/Windows/.test(ua)) return "Windows";
  if (/Linux/.test(ua)) return "Linux";
  return "device";
}

// Reached via a host-CLI-minted #/enroll/<token> link. Creates a passkey on THIS
// device and (on success) logs it in. The token is single-use and short-lived.
export function Enroll({ token, onAuthenticated }: { token: string; onAuthenticated: () => void }) {
  const authOperations = useAuthOperations();
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  useUpdateBlocker(busy);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function register() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const options = await authOperations.registerOptions(token);
      const response = await startRegistration({ optionsJSON: options });
      await authOperations.registerVerify(response, deviceLabel());
      setDone(true);
      onAuthenticated();
    } catch (e) {
      setError(authErrorMessage(e));
      pending.current = false;
      setBusy(false);
    }
  }

  if (done) {
    return (
      <AuthScreen
        icon={<CheckCircle2 className="size-7 text-green" />}
        title="Passkey registered"
        subtitle="You're signed in on this device."
      >
        <Button size="lg" className="w-full" onClick={onAuthenticated}>
          <CheckCircle2 className="size-5" /> Continue
        </Button>
      </AuthScreen>
    );
  }

  return (
    <AuthScreen
      icon={<KeyRound className="size-7" />}
      title="Register this device"
      subtitle={`Create a passkey to access ${BRANDING.displayName} here.`}
    >
      <Button size="lg" className="w-full" disabled={busy} onClick={register}>
        <KeyRound className="size-5" />
        {busy ? "Creating passkey…" : "Register this device"}
      </Button>
      {error && <p role="alert" className="text-center text-sm text-destructive">{error}</p>}
      <p className="mt-4 text-center text-xs text-faint">
        Enrollment links are single-use and expire after 15 minutes.
      </p>
    </AuthScreen>
  );
}
