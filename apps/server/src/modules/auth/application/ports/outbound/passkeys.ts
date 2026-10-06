import type { StoredCredential } from "../../../domain/credential.js";

export interface AuthSettings {
  authEnabled: boolean; authOrigin: string; rpName: string; rpId: string;
  sessionTtlMs: number;
}
export interface CredentialResponse {
  id: string; rawId: string; type: "public-key";
  authenticatorAttachment?: "platform" | "cross-platform";
  clientExtensionResults: Record<string, unknown>;
}
export interface RegistrationResponse extends CredentialResponse {
  response: { clientDataJSON: string; attestationObject: string; transports?: string[] };
}
export interface AuthenticationResponse extends CredentialResponse {
  response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string };
}
export interface RegistrationOptions {
  challenge: string;
  rp: { name: string; id?: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: { type: "public-key"; alg: number }[];
}
export interface AuthenticationOptions { challenge: string; rpId?: string }
/** Only JSON protocol values cross this port; crypto and byte encoding stay in the adapter. */
export interface Passkeys {
  registrationOptions(settings: AuthSettings, existing: StoredCredential[]): Promise<RegistrationOptions>;
  authenticationOptions(settings: AuthSettings): Promise<AuthenticationOptions>;
  verifyRegistration(settings: AuthSettings, response: RegistrationResponse, challenge: string): Promise<Pick<StoredCredential, "credentialId" | "publicKey" | "counter" | "transports"> | undefined>;
  verifyAuthentication(settings: AuthSettings, response: AuthenticationResponse, challenge: string, credential: StoredCredential): Promise<number | undefined>;
  token(bytes: number): string;
}
