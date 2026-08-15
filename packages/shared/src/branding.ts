// Central, single-source branding. User-facing package, CLI, unit, state-dir,
// and WebAuthn RP names in the distributable path must come from here. Keep these
// strings out of generated units, installer code, and package assembly logic so a
// rename stays a one-edit change.
//
// NB: the root package.json name is a private workspace literal. A publishable
// CLI manifest must derive its package name from BRANDING.packageName.

export const BRANDING = {
  /**
   * Operator-facing product name — CLI/installer output, generated unit/nginx/config
   * comments, server logs, and the distributable package metadata. Stays "Palmagent"
   * (matches the lowercase package/CLI/unit lineage when title-cased).
   */
  productName: "Palmagent",
  /**
   * App-facing display name — the web/PWA UI surface ONLY (tab title + manifest,
   * AppBar, auth screens, push titles) plus the WebAuthn RP name shown in the
   * browser's native passkey dialog. Intentionally diverges from productName in
   * casing so the in-app brand reads as "Palm + Agent". CLI keeps productName.
   */
  displayName: "PalmAgent",
  /** npm package name. Unscoped — `palmagent` is reserved on npm (single self-contained package). */
  packageName: "palmagent",
  /** Short CLI / bin name the operator types: `<cliName> install|doctor|…`. */
  cliName: "palmagent",
  /**
   * systemd unit base. The web/SSE server is `<unitBase>.service`; the long-lived
   * process host is `<unitBase>-runner.service`.
   */
  unitBase: "palmagent",
  /** Default sub-directory under ~/.local/state and the default data-dir name. */
  stateDirName: "palmagent",
} as const;

export type Branding = typeof BRANDING;
