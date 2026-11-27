import { ApplicationError } from "../../../../kernel/errors.js";
import type { IssuedToken } from "../../domain/session.js";
import type { AuthRepository } from "../ports/outbound/auth-repository.js";
import type { GitHubBindings, GitHubOAuth } from "../ports/outbound/github-login.js";

const ttl = 5 * 60_000;
type Attempt = { state: string; verifier: string; bindingKey: string; setup: boolean;
  epoch: number; expiresAt: number; returnHash: string };

export const githubCallbackPath = "/api/auth/github/callback";

/** A browser cookie and the state returned by GitHub identify one short-lived request. */
export class GitHubLogin {
  private readonly attempts = new Map<string, Attempt>();
  constructor(private readonly repository: AuthRepository, private readonly bindings: GitHubBindings,
    private readonly oauth: GitHubOAuth, private readonly random: (bytes: number) => string,
    private readonly origin: string) {}

  get available(): boolean { return Boolean(this.bindings.read("active")?.owner); }

  begin(setupKey: string | undefined, returnHash: string) {
    const setup = setupKey !== undefined;
    const binding = this.bindings.read(setup ? "pending" : "active");
    const now = Date.now();
    const ready = setup
      ? binding && binding.bindingKey === setupKey && binding.expiresAt !== null && binding.expiresAt > now && !binding.owner
      : Boolean(binding?.owner);
    if (!binding || !ready) throw new ApplicationError("forbidden", "GitHub sign-in is unavailable for this request.");
    for (const [id, attempt] of this.attempts) if (attempt.expiresAt <= now) this.attempts.delete(id);
    if (this.attempts.size >= 2000) throw new ApplicationError("too_many_requests", "Too many pending sign-ins.");
    const cookie = this.random(32), state = this.random(32), verifier = this.random(32);
    this.attempts.set(cookie, { state, verifier, bindingKey: binding.bindingKey, setup,
      epoch: this.repository.authEpoch(), expiresAt: now + ttl, returnHash });
    return { cookie: { value: cookie, maxAge: ttl / 1000 },
      url: this.oauth.authorize(binding.clientId, this.origin + githubCallbackPath, state, verifier) };
  }

  async finish(cookie: string, state: string, code: string, issue: () => IssuedToken) {
    const attempt = this.attempts.get(cookie);
    if (!attempt || attempt.state !== state) throw new ApplicationError("forbidden", "Restart GitHub sign-in.");
    this.attempts.delete(cookie);
    const slot = attempt.setup ? "pending" : "active";
    const current = () => {
      const binding = this.bindings.read(slot);
      const now = Date.now();
      if (!binding || binding.bindingKey !== attempt.bindingKey || attempt.expiresAt <= now ||
          (binding.expiresAt !== null && binding.expiresAt <= now) || this.repository.authEpoch() !== attempt.epoch ||
          (attempt.setup && binding.owner))
        throw new ApplicationError("forbidden", "This GitHub request has expired or changed.");
      return binding;
    };
    const app = current();
    if (!code) throw new ApplicationError("forbidden", "GitHub sign-in was cancelled.");
    const identity = await this.oauth.identify(app, this.origin + githubCallbackPath, code, attempt.verifier);
    return this.repository.transaction(() => {
      const binding = current();
      if (attempt.setup) {
        this.bindings.save("pending", { ...binding, owner: identity });
        return { location: "/#/github-verified" };
      }
      if (identity.id !== binding.owner?.id) throw new ApplicationError("forbidden", "This account is not linked.");
      return { session: issue(), location: "/" + attempt.returnHash };
    });
  }
}
