import { z } from "zod";
import trust from "./release-trust.json" with { type: "json" };
export const RELEASE_PUBLIC_KEYS: Readonly<Record<string, string>> = trust.keys;

// Wire contracts shared by packaging, release automation, and installed clients.
export const DistributionSchema = z.enum(["npm", "standalone"]);
export type Distribution = z.infer<typeof DistributionSchema>;
export const StandaloneTargetSchema = z.enum(["linux-x64-glibc", "linux-arm64-glibc"]);
export type StandaloneTarget = z.infer<typeof StandaloneTargetSchema>;
export const ReleaseVersionSchema = z.string().regex(/^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/);
export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const HttpsUrl = z.string().url().regex(/^https:\/\/[^/?#@]+(?:[/?][^#]*)?$/,
  "Expected an HTTPS URL without credentials or a fragment");

export const StandaloneArtifactSchema = z.object({
  target: StandaloneTargetSchema,
  filename: z.string().regex(/^palmagent-[0-9A-Za-z.-]+-linux-(?:x64|arm64)-glibc\.tar\.gz$/),
  url: HttpsUrl,
  sha256: Sha256Schema,
  size: z.number().int().positive().max(512 * 1024 * 1024),
  unpackedSize: z.number().int().positive().max(2 * 1024 * 1024 * 1024),
  minGlibc: z.string().regex(/^\d+\.\d+$/),
  // Dynamic-library and symbol requirements come from the packaged ELF files.
  requiredLibraries: z.array(z.string().regex(/^[a-zA-Z0-9_.+-]+$/)).max(64),
}).strict();
export type StandaloneArtifact = z.infer<typeof StandaloneArtifactSchema>;

export const StandaloneManifestSchema = z.object({
  schemaVersion: z.literal(1),
  version: ReleaseVersionSchema,
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  nodeVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  nodeAbi: z.string().regex(/^\d+$/),
  pluginTag: z.string().regex(/^v\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/),
  runId: z.string().regex(/^[1-9]\d*$/),
  npm: z.object({ filename: z.string().regex(/^palmagent-\d+\.\d+\.\d+\.tgz$/), sha256: Sha256Schema }).strict().optional(),
  artifacts: z.array(StandaloneArtifactSchema).length(2),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.artifacts.map((artifact) => artifact.target)).size !== 2)
    ctx.addIssue({ code: "custom", message: "Both standalone targets are required" });
  if (value.pluginTag !== `v${value.version}`)
    ctx.addIssue({ code: "custom", message: "Plugin tag differs from product version" });
  if (value.npm && (value.version.includes("-") || value.npm.filename !== `palmagent-${value.version}.tgz`))
    ctx.addIssue({ code: "custom", message: "Only a matching Stable npm artifact is allowed" });
  for (const artifact of value.artifacts) {
    if (artifact.filename !== `palmagent-${value.version}-${artifact.target}.tar.gz`)
      ctx.addIssue({ code: "custom", message: "Artifact filename differs from release identity" });
  }
});
export type StandaloneManifest = z.infer<typeof StandaloneManifestSchema>;

export const ChannelIndexSchema = z.object({
  schemaVersion: z.literal(1), channel: z.enum(["stable", "preview"]),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  version: ReleaseVersionSchema,
  releaseManifestUrl: HttpsUrl,
  releaseManifestSha256: Sha256Schema,
}).strict().refine((value) => value.channel !== "stable" || !value.version.includes("-"),
  "Stable cannot select a prerelease");
export type ChannelIndex = z.infer<typeof ChannelIndexSchema>;

// Sign decoded payload bytes, never JSON reserialization. One envelope avoids
// readers observing a new payload with a cached detached signature.
export const SignedReleaseDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  payload: z.string().min(1).max(2 * 1024 * 1024),
  signatures: z.array(z.object({
    keyId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
    signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
  }).strict()).min(1).max(8),
}).strict();

export const StandaloneSelectionSchema = z.object({
  distribution: z.literal("standalone"),
  version: ReleaseVersionSchema,
  manifestUrl: HttpsUrl,
  manifestSha256: Sha256Schema,
  artifact: StandaloneArtifactSchema,
}).strict();
export type StandaloneSelection = z.infer<typeof StandaloneSelectionSchema>;

export const BundleIdentitySchema = z.object({
  schemaVersion: z.literal(1), distribution: z.literal("standalone"),
  version: ReleaseVersionSchema, sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  target: StandaloneTargetSchema,
  nodeVersion: z.string().regex(/^\d+\.\d+\.\d+$/), nodeAbi: z.string().regex(/^\d+$/),
  minGlibc: z.string().regex(/^\d+\.\d+$/),
}).strict();

/** Compare libc/symbol versions numerically, including 2.9 versus 2.35. */
export function versionAtLeast(actual: string, minimum: string): boolean {
  const a = actual.split(".").map(Number), b = minimum.split(".").map(Number);
  if ([...a, ...b].some((part) => !Number.isSafeInteger(part) || part < 0)) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}
