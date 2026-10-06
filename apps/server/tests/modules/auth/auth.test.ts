import assert from "node:assert/strict";
import test from "node:test";
import { AuthService } from "../../../src/modules/auth/application/use-cases/auth-service.js";
import type { AuthRepository } from "../../../src/modules/auth/application/ports/outbound/auth-repository.js";
import type { Passkeys } from "../../../src/modules/auth/application/ports/outbound/passkeys.js";
import type { StoredCredential } from "../../../src/modules/auth/domain/credential.js";

function fixture() {
  const credentials = new Map<string, StoredCredential>();
  const sessions = new Map<string, { token: string; createdAt: number; expiresAt: number }>();
  const enrollments = new Map<string, number>();
  let next = 0, verified = true;
  const repository: AuthRepository = {
    transaction(work) { const before = [new Map(credentials), new Map(sessions), new Map(enrollments)] as const;
      try { return work(); } catch (error) { credentials.clear(); sessions.clear(); enrollments.clear(); for (const [k,v] of before[0]) credentials.set(k,v); for (const [k,v] of before[1]) sessions.set(k,v); for (const [k,v] of before[2]) enrollments.set(k,v); throw error; } },
    countCredentials: () => credentials.size, listCredentials: () => [...credentials.values()], getCredential: id => credentials.get(id),
    insertCredential: credential => { credentials.set(credential.credentialId, credential); },
    bumpCredentialCounter: (id, counter, lastUsedAt) => { Object.assign(credentials.get(id)!, { counter, lastUsedAt }); },
    getSession: id => sessions.get(id), deleteSession: id => { sessions.delete(id); },
    refreshSession: (id, expiresAt) => { sessions.get(id)!.expiresAt = expiresAt; },
    createSession: (token, createdAt, expiresAt) => { sessions.set(token, { token, createdAt, expiresAt }); },
    isEnrollTokenValid: (token, now) => (enrollments.get(token) ?? 0) > now,
    consumeEnrollToken: (token, now) => (enrollments.get(token) ?? 0) > now && enrollments.delete(token),
    createEnrollToken: (token, expiresAt) => { enrollments.set(token, expiresAt); },
  };
  const passkeys: Passkeys = {
    token: () => `token-${++next}`,
    registrationOptions: async () => ({ challenge: "registration", rp: { name: "Fixture" }, user: { id: "user", name: "Fixture", displayName: "Fixture" }, pubKeyCredParams: [] }),
    authenticationOptions: async () => ({ challenge: "authentication" }),
    verifyRegistration: async () => verified ? { credentialId: "credential", publicKey: "key", counter: 0 } : undefined,
    verifyAuthentication: async () => verified ? 1 : undefined,
  };
  const service = new AuthService(repository, { authEnabled: true, authOrigin: "https://example.com", rpId: "example.com", rpName: "Fixture", sessionTtlMs: 60_000 }, passkeys);
  return { service, repository, credentials, sessions, enrollments, rejectVerification() { verified = false; } };
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
