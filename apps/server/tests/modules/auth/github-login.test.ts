import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { migrateSchema } from "../../../src/platform/sqlite/migrations/schema.js";
import { SqliteAuth } from "../../../src/modules/auth/adapters/outbound/sqlite-auth.js";
import { SqliteGitHubBindings } from "../../../src/modules/auth/adapters/outbound/sqlite-github-bindings.js";
import { gitHubOAuth } from "../../../src/modules/auth/adapters/outbound/github-oauth.js";
import { webauthn } from "../../../src/modules/auth/adapters/outbound/webauthn.js";
import { AuthService } from "../../../src/modules/auth/application/use-cases/auth-service.js";
import { HostLoginMethods } from "../../../src/modules/auth/application/use-cases/host-login-methods.js";
import { GitHubLogin } from "../../../src/modules/auth/application/use-cases/github-login.js";

test("verified setup, host activation, browser-bound login and selective revocation share one owner", async t => {
  const sqlite = new Database(":memory:");
  t.after(() => sqlite.close());
  migrateSchema(sqlite);
  const db = new SqliteAuth(sqlite), bindings = new SqliteGitHubBindings(sqlite);
  const host = new HostLoginMethods(db, bindings, webauthn.token);
  const origin = "https://example.com";
  let account = { id: 42, login: "owner" };
  let challenge = "";
  let duringIdentity = () => {};
  const oauth = gitHubOAuth(async (url, options) => {
    if (url === "https://github.com/login/oauth/access_token") {
      const body = options!.body as URLSearchParams;
      assert.equal(body.get("redirect_uri"), origin + "/api/auth/github/callback");
      assert.equal(createHash("sha256").update(body.get("code_verifier")!).digest("base64url"), challenge);
      return Response.json({ access_token: "fixture" });
    }
    assert.equal(url, "https://api.github.com/user");
    assert.equal(new Headers(options?.headers).get("authorization"), "Bearer fixture");
    duringIdentity();
    return Response.json(account);
  });
  const github = new GitHubLogin(db, bindings, oauth, webauthn.token, origin);
  const auth = new AuthService(db, { authEnabled: true, authOrigin: origin, rpId: "example.com", rpName: "test",
    sessionTtlMs: 60_000 }, webauthn, github);
  const begin = (setupKey?: string) => {
    const start = auth.beginGitHub(setupKey, "#/spaces");
    const query = new URL(start.url).searchParams;
    assert.equal(query.get("scope"), "");
    challenge = query.get("code_challenge")!;
    return [start.cookie.value, query.get("state")!, "code"] as const;
  };
  const app = { clientId: "client", clientSecret: "fixture" };
  const setup = host.prepare(app);
  assert.throws(() => begin(), /unavailable/);
  assert.throws(() => begin("invalid"), /unavailable/);
  const proof = begin(setup.bindingKey);
  assert.deepEqual(await auth.finishGitHub({}, ...proof), { location: "/#/github-verified" });
  assert.throws(() => begin(setup.bindingKey), /unavailable/);
  assert.throws(() => host.confirm("7"), /confirm/);
  assert.equal(auth.status({}).githubEnabled, false);
  host.confirm("42");
  assert.throws(() => host.remove("github"), /last one/);
  const login = begin();
  await assert.rejects(auth.finishGitHub({}, "other-browser", login[1], "code"), /Restart/);
  await assert.rejects(auth.finishGitHub({}, login[0], "wrong-state", "code"), /Restart/);
  const result = await auth.finishGitHub({}, ...login);
  assert.equal(result.location, "/#/spaces");
  assert.ok(auth.sessionValid(result.session!.value));
  await assert.rejects(auth.finishGitHub({}, ...login), /Restart/);
  account = { id: 7, login: "owner" };
  await assert.rejects(auth.finishGitHub({}, ...begin()), /not linked/);
  account = { id: 42, login: "renamed" };
  assert.ok((await auth.finishGitHub({}, ...begin())).session);
  db.insertCredential({ credentialId: "key", publicKey: "fixture", counter: 0, createdAt: 1 });
  db.createSession("passkey-session", Date.now(), Date.now() + 60_000);
  assert.equal(auth.status({}).credentialCount, 1);
  // Host changes committed during a provider round trip must win over the old callback.
  duringIdentity = () => host.remove("github");
  await assert.rejects(auth.finishGitHub({}, ...begin()), /changed/);
  assert.ok(auth.sessionValid("passkey-session"));
  assert.equal(auth.sessionValid(result.session!.value), false);
  assert.equal(auth.status({}).githubEnabled, false);
  assert.throws(() => host.remove("passkey"), /last one/);
});
