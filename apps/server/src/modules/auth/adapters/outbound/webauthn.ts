import { randomBytes } from "node:crypto";
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import type { AuthenticatorTransportFuture, RegistrationResponseJSON } from "@simplewebauthn/server";
import { BRANDING } from "@palmagent/shared";
import type { Passkeys } from "../../application/ports/outbound/passkeys.js";

// Stable opaque userHandle. Changing this is not part of a layout migration.
const USER_ID = new Uint8Array([161, 133, 121, 187, 209, 33, 68, 243, 159, 173, 110, 138, 162, 49, 88, 53]);
export const webauthn: Passkeys = {
  token: bytes => randomBytes(bytes).toString("base64url"),
  registrationOptions(settings, existing) {
    return generateRegistrationOptions({ rpName: settings.rpName, rpID: settings.rpId,
      userName: BRANDING.displayName, userID: USER_ID, attestationType: "none",
      excludeCredentials: existing.map(c => ({ id: c.credentialId, transports: c.transports as AuthenticatorTransportFuture[] | undefined })),
      authenticatorSelection: { residentKey: "required", userVerification: "preferred" } });
  },
  authenticationOptions(settings) {
    return generateAuthenticationOptions({ rpID: settings.rpId, userVerification: "preferred", allowCredentials: [] });
  },
  async verifyRegistration(settings, response, challenge) {
    const result = await verifyRegistrationResponse({ response: response as RegistrationResponseJSON,
      expectedChallenge: challenge, expectedOrigin: settings.authOrigin, expectedRPID: settings.rpId, requireUserVerification: false });
    if (!result.verified || !result.registrationInfo) return;
    const credential = result.registrationInfo.credential;
    return { credentialId: credential.id, publicKey: Buffer.from(credential.publicKey).toString("base64url"),
      counter: credential.counter, transports: credential.transports };
  },
  async verifyAuthentication(settings, response, challenge, credential) {
    const result = await verifyAuthenticationResponse({ response,
      expectedChallenge: challenge, expectedOrigin: settings.authOrigin, expectedRPID: settings.rpId, requireUserVerification: false,
      credential: { id: credential.credentialId, publicKey: new Uint8Array(Buffer.from(credential.publicKey, "base64url")),
        counter: credential.counter, transports: credential.transports as AuthenticatorTransportFuture[] | undefined } });
    return result.verified ? result.authenticationInfo.newCounter : undefined;
  },
};
