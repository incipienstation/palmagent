import { authCommand } from "../modules/auth/adapters/inbound/host-cli.js";
import { SqliteAuth } from "../modules/auth/adapters/outbound/sqlite-auth.js";
import { SqliteGitHubBindings } from "../modules/auth/adapters/outbound/sqlite-github-bindings.js";
import { webauthn } from "../modules/auth/adapters/outbound/webauthn.js";
import { HostLoginMethods } from "../modules/auth/application/use-cases/host-login-methods.js";
import { loadConfig } from "../modules/installation/adapters/outbound/config.js";
import { openDatabase } from "../platform/sqlite/connection.js";

export function hostLoginCommand(args: string[]) {
  authCommand(args, (dataDir, run) => {
    const config = loadConfig({ dataDir, requireInstalled: true });
    const db = openDatabase(config.dbPath);
    try { run(new HostLoginMethods(new SqliteAuth(db), new SqliteGitHubBindings(db), webauthn.token), config.authOrigin); }
    finally { db.close(); }
  });
}
