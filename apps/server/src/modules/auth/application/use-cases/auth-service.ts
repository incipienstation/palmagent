import type { AuthUseCases } from "../ports/inbound/auth-use-cases.js";
import type { AuthStatus, AuthCredentials, IssuedToken } from "../../domain/session.js";
import type { Passkeys, AuthSettings, RegistrationResponse, AuthenticationResponse, RegistrationOptions, AuthenticationOptions } from "../ports/outbound/passkeys.js";
import type { AuthRepository } from "../ports/outbound/auth-repository.js";
import { ApplicationError } from "../../../../kernel/errors.js";

// In-app WebAuthn (passkey) auth. Unauthenticated API calls get plain 401 JSON
// so a client can show an in-app login. One logical user, N passkeys.
//
// The two-step WebAuthn ceremonies (options → verify) need the server-issued
// challenge to survive between the two requests. We keep it in memory keyed by a
// random id carried in a short-lived `wa_chal` cookie; a process restart just makes
// the user re-tap. Sessions are opaque random tokens persisted in SQLite (trivial
// revocation, no signing-secret management) delivered as an HttpOnly cookie.

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

export class AuthService implements AuthUseCases {
  private challenges = new Map<string, ChallengeEntry>();

  constructor(private readonly db: AuthRepository, private readonly settings: AuthSettings, private readonly passkeys: Passkeys) {}

  get enabled(): boolean {
    return this.settings.authEnabled;
  }

  status(credentials: AuthCredentials): AuthStatus {
    return {
      authenticated: this.verifySession(credentials.sessionToken),
      required: this.settings.authEnabled,
      credentialCount: this.db.countCredentials(),
    };
  }

  get origin(): string { return this.settings.authOrigin; }

  /** WebSocket checks must not renew the login indefinitely. */
  sessionValid(token: string | undefined): boolean {
    if (!token) return false;
    const session = this.db.getSession(token);
    return !!session && session.expiresAt > Date.now();
  }

  // ---- session ----
  /** True if the request carries a valid, unexpired session cookie. Slides the expiry. */
  verifySession(token: string | undefined): boolean {
    if (!token) return false;
    const now = Date.now();
    const sess = this.db.getSession(token);
    if (!sess) return false;
    if (sess.expiresAt <= now) {
      this.db.deleteSession(token);
      return false;
    }
    // Sliding window: refresh when past the first third of the lifetime.
    if (now - sess.createdAt > this.settings.sessionTtlMs / 3) {
      this.db.refreshSession(token, now + this.settings.sessionTtlMs);
    }
    return true;
  }

  private issueSession(label?: string): IssuedToken {
    const token = this.passkeys.token(32);
    const now = Date.now();
    this.db.createSession(token, now, now + this.settings.sessionTtlMs, label);
    return { value: token, maxAge: Math.floor(this.settings.sessionTtlMs / 1000) };
  }

  logout(credentials: AuthCredentials): void {
    const token = credentials.sessionToken;
    if (token) this.db.deleteSession(token);
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
    const id = this.passkeys.token(18);
    this.challenges.set(id, entry);
    return id;
  }
  private takeChallenge(credentials: AuthCredentials, kind: "reg" | "auth"): ChallengeEntry {
    const id = credentials.challengeId;
    const entry = id ? this.challenges.get(id) : undefined;
    if (!id || !entry || entry.kind !== kind || entry.expiresAt <= Date.now()) {
      if (id) this.challenges.delete(id);
      throw new ApplicationError("bad_request", "challenge expired — restart the passkey flow");
    }
    this.challenges.delete(id); // single use
    return entry;
  }
  private pruneChallenges() {
    const now = Date.now();
    for (const [id, e] of this.challenges) if (e.expiresAt <= now) this.challenges.delete(id);
  }
  private challengeToken(id: string): IssuedToken {
    return { value: id, maxAge: Math.floor(CHALLENGE_TTL_MS / 1000) };
  }

  // ---- registration (add a passkey) ----
  /** Authorized either by a valid host enroll token OR an existing session. */
  async beginRegistration(
    credentials: AuthCredentials,
    enrollToken?: string,
  ): Promise<{ options: RegistrationOptions; challenge: IssuedToken }> {
    const sessionAuthorized = this.verifySession(credentials.sessionToken);
    const tokenValid = !!enrollToken && this.db.isEnrollTokenValid(enrollToken, Date.now());
    if (!sessionAuthorized && !tokenValid) {
      throw new ApplicationError("forbidden", "registration requires a valid enroll token (mint one with the host CLI)");
    }
    const existing = this.db.listCredentials();
    const options = await this.passkeys.registrationOptions(this.settings, existing);
    const id = this.putChallenge({
      challenge: options.challenge,
      expiresAt: Date.now() + CHALLENGE_TTL_MS,
      kind: "reg",
      enrollToken: tokenValid ? enrollToken : undefined,
    });
    return { options, challenge: this.challengeToken(id) };
  }

  async finishRegistration(
    credentials: AuthCredentials,
    response: RegistrationResponse,
    label?: string,
  ): Promise<{ session: IssuedToken }> {
    const entry = this.takeChallenge(credentials, "reg");
    const credential = await this.passkeys.verifyRegistration(this.settings, response, entry.challenge);
    if (!credential) {
      throw new ApplicationError("bad_request", "passkey registration could not be verified");
    }
    const session = this.db.transaction(() => {
      // Burn the enroll token only now that registration actually succeeded.
      if (entry.enrollToken && !this.db.consumeEnrollToken(entry.enrollToken, Date.now())) {
        throw new ApplicationError("bad_request", "enroll token already used or expired");
      }
      const now = Date.now();
      this.db.insertCredential({
        ...credential,
        label: label?.slice(0, 64) || null,
        createdAt: now,
        lastUsedAt: now,
      });
      return this.issueSession(label);
    });
    return { session };
  }

  // ---- authentication (sign in) ----
  async beginAuthentication(): Promise<{
    options: AuthenticationOptions;
    challenge: IssuedToken;
  }> {
    // Empty allowCredentials → the platform offers any discoverable passkey for this RP.
    const options = await this.passkeys.authenticationOptions(this.settings);
    const id = this.putChallenge({
      challenge: options.challenge,
      expiresAt: Date.now() + CHALLENGE_TTL_MS,
      kind: "auth",
    });
    return { options, challenge: this.challengeToken(id) };
  }

  async finishAuthentication(
    credentials: AuthCredentials,
    response: AuthenticationResponse,
  ): Promise<{ session: IssuedToken }> {
    const entry = this.takeChallenge(credentials, "auth");
    const cred = this.db.getCredential(response.id);
    if (!cred) throw new ApplicationError("bad_request", "unknown passkey");
    const counter = await this.passkeys.verifyAuthentication(this.settings, response, entry.challenge, cred);
    if (counter === undefined) throw new ApplicationError("unauthorized", "passkey assertion failed");
    this.db.bumpCredentialCounter(cred.credentialId, counter, Date.now());
    return { session: this.issueSession(cred.label ?? undefined) };
  }

  // Mint a single-use, 15-minute enroll token (used by the host CLI, and by the
  // authenticated "add this device" flow).
  mintEnrollToken(): { token: string; expiresAt: number } {
    const token = this.passkeys.token(24);
    const expiresAt = Date.now() + 15 * 60 * 1000;
    this.db.createEnrollToken(token, expiresAt);
    return { token, expiresAt };
  }
}
