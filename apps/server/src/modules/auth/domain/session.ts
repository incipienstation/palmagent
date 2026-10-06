export interface AuthStatus { authenticated: boolean; required: boolean; credentialCount: number }
export interface AuthCredentials { sessionToken?: string; challengeId?: string }
export interface IssuedToken { value: string; maxAge: number }
