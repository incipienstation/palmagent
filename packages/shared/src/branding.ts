// Central, single-source branding. User-facing package, CLI, unit, state-dir,
// and WebAuthn RP names in the distributable path must come from here. Keep these
// strings out of generated units, installer code, and package assembly logic so a
// rename stays a one-edit change.
//
// NB: the root package.json name is a private workspace literal. A publishable
// CLI manifest must derive its package name from BRANDING.packageName.

// JSON lets build tooling consume the same names without a TypeScript loader.
import branding from "./branding.json" with { type: "json" };
export const BRANDING = branding;
export type Branding = typeof BRANDING;
