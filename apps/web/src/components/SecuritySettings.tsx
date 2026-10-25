import { useEffect, useRef, useState } from "react";
import { startAuthentication } from "@simplewebauthn/browser";
import type { AuthAction } from "@palmagent/shared";
import { useSecurityOperations } from "../hooks/remote-operations";
import { authErrorMessage } from "../auth/AuthScreen";
import { useUpdateBlocker } from "../update-state";
import { Button } from "@/components/ui/button";
import { FieldContent, FieldLabel } from "@/components/ui/field";
import { Separator } from "@/components/ui/separator";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { SettingsCard, SettingsField, SettingsPanel } from "./SettingsLayout";

type Passkey = Awaited<ReturnType<ReturnType<typeof useSecurityOperations>["passkeys"]>>[number];
type Confirmation = { action: "revoke-sessions" } | { action: "remove-passkey"; passkey: Passkey };

export function SecuritySettings() {
  const operations = useSecurityOperations();
  const [passkeys, setPasskeys] = useState<Passkey[]>();
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const [link, setLink] = useState<{ url: string; expiresAt: number }>();
  const [copied, setCopied] = useState(false);
  useUpdateBlocker(busy);
  useEffect(() => {
    let alive = true;
    void operations.me().then(async status => {
      if (!alive) return;
      setEnabled(status.required);
      if (status.required) {
        const keys = await operations.passkeys();
        if (alive) setPasskeys(keys);
      }
    }).catch(error => { if (alive) setError(authErrorMessage(error)); });
    return () => { alive = false; };
  }, [operations]);
  useEffect(() => {
    if (!link) return;
    const timer = setTimeout(() => setLink(undefined), Math.max(0, link.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [link]);

  async function authorize(action: AuthAction) {
    const options = await operations.reauthenticateOptions(action);
    const assertion = await startAuthentication({ optionsJSON: options });
    return (await operations.reauthenticateVerify(assertion)).authorization;
  }
  async function run(action: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(undefined);
    try { await action(); }
    catch (error) { setError(authErrorMessage(error)); }
    finally { pending.current = false; setBusy(false); }
  }
  async function createLink() {
    setLink(undefined); setCopied(false);
    const grant = await operations.enrollToken(await authorize("enroll"));
    setLink({ url: `${window.location.origin}/#/enroll/${grant.token}`, expiresAt: grant.expiresAt });
  }
  async function confirm() {
    if (!confirmation) return;
    const authorization = await authorize(confirmation.action);
    if (confirmation.action === "remove-passkey") await operations.removePasskey(authorization, confirmation.passkey.credentialId);
    else await operations.logoutAll(authorization);
    window.location.reload();
  }
  if (!enabled) return <p className="text-sm text-muted-foreground">Enable sign-in to manage passkeys and devices.</p>;
  return <SettingsPanel aria-label="Security settings">
    <p className="text-sm text-muted-foreground">Verify your passkey to change access. Sign-in requires your device PIN or biometrics.</p>
    <SettingsCard>
      <SettingsField orientation="vertical">
        <FieldLabel>Passkeys</FieldLabel>
        {!passkeys && !error && <p role="status">Loading passkeys…</p>}
        {passkeys?.map(passkey => <div key={passkey.credentialId} className="flex items-center justify-between gap-3">
          <FieldContent>
            <span className="text-sm">{passkey.label || "Passkey"}</span>
            <span className="text-xs text-muted-foreground">Added {new Date(passkey.createdAt).toLocaleDateString()}</span>
          </FieldContent>
          <Button variant="outline" size="sm" disabled={busy || passkeys.length < 2}
            aria-label={`Remove ${passkey.label || "passkey"}`} onClick={() => { setError(undefined); setConfirmation({ action: "remove-passkey", passkey }); }}>Remove</Button>
        </div>)}
        {passkeys?.length === 1 && <p className="text-xs text-muted-foreground">Add another passkey before removing your last one.</p>}
      </SettingsField>
      <Separator />
      <SettingsField orientation="vertical">
        <Button variant="outline" disabled={busy} onClick={() => void run(createLink)}>Create enrollment link</Button>
        {link && <>
          <p className="text-xs text-muted-foreground">This link grants account access once, for 15 minutes. Share it only with your own device.</p>
          <a className="break-all text-sm underline" href={link.url}>{link.url}</a>
          <Button variant="outline" size="sm" onClick={() => void navigator.clipboard.writeText(link.url).then(() => setCopied(true), () => setError("Couldn't copy the link. Select and copy it instead."))}>{copied ? "Copied" : "Copy link"}</Button>
        </>}
      </SettingsField>
    </SettingsCard>
    <Button variant="destructive" disabled={busy} onClick={() => { setError(undefined); setConfirmation({ action: "revoke-sessions" }); }}>Sign out all devices</Button>
    {busy && <p role="status" className="text-sm">Waiting for passkey verification…</p>}
    {error && !confirmation && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <AlertDialog open={!!confirmation} onOpenChange={open => { if (!open && !busy) setConfirmation(undefined); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{confirmation?.action === "remove-passkey" ? "Remove this passkey?" : "Sign out all devices?"}</AlertDialogTitle>
          <AlertDialogDescription>
            {confirmation?.action === "remove-passkey" ? "Verify with a different passkey. This removes the selected passkey and signs out every device, including this one." : "Verify your passkey to end every login, including this one. Your passkeys remain registered."}
            {" "}Unused enrollment links will also stop working. Running tasks continue.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={busy} onClick={event => { event.preventDefault(); void run(confirm); }}>Verify and continue</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </SettingsPanel>;
}
