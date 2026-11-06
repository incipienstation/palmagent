import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import { DISTRIBUTION } from "@palmagent/shared";
import type { StandaloneManifest } from "@palmagent/shared/standalone";
import { selectStandaloneRelease, verifyStandaloneSelection, standaloneHost, type StandaloneCatalogIO } from "../../src/modules/installation/adapters/outbound/standalone-release.js";
import { planUpdate, resolveUpdatePlan } from "../../src/modules/installation/adapters/outbound/update-plan.js";
import { compatiblePlugin } from "../../src/modules/installation/domain/release-policy.js";

function fixture() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keys = { fixture: publicKey.export({ type:"spki", format:"pem" }).toString() };
  const encode = (value: unknown) => {
    const bytes = Buffer.from(JSON.stringify(value));
    return Buffer.from(JSON.stringify({ schemaVersion:1, payload:bytes.toString("base64"), signatures:[{keyId:"fixture", signature:sign(null, bytes, privateKey).toString("base64")}] }));
  };
  const version = "0.2.0-alpha.1", sourceCommit = "a".repeat(40);
  const manifest: StandaloneManifest = { schemaVersion:1, version, sourceCommit, nodeVersion:"24.21.0", nodeAbi:"137", runId:"42", pluginTag:`v${version}`,
    artifacts: (["linux-x64-glibc", "linux-arm64-glibc"] as const).map(target => ({ target, filename:`palmagent-${version}-${target}.tar.gz`,
      url:`${DISTRIBUTION.repositoryUrl}/releases/download/v${version}/palmagent-${version}-${target}.tar.gz`, sha256:"b".repeat(64), size:123, unpackedSize:456, minGlibc:"2.35", requiredLibraries:["libc.so.6"] })) };
  const url = `${DISTRIBUTION.repositoryUrl}/releases/download/v${version}/standalone.json`;
  const bytes = encode(manifest);
  const channel = { schemaVersion:1, channel:"preview", version, revision:1, releaseManifestUrl:url, releaseManifestSha256:createHash("sha256").update(bytes).digest("hex") };
  const files = new Map([[url, bytes], [`${DISTRIBUTION.releaseOrigin}/channels/preview.json`, encode(channel)]]);
  const reads: string[] = [];
  const io: StandaloneCatalogIO = { keys, host:{target:"linux-arm64-glibc", glibc:"2.35"}, read(url) { reads.push(url); assert(files.has(url)); return files.get(url)!; } };
  return { io, files, reads, manifest, channel, encode, url };
}

test("standalone discovery pins the signed manifest and platform without a registry", () => {
  const f = fixture();
  const selected = selectStandaloneRelease("preview", undefined, f.io);
  assert.equal(selected.artifact.target, "linux-arm64-glibc");
  assert.deepEqual(f.reads, [`${DISTRIBUTION.releaseOrigin}/channels/preview.json`, f.url]);
  assert.deepEqual(verifyStandaloneSelection(selected, f.io), f.manifest);
  // A moving channel has no bearing on an already-selected release.
  f.files.set(`${DISTRIBUTION.releaseOrigin}/channels/preview.json`, f.encode({ ...f.channel, version:"0.2.0-alpha.2" }));
  assert.deepEqual(verifyStandaloneSelection(selected, f.io), f.manifest);
  assert.throws(() => verifyStandaloneSelection({ ...selected, artifact:{ ...selected.artifact, sha256:"c".repeat(64) } }, f.io), /artifact/);
  f.files.set(f.url, f.encode({ ...f.manifest, sourceCommit:"d".repeat(40) }));
  assert.throws(() => verifyStandaloneSelection(selected, f.io), /changed/);
});

test("standalone rejects unsupported hosts, old libc, wrong origins and mismatched identities", () => {
  const f = fixture();
  assert.throws(() => standaloneHost("darwin", "arm64", "2.35"), /unsupported/);
  assert.throws(() => standaloneHost("linux", "ia32", "2.35"), /unsupported/);
  assert.throws(() => standaloneHost("linux", "x64", ""), /unsupported/);
  assert.throws(() => selectStandaloneRelease("preview", undefined, { ...f.io, host:{target:"linux-arm64-glibc", glibc:"2.9"} }), /glibc/);
  assert.throws(() => selectStandaloneRelease("stable", f.manifest.version, f.io), /Stable/);
  f.files.set(`${DISTRIBUTION.releaseOrigin}/channels/preview.json`, f.encode({ ...f.channel, releaseManifestUrl:"https://example.invalid/manifest" }));
  assert.throws(() => selectStandaloneRelease("preview", undefined, f.io), /identity/);
  assert.throws(() => selectStandaloneRelease("preview", "../release", f.io));
});

test("schema v2 distinguishes same-version migration and enforces the new plugin line", () => {
  const f = fixture(), selected = selectStandaloneRelease("preview", undefined, f.io);
  const plan = planUpdate(selected.version, selected.version, "preview", [], "npm", "standalone", selected);
  assert.equal(plan.schemaVersion, 2); assert.equal(plan.action, "migrate"); assert.equal(plan.packageAction, "update");
  assert.deepEqual(plan.selection, selected);
  const transition = planUpdate("0.1.0-alpha.236", selected.version, "preview", [{manifest:"/opt/plugin.json", version:"0.1.0-alpha.236"}], "npm", "standalone", selected);
  assert.equal(transition.automaticEligible, false);
  assert.equal(compatiblePlugin("0.1.0-alpha.236", "0.2.0-alpha.1"), false);
  assert.equal(compatiblePlugin("0.2.0-alpha.1", "0.1.0-alpha.236"), false);
  assert.equal(compatiblePlugin("0.2.0-alpha.1", "0.2.0-alpha.1"), true);
  assert.throws(() => resolveUpdatePlan("0.1.0-alpha.1", "preview", [], undefined, {distribution:"npm"}), /standalone/);
});
