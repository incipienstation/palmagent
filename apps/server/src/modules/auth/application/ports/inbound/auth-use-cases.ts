import type { AuthStatus, AuthCredentials, IssuedToken } from "../../../domain/session.js";
import type { RegistrationResponse, AuthenticationResponse, RegistrationOptions, AuthenticationOptions } from "../outbound/passkeys.js";

/** Operations accepted by the auth module. */
export interface AuthUseCases {
  beginReauthentication(credentials: AuthCredentials, action: import("@palmagent/shared").AuthAction): Promise<{ options: AuthenticationOptions; challenge: IssuedToken }>;
  finishReauthentication(credentials: AuthCredentials, response: AuthenticationResponse): Promise<{ authorization: string }>;
  authorizeEnrollment(credentials: AuthCredentials, authorization: string): { token: string; expiresAt: number };
  logoutAll(credentials: AuthCredentials, authorization: string): void;
  listPasskeys(credentials: AuthCredentials): Array<{ credentialId: string; label: string | null; createdAt: number; lastUsedAt: number | null }>;
  removePasskey(credentials: AuthCredentials, authorization: string, credentialId: string): void;
  readonly enabled: boolean;
  status(credentials: AuthCredentials): AuthStatus;
  readonly origin: string;
  sessionValid(token: string | undefined): boolean;
  verifySession(token: string | undefined): boolean;
  logout(credentials: AuthCredentials): void;
  beginRegistration(credentials: AuthCredentials, enrollToken?: string, authorization?: string): Promise<{ options: RegistrationOptions; challenge: IssuedToken; }>;
  finishRegistration(credentials: AuthCredentials, response: RegistrationResponse, label?: string): Promise<{ session: IssuedToken; }>;
  beginAuthentication(): Promise<{ options: AuthenticationOptions; challenge: IssuedToken; }>;
  finishAuthentication(credentials: AuthCredentials, response: AuthenticationResponse): Promise<{ session: IssuedToken; }>;
  mintEnrollToken(): { token: string; expiresAt: number; };
}
