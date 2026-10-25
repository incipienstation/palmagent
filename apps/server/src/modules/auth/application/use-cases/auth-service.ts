import type { AuthUseCases } from "../ports/inbound/auth-use-cases.js";
import type { AuthStatus, AuthCredentials, IssuedToken } from "../../domain/session.js";
import type { AuthAction } from "@palmagent/shared";
import type { Passkeys, AuthSettings, RegistrationResponse, AuthenticationResponse, RegistrationOptions, AuthenticationOptions } from "../ports/outbound/passkeys.js";
import type { AuthRepository } from "../ports/outbound/auth-repository.js";
import { ApplicationError } from "../../../../kernel/errors.js";

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_CHALLENGES = 2000;
interface ChallengeEntry {
  challenge: string;
  expiresAt: number;
  kind: "reg" | "auth" | "reauth" | "grant";
  enrollToken?: string;
  sessionToken?: string;
  action?: AuthAction;
  credentialId?: string;
}

/** One logical owner. Passkey ceremonies and action grants are bounded and single-use. */
export class AuthService implements AuthUseCases {
  private challenges = new Map<string, ChallengeEntry>();
  private generation = 0;
  constructor(private readonly db: AuthRepository, private readonly settings: AuthSettings, private readonly passkeys: Passkeys) {}
  get enabled(): boolean { return this.settings.authEnabled; }
  get origin(): string { return this.settings.authOrigin; }
  status(credentials: AuthCredentials): AuthStatus {
    return { authenticated: this.verifySession(credentials.sessionToken), required: this.enabled, credentialCount: this.db.countCredentials() };
  }

  /** Neither requests nor live connections extend the original login lifetime. */
  sessionValid(token: string | undefined): boolean {
    if (!token) return false;
    const session = this.db.getSession(token), now = Date.now();
    return !!session && session.expiresAt > now && session.createdAt + this.settings.sessionTtlMs > now;
  }
  verifySession(token: string | undefined): boolean {
    const valid = this.sessionValid(token);
    if (token && !valid) this.db.deleteSession(token);
    return valid;
  }
  private requireSession(credentials: AuthCredentials): string {
    if (!credentials.sessionToken || !this.sessionValid(credentials.sessionToken)) throw new ApplicationError("unauthorized", "Sign in again to continue");
    return credentials.sessionToken;
  }
  private issueSession(label?: string): IssuedToken {
    const token = this.passkeys.token(32), now = Date.now();
    this.db.createSession(token, now, now + this.settings.sessionTtlMs, label);
    return { value: token, maxAge: Math.floor(this.settings.sessionTtlMs / 1000) };
  }
  logout(credentials: AuthCredentials): void {
    if (!credentials.sessionToken) return;
    this.db.deleteSession(credentials.sessionToken);
    for (const [id, entry] of this.challenges) if (entry.sessionToken === credentials.sessionToken) this.challenges.delete(id);
  }
  private revokeSessions(): void {
    this.db.revokeSessions();
    this.generation++;
    this.challenges.clear();
  }
  logoutAll(credentials: AuthCredentials, authorization: string): void {
    this.takeAuthorization(credentials, authorization, "revoke-sessions");
    this.revokeSessions();
  }
  listPasskeys(credentials: AuthCredentials) {
    this.requireSession(credentials);
    return this.db.listCredentials().map(({ credentialId, label, createdAt, lastUsedAt }) => ({ credentialId, label: label ?? null, createdAt, lastUsedAt: lastUsedAt ?? null }));
  }
  removePasskey(credentials: AuthCredentials, authorization: string, credentialId: string): void {
    const grant = this.takeAuthorization(credentials, authorization, "remove-passkey");
    if (grant.credentialId === credentialId) throw new ApplicationError("forbidden", "Use a different passkey to authorize removing this one");
    this.db.transaction(() => {
      if (!this.db.deleteCredential(credentialId)) throw new ApplicationError("not_found", "Passkey not found");
      this.revokeSessions();
    });
  }

  private putChallenge(entry: ChallengeEntry): string {
    const now = Date.now();
    for (const [id, value] of this.challenges) if (value.expiresAt <= now) this.challenges.delete(id);
    while (this.challenges.size >= MAX_CHALLENGES) this.challenges.delete(this.challenges.keys().next().value!);
    const id = this.passkeys.token(18);
    this.challenges.set(id, entry);
    return id;
  }
  private takeChallenge(credentials: AuthCredentials, kind: ChallengeEntry["kind"]): ChallengeEntry {
    const id = credentials.challengeId, entry = id ? this.challenges.get(id) : undefined;
    if (id) this.challenges.delete(id);
    if (!entry || entry.kind !== kind || entry.expiresAt <= Date.now()) throw new ApplicationError("bad_request", "challenge expired — restart the passkey flow");
    return entry;
  }
  private challengeToken(id: string): IssuedToken { return { value: id, maxAge: CHALLENGE_TTL_MS / 1000 }; }
  private takeAuthorization(credentials: AuthCredentials, authorization: string, action: AuthAction): ChallengeEntry {
    const token = this.requireSession(credentials);
    const grant = this.takeChallenge({ challengeId: authorization }, "grant");
    if (grant.sessionToken !== token || grant.action !== action) throw new ApplicationError("forbidden", "Verify your passkey again for this action");
    return grant;
  }
  async beginReauthentication(credentials: AuthCredentials, action: AuthAction) {
    const sessionToken = this.requireSession(credentials);
    const options = await this.passkeys.authenticationOptions(this.settings);
    this.requireSession(credentials);
    const id = this.putChallenge({ challenge: options.challenge, expiresAt: Date.now() + CHALLENGE_TTL_MS, kind: "reauth", sessionToken, action });
    return { options, challenge: this.challengeToken(id) };
  }
  async finishReauthentication(credentials: AuthCredentials, response: AuthenticationResponse) {
    const sessionToken = this.requireSession(credentials), entry = this.takeChallenge(credentials, "reauth");
    if (entry.sessionToken !== sessionToken) throw new ApplicationError("forbidden", "Passkey verification belongs to another session");
    const credential = await this.verifyAssertion(response, entry.challenge);
    this.requireSession(credentials);
    const authorization = this.putChallenge({ ...entry, kind: "grant", credentialId: credential.credentialId, expiresAt: Date.now() + CHALLENGE_TTL_MS });
    return { authorization };
  }

  /** A host grant bootstraps enrollment; an existing session needs a fresh action grant. */
  async beginRegistration(credentials: AuthCredentials, enrollToken?: string, authorization?: string): Promise<{ options: RegistrationOptions; challenge: IssuedToken }> {
    let sessionToken: string | undefined;
    if (enrollToken) {
      const grant = this.db.getEnrollToken(enrollToken, Date.now());
      if (!grant) throw new ApplicationError("forbidden", "Enrollment link is invalid or expired");
      sessionToken = grant.sessionToken;
      if (sessionToken && !this.sessionValid(sessionToken)) throw new ApplicationError("forbidden", "Enrollment link has been revoked");
    } else {
      this.takeAuthorization(credentials, authorization ?? "", "enroll");
      sessionToken = credentials.sessionToken;
    }
    const options = await this.passkeys.registrationOptions(this.settings, this.db.listCredentials());
    if (sessionToken && !this.sessionValid(sessionToken)) throw new ApplicationError("forbidden", "Enrollment authorization has been revoked");
    const id = this.putChallenge({ challenge: options.challenge, expiresAt: Date.now() + CHALLENGE_TTL_MS, kind: "reg", enrollToken, sessionToken });
    return { options, challenge: this.challengeToken(id) };
  }
  async finishRegistration(credentials: AuthCredentials, response: RegistrationResponse, label?: string): Promise<{ session: IssuedToken }> {
    const entry = this.takeChallenge(credentials, "reg"), generation = this.generation;
    const authorized = () => {
      if (generation !== this.generation || (entry.sessionToken && (!this.sessionValid(entry.sessionToken) || (!entry.enrollToken && credentials.sessionToken !== entry.sessionToken)))) {
        throw new ApplicationError("forbidden", "Enrollment authorization has been revoked");
      }
    };
    authorized();
    const credential = await this.passkeys.verifyRegistration(this.settings, response, entry.challenge);
    if (!credential) throw new ApplicationError("bad_request", "passkey registration could not be verified");
    const session = this.db.transaction(() => {
      authorized();
      if (entry.enrollToken && !this.db.consumeEnrollToken(entry.enrollToken, Date.now())) throw new ApplicationError("bad_request", "enroll token already used or expired");
      const now = Date.now();
      this.db.insertCredential({ ...credential, label: label?.slice(0, 64) || null, createdAt: now, lastUsedAt: now });
      if (credentials.sessionToken) this.logout(credentials);
      return this.issueSession(label);
    });
    return { session };
  }
  async beginAuthentication(): Promise<{ options: AuthenticationOptions; challenge: IssuedToken }> {
    const options = await this.passkeys.authenticationOptions(this.settings);
    const id = this.putChallenge({ challenge: options.challenge, expiresAt: Date.now() + CHALLENGE_TTL_MS, kind: "auth" });
    return { options, challenge: this.challengeToken(id) };
  }
  private async verifyAssertion(response: AuthenticationResponse, challenge: string) {
    const cred = this.db.getCredential(response.id), generation = this.generation;
    if (!cred) throw new ApplicationError("bad_request", "unknown passkey");
    const counter = await this.passkeys.verifyAuthentication(this.settings, response, challenge, cred);
    if (counter === undefined) throw new ApplicationError("unauthorized", "passkey assertion failed");
    this.db.transaction(() => {
      const current = this.db.getCredential(response.id);
      if (generation !== this.generation || !current || current.counter !== cred.counter) throw new ApplicationError("unauthorized", "Passkey changed — sign in again");
      this.db.bumpCredentialCounter(cred.credentialId, counter, Date.now());
    });
    return cred;
  }
  async finishAuthentication(credentials: AuthCredentials, response: AuthenticationResponse): Promise<{ session: IssuedToken }> {
    const entry = this.takeChallenge(credentials, "auth"), generation = this.generation;
    const cred = await this.verifyAssertion(response, entry.challenge);
    if (generation !== this.generation) throw new ApplicationError("unauthorized", "Sign in again to continue");
    this.logout(credentials);
    return { session: this.issueSession(cred.label ?? undefined) };
  }
  /** Host-only recovery: no browser session can call this unguarded capability. */
  mintEnrollToken(): { token: string; expiresAt: number } { return this.createEnrollToken(); }
  private createEnrollToken(sessionToken?: string) {
    const token = this.passkeys.token(24), expiresAt = Date.now() + 15 * 60 * 1000;
    this.db.createEnrollToken(token, expiresAt, sessionToken);
    return { token, expiresAt };
  }
  authorizeEnrollment(credentials: AuthCredentials, authorization: string) {
    this.takeAuthorization(credentials, authorization, "enroll");
    return this.createEnrollToken(credentials.sessionToken);
  }
}
