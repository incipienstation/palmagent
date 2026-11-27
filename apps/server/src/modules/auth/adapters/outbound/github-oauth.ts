import { createHash } from "node:crypto";
import { z } from "zod";
import type { GitHubOAuth } from "../../application/ports/outbound/github-login.js";
import { ApplicationError } from "../../../../kernel/errors.js";

const identity = z.object({ id: z.number().int().positive(), login: z.string().min(1).max(100) });
const token = z.object({ access_token: z.string().min(1) });

/** Only these GitHub endpoints ever receive the installation secret or access token. */
export function gitHubOAuth(request: typeof fetch = fetch): GitHubOAuth {
  return {
    authorize(clientId, callback, state, verifier) {
      const url = new URL("https://github.com/login/oauth/authorize");
      url.search = new URLSearchParams({
        client_id: clientId, redirect_uri: callback, state, scope: "", prompt: "select_account",
        code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      }).toString();
      return url.href;
    },
    async identify(app, callback, code, verifier) {
      const signal = AbortSignal.timeout(12_000);
      try {
        const exchange = await request("https://github.com/login/oauth/access_token", {
          method: "POST", redirect: "error", signal, headers: { Accept: "application/json" },
          body: new URLSearchParams({ client_id: app.clientId, client_secret: app.clientSecret,
            redirect_uri: callback, code, code_verifier: verifier }),
        });
        if (!exchange.ok) throw new Error();
        const { access_token } = token.parse(await exchange.json());
        const user = await request("https://api.github.com/user", { redirect: "error", signal,
          headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${access_token}` } });
        if (!user.ok) throw new Error();
        const { id, login } = identity.parse(await user.json());
        return { id: String(id), login };
      } catch {
        throw new ApplicationError("service_unavailable", "GitHub could not verify this sign-in. Try again.");
      }
    },
  };
}
