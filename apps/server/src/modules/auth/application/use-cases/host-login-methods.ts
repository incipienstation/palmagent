import type { HostLogin } from "../ports/inbound/host-login.js";
import type { AuthRepository } from "../ports/outbound/auth-repository.js";
import type { GitHubAppCredentials } from "../../domain/github.js";
import type { GitHubBindings } from "../ports/outbound/github-login.js";

/** Only composed for local host administration. No HTTP adapter receives these capabilities. */
export class HostLoginMethods implements HostLogin {
  constructor(private readonly db: AuthRepository, private readonly bindings: GitHubBindings,
    private readonly random: (bytes: number) => string) {}
  status() {
    const pending = this.bindings.read("pending");
    return { passkeys: this.db.countCredentials(), github: this.bindings.read("active")?.owner ?? null,
      pending: pending?.expiresAt && pending.expiresAt > Date.now() ? { verified: pending.owner, expiresAt: pending.expiresAt } : null };
  }
  prepare(app: GitHubAppCredentials) {
    const bindingKey = this.random(32);
    const expiresAt = Date.now() + 15 * 60_000;
    this.bindings.save("pending", { ...app, bindingKey, expiresAt, owner: null });
    return { bindingKey, expiresAt };
  }
  confirm(ownerId: string) {
    this.db.transaction(() => {
      const binding = this.bindings.read("pending");
      if (!binding?.owner || binding.owner.id !== ownerId || !binding.expiresAt || binding.expiresAt <= Date.now())
        throw new Error("Verify the account in the browser and confirm the displayed numeric ID before setup expires.");
      const old = this.bindings.read("active");
      if (old) this.db.revokeSessions("github");
      this.bindings.save("active", { ...binding, bindingKey: this.random(32), expiresAt: null });
      this.bindings.clear("pending");
    });
  }
  remove(method: "github" | "passkey") {
    this.db.transaction(() => {
      const status = this.status();
      if (method === "github" ? !status.github : !status.passkeys) return;
      if (method === "github" ? !status.passkeys : !status.github)
        throw new Error("Verify another login method before removing the last one.");
      if (method === "github") this.bindings.clear("active");
      else for (const key of this.db.listCredentials()) this.db.deleteCredential(key.credentialId);
      this.db.revokeSessions(method);
    });
  }
  revokeSessions() { this.db.revokeSessions(); }
}
