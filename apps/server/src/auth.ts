import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { BRANDING } from "@palmagent/shared";
import { config } from "./config.js";
import type { Db } from "./db.js";
import { HttpError } from "./service.js";

// In-app WebAuthn (passkey) auth. Unauthenticated API calls get plain 401 JSON
// so a client can show an in-app login. One logical user, N passkeys.
//
// The two-step WebAuthn ceremonies (options → verify) need the server-issued
// challenge to survive between the two requests. We keep it in memory keyed by a
// random id carried in a short-lived `wa_chal` cookie; a process restart just makes
// the user re-tap. Sessions are opaque random tokens persisted in SQLite (trivial
// revocation, no signing-secret management) delivered as an HttpOnly cookie.

// WebAuthn userHandle: a stable, opaque, non-human-facing identifier used only
// when registering new credentials. Authentication resolves existing credentials
// by credential id, so changing to this public-repository constant does not
// invalidate passkeys registered by an older installation. Do not edit again.
const USER_ID = new Uint8Array([161, 133, 121, 187, 209, 33, 68, 243, 159, 173, 110, 138, 162, 49, 88, 53]);
// Human-readable name shown in the authenticator UI (single logical user).
const USER_NAME = BRANDING.displayName;
const CHALLENGE_COOKIE = "wa_chal";
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
// /api/auth/*/options is unauthenticated; cap the in-memory challenge map so a
// flood of them can't grow memory unbounded. Oldest entries are evicted first
// (insertion-ordered Map) — a legitimate single user needs only a handful.
const MAX_CHALLENGES = 2000;

interface ChallengeEntry {
  challenge: string;
  expiresAt: number;
  kind: "reg" | "auth";
  enrollToken?: string; // when registration was authorized by a host enroll token
}

export interface AuthStatus {
  authenticated: boolean;
  required: boolean;
  credentialCount: number;
}

// ---- cookie helpers (Node's http has none) ----
export function parseCookies(req: IncomingMessage): Record<string, string> {
  const header = req.headers.cookie;
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function serializeCookie(name: string, value: string, maxAgeSec: number): string {
  // Secure + HttpOnly + SameSite=Lax: same-origin only (EventSource sends it
  // automatically), not readable by JS, not sent on cross-site sub-requests.
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${maxAgeSec}`,
  ];
  return parts.join("; ");
}

export class AuthService {
  private challenges = new Map<string, ChallengeEntry>();

  constructor(private readonly db: Db) {}

  get enabled(): boolean {
    return config.authEnabled;
  }

  status(req: IncomingMessage): AuthStatus {
    return {
      authenticated: this.verifyRequest(req),
      required: config.authEnabled,
      credentialCount: this.db.countCredentials(),
    };
  }

  // ---- session ----
  /** True if the request carries a valid, unexpired session cookie. Slides the expiry. */
  verifyRequest(req: IncomingMessage): boolean {
    const token = parseCookies(req)[config.cookieName];
    if (!token) return false;
    const now = Date.now();
    const sess = this.db.getSession(token);
    if (!sess) return false;
    if (sess.expiresAt <= now) {
      this.db.deleteSession(token);
      return false;
    }
    // Sliding window: refresh when past the first third of the lifetime.
    if (now - sess.createdAt > config.sessionTtlMs / 3) {
      this.db.refreshSession(token, now + config.sessionTtlMs);
    }
    return true;
  }

  private issueSession(label?: string): string {
    const token = randomBytes(32).toString("base64url");
    const now = Date.now();
    this.db.createSession(token, now, now + config.sessionTtlMs, label);
    return serializeCookie(config.cookieName, token, Math.floor(config.sessionTtlMs / 1000));
  }

  logout(req: IncomingMessage): string {
    const token = parseCookies(req)[config.cookieName];
    if (token) this.db.deleteSession(token);
    return serializeCookie(config.cookieName, "", 0);
  }

  // ---- challenge bookkeeping ----
  private putChallenge(entry: ChallengeEntry): string {
    this.pruneChallenges();
    // Hard cap (DoS backstop): evict oldest entries beyond the limit.
    while (this.challenges.size >= MAX_CHALLENGES) {
      const oldest = this.challenges.keys().next().value;
      if (oldest === undefined) break;
      this.challenges.delete(oldest);
    }
    const id = randomBytes(18).toString("base64url");
    this.challenges.set(id, entry);
    return id;
  }
  private takeChallenge(req: IncomingMessage, kind: "reg" | "auth"): ChallengeEntry {
    const id = parseCookies(req)[CHALLENGE_COOKIE];
    const entry = id ? this.challenges.get(id) : undefined;
    if (!entry || entry.kind !== kind || entry.expiresAt <= Date.now()) {
      if (id) this.challenges.delete(id);
      throw new HttpError(400, "challenge expired — restart the passkey flow");
    }
    this.challenges.delete(id); // single use
    return entry;
  }
  private pruneChallenges() {
    const now = Date.now();
    for (const [id, e] of this.challenges) if (e.expiresAt <= now) this.challenges.delete(id);
  }
  private challengeCookie(id: string): string {
    return serializeCookie(CHALLENGE_COOKIE, id, Math.floor(CHALLENGE_TTL_MS / 1000));
  }

  // ---- registration (add a passkey) ----
  /** Authorized either by a valid host enroll token OR an existing session. */
  async beginRegistration(
    req: IncomingMessage,
    enrollToken?: string,
  ): Promise<{ options: PublicKeyCredentialCreationOptionsJSON; setCookie: string }> {
    const sessionAuthorized = this.verifyRequest(req);
    const tokenValid = !!enrollToken && this.db.isEnrollTokenValid(enrollToken, Date.now());
    if (!sessionAuthorized && !tokenValid) {
      throw new HttpError(403, "registration requires a valid enroll token (mint one with the host CLI)");
    }
    const existing = this.db.listCredentials();
    const options = await generateRegistrationOptions({
      rpName: config.rpName,
      rpID: config.rpId,
      userName: USER_NAME,
      userID: USER_ID,
      attestationType: "none",
      excludeCredentials: existing.map((c) => ({
        id: c.credentialId,
        transports: c.transports as AuthenticatorTransportFuture[] | undefined,
      })),
      authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
    });
    const id = this.putChallenge({
      challenge: options.challenge,
      expiresAt: Date.now() + CHALLENGE_TTL_MS,
      kind: "reg",
      enrollToken: tokenValid ? enrollToken : undefined,
    });
    return { options, setCookie: this.challengeCookie(id) };
  }

  async finishRegistration(
    req: IncomingMessage,
    response: RegistrationResponseJSON,
    label?: string,
  ): Promise<{ setCookies: string[] }> {
    const entry = this.takeChallenge(req, "reg");
    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: entry.challenge,
      expectedOrigin: config.authOrigin,
      expectedRPID: config.rpId,
      requireUserVerification: false,
    });
    if (!verification.verified || !verification.registrationInfo) {
      throw new HttpError(400, "passkey registration could not be verified");
    }
    // Burn the enroll token only now that registration actually succeeded.
    if (entry.enrollToken && !this.db.consumeEnrollToken(entry.enrollToken, Date.now())) {
      throw new HttpError(400, "enroll token already used or expired");
    }
    const cred = verification.registrationInfo.credential;
    const now = Date.now();
    this.db.insertCredential({
      credentialId: cred.id,
      publicKey: Buffer.from(cred.publicKey).toString("base64url"),
      counter: cred.counter,
      transports: cred.transports,
      label: label?.slice(0, 64) || null,
      createdAt: now,
      lastUsedAt: now,
    });
    return { setCookies: [this.issueSession(label), serializeCookie(CHALLENGE_COOKIE, "", 0)] };
  }

  // ---- authentication (sign in) ----
  async beginAuthentication(): Promise<{
    options: PublicKeyCredentialRequestOptionsJSON;
    setCookie: string;
  }> {
    // Empty allowCredentials → the platform offers any discoverable passkey for this RP.
    const options = await generateAuthenticationOptions({
      rpID: config.rpId,
      userVerification: "preferred",
      allowCredentials: [],
    });
    const id = this.putChallenge({
      challenge: options.challenge,
      expiresAt: Date.now() + CHALLENGE_TTL_MS,
      kind: "auth",
    });
    return { options, setCookie: this.challengeCookie(id) };
  }

  async finishAuthentication(
    req: IncomingMessage,
    response: AuthenticationResponseJSON,
  ): Promise<{ setCookies: string[] }> {
    const entry = this.takeChallenge(req, "auth");
    const cred = this.db.getCredential(response.id);
    if (!cred) throw new HttpError(400, "unknown passkey");
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: entry.challenge,
      expectedOrigin: config.authOrigin,
      expectedRPID: config.rpId,
      credential: {
        id: cred.credentialId,
        publicKey: new Uint8Array(Buffer.from(cred.publicKey, "base64url")),
        counter: cred.counter,
        transports: cred.transports as AuthenticatorTransportFuture[] | undefined,
      },
      requireUserVerification: false,
    });
    if (!verification.verified) throw new HttpError(401, "passkey assertion failed");
    this.db.bumpCredentialCounter(cred.credentialId, verification.authenticationInfo.newCounter, Date.now());
    return { setCookies: [this.issueSession(cred.label ?? undefined), serializeCookie(CHALLENGE_COOKIE, "", 0)] };
  }

  // Mint a single-use, 15-minute enroll token (used by the host CLI, and by the
  // authenticated "add this device" flow).
  mintEnrollToken(): { token: string; expiresAt: number } {
    const token = randomBytes(24).toString("base64url");
    const expiresAt = Date.now() + 15 * 60 * 1000;
    this.db.createEnrollToken(token, expiresAt);
    return { token, expiresAt };
  }
}
