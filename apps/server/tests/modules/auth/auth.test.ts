import assert from "node:assert/strict";
import test from "node:test";
import { AuthService } from "../../../src/modules/auth/application/use-cases/auth-service.js";
import type { AuthRepository } from "../../../src/modules/auth/application/ports/outbound/auth-repository.js";
import type { Passkeys } from "../../../src/modules/auth/application/ports/outbound/passkeys.js";
import type { StoredCredential } from "../../../src/modules/auth/domain/credential.js";

function fixture() {
  const credentials = new Map<string, StoredCredential>();
  const sessions = new Map<string, { token: string; createdAt: number; expiresAt: number }>();
  const enrollments = new Map<string, { expiresAt: number; sessionToken?: string }>();
  let next = 0, verified = true;
  const repository: AuthRepository = {
    transaction(work) { const before = [new Map(credentials), new Map(sessions), new Map(enrollments)] as const;
      try { return work(); } catch (error) { credentials.clear(); sessions.clear(); enrollments.clear(); for (const [k,v] of before[0]) credentials.set(k,v); for (const [k,v] of before[1]) sessions.set(k,v); for (const [k,v] of before[2]) enrollments.set(k,v); throw error; } },
    countCredentials: () => credentials.size, listCredentials: () => [...credentials.values()], getCredential: id => { const credential = credentials.get(id); return credential && { ...credential }; },
    insertCredential: credential => { credentials.set(credential.credentialId, credential); },
    bumpCredentialCounter: (id, counter, lastUsedAt) => { Object.assign(credentials.get(id)!, { counter, lastUsedAt }); },
    getSession: id => sessions.get(id), deleteSession: id => { sessions.delete(id); },
    revokeSessions: () => { sessions.clear(); enrollments.clear(); },
    deleteCredential: id => credentials.delete(id),
    createSession: (token, createdAt, expiresAt) => { sessions.set(token, { token, createdAt, expiresAt }); },
    getEnrollToken: (token, now) => { const grant = enrollments.get(token); return grant && grant.expiresAt > now ? { sessionToken: grant.sessionToken } : undefined; },
    consumeEnrollToken: (token, now) => (enrollments.get(token)?.expiresAt ?? 0) > now && enrollments.delete(token),
    createEnrollToken: (token, expiresAt, sessionToken) => { enrollments.set(token, { expiresAt, sessionToken }); },
  };
  const passkeys: Passkeys = {
    token: () => `token-${++next}`,
    registrationOptions: async () => ({ challenge: "registration", rp: { name: "Fixture" }, user: { id: "user", name: "Fixture", displayName: "Fixture" }, pubKeyCredParams: [] }),
    authenticationOptions: async () => ({ challenge: "authentication" }),
    verifyRegistration: async () => verified ? { credentialId: "credential", publicKey: "key", counter: 0 } : undefined,
    verifyAuthentication: async () => verified ? 1 : undefined,
  };
  const service = new AuthService(repository, { authEnabled: true, authOrigin: "https://example.com", rpId: "example.com", rpName: "Fixture", sessionTtlMs: 60_000 }, passkeys);
  return { service, repository, passkeys, credentials, sessions, enrollments, rejectVerification() { verified = false; } };
}
const response = { id: "credential", rawId: "credential", type: "public-key" as const, clientExtensionResults: {}, response: { clientDataJSON: "data", attestationObject: "data" } };

test("registration consumes a host token only after verification and challenges are single-use", async () => {
  const f = fixture();
  const token = f.service.mintEnrollToken();
  const first = await f.service.beginRegistration({}, token.token);
  const second = await f.service.beginRegistration({}, token.token);
  const result = await f.service.finishRegistration({ challengeId: first.challenge.value }, response);
  assert.equal(f.service.sessionValid(result.session.value), true);
  assert.equal(f.credentials.size, 1);
  assert.equal(f.enrollments.size, 0);
  await assert.rejects(f.service.finishRegistration({ challengeId: second.challenge.value }, response), /already used/);
  assert.equal(f.sessions.size, 1);
  await assert.rejects(f.service.finishRegistration({ challengeId: first.challenge.value }, response), /challenge expired/);
});

test("failed verification retains enrollment and expired sessions cannot authenticate", async () => {
  const f = fixture(), token = f.service.mintEnrollToken();
  const challenge = await f.service.beginRegistration({}, token.token);
  f.rejectVerification();
  await assert.rejects(f.service.finishRegistration({ challengeId: challenge.challenge.value }, response), /could not be verified/);
  assert.equal(f.enrollments.has(token.token), true);
  f.repository.createSession("expired", 0, 1);
  assert.equal(f.service.sessionValid("expired"), false);
  assert.equal(f.service.verifySession("expired"), false);
  assert.equal(f.sessions.has("expired"), false);
});

async function owner() {
  const f = fixture(), grant = f.service.mintEnrollToken();
  const start = await f.service.beginRegistration({}, grant.token);
  const { session } = await f.service.finishRegistration({ challengeId: start.challenge.value }, response);
  return { ...f, sessionToken: session.value };
}
const assertion = { ...response, response: { clientDataJSON: "data", authenticatorData: "data", signature: "data" } };
async function authorize(f: Awaited<ReturnType<typeof owner>>, action: import("@palmagent/shared").AuthAction) {
  const start = await f.service.beginReauthentication(f, action);
  return (await f.service.finishReauthentication({ ...f, challengeId: start.challenge.value }, assertion)).authorization;
}

test("a session alone cannot enroll, and action grants are single-use and purpose-bound", async () => {
  const f = await owner();
  await assert.rejects(f.service.beginRegistration(f), /challenge expired/);
  assert.throws(() => f.service.authorizeEnrollment(f, ""), /challenge expired/);
  const wrong = await authorize(f, "revoke-sessions");
  assert.throws(() => f.service.authorizeEnrollment(f, wrong), /again for this action/);
  const grant = await authorize(f, "enroll");
  const link = f.service.authorizeEnrollment(f, grant);
  assert.ok(link.token);
  assert.throws(() => f.service.authorizeEnrollment(f, grant), /challenge expired/);
});

test("grants cannot move between sessions and expire after five minutes", async t => {
  const f = await owner(), proof = await authorize(f, "enroll");
  f.repository.createSession("other", Date.now(), Date.now() + 60000);
  assert.throws(() => f.service.authorizeEnrollment({ sessionToken: "other" }, proof), /again for this action/);
  const next = await authorize(f, "enroll"), now = Date.now();
  t.mock.method(Date, "now", () => now + 300001);
  // Retain a valid owner session to isolate authorization expiry.
  f.sessions.set(f.sessionToken, { token: f.sessionToken, createdAt: Date.now(), expiresAt: Date.now() + 60000 });
  assert.throws(() => f.service.authorizeEnrollment(f, next), /challenge expired/);
});

test("logout revokes pending registration and links issued by that session", async () => {
  const f = await owner();
  const link = f.service.authorizeEnrollment(f, await authorize(f, "enroll"));
  const start = await f.service.beginRegistration({}, link.token);
  f.service.logout(f);
  await assert.rejects(f.service.beginRegistration({}, link.token), /revoked/);
  await assert.rejects(f.service.finishRegistration({ challengeId: start.challenge.value }, response), /expired|revoked/);
  assert.equal(f.sessions.size, 0);
});

test("revocation during asynchronous registration verification cannot issue a session", async () => {
  const f = await owner();
  const start = await f.service.beginRegistration(f, undefined, await authorize(f, "enroll"));
  const verify = f.passkeys.verifyRegistration;
  f.passkeys.verifyRegistration = async (...args) => { f.service.logout(f); return verify(...args); };
  await assert.rejects(f.service.finishRegistration({ ...f, challengeId: start.challenge.value }, response), /revoked/);
  assert.equal(f.sessions.size, 0);
});

test("revocation during asynchronous reauthentication cannot issue an action grant", async () => {
  const f = await owner(), start = await f.service.beginReauthentication(f, "enroll");
  f.passkeys.verifyAuthentication = async () => { f.service.logout(f); return 2; };
  await assert.rejects(f.service.finishReauthentication({ ...f, challengeId: start.challenge.value }, assertion), /Sign in again/);
});

test("logout-all revokes every session, enrollment link and outstanding ceremony", async () => {
  const f = await owner(), hostGrant = f.service.mintEnrollToken();
  const pending = await f.service.beginAuthentication();
  f.repository.createSession("other", Date.now(), Date.now() + 60000);
  f.service.logoutAll(f, await authorize(f, "revoke-sessions"));
  assert.equal(f.sessions.size, 0);
  await assert.rejects(f.service.beginRegistration({}, hostGrant.token), /invalid or expired/);
  await assert.rejects(f.service.finishAuthentication({ challengeId: pending.challenge.value }, assertion), /challenge expired/);
});

test("passkey removal requires a different verified key and revokes every session", async () => {
  const f = await owner();
  const proof = await authorize(f, "remove-passkey");
  assert.throws(() => f.service.removePasskey(f, proof, "credential"), /different passkey/);
  f.credentials.set("lost", { ...f.credentials.get("credential")!, credentialId: "lost" });
  f.service.removePasskey(f, await authorize(f, "remove-passkey"), "lost");
  assert.equal(f.credentials.has("lost"), false);
  assert.equal(f.credentials.has("credential"), true);
  assert.equal(f.sessions.size, 0);
});

test("sessions have a fixed lifetime even when legacy storage has a sliding expiry", t => {
  const f = fixture(), now = Date.now();
  f.repository.createSession("legacy", now, now + 600000);
  t.mock.method(Date, "now", () => now + 30000);
  assert.equal(f.service.verifySession("legacy"), true);
  assert.equal(f.sessions.get("legacy")!.expiresAt, now + 600000);
  t.mock.method(Date, "now", () => now + 60000);
  assert.equal(f.service.sessionValid("legacy"), false);
  assert.equal(f.service.verifySession("legacy"), false);
});
