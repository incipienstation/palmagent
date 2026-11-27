export type { AuthMe as AuthStatus } from "@palmagent/shared";
export interface AuthCredentials { sessionToken?: string; challengeId?: string }
export interface IssuedToken { value: string; maxAge: number }
